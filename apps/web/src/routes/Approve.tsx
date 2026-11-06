import {
  decodeEvidence,
  encodeEvidence,
  runChecks,
  type CheckReport,
  type EvidenceFile,
  type VerifiedFacts,
} from '@recall/evidence';
import {
  CaptureSchema,
  arkivPublic,
  arkivWallet,
  isFreeBatch,
  listByUrl,
  swarmRootOf,
  writeCapture,
  writeConfirmation,
} from '@recall/net';
import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { custom, type Account, type Address, type Hex } from 'viem';
import { ExhibitCard } from '../components/ExhibitCard';
import { downloadEvidence } from '../download';
import { errorText, shortErrorText } from '../errors';
import { ExtError, ext } from '../ext';
import { formatDay, formatUtc } from '../format';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { StatusBadge, type Status } from '../ui/StatusBadge';
import { Steps, type StepState } from '../ui/Steps';
import { TechnicalDetails, WhyWitness } from '../verify/CheckPanel';
import { GATEWAY_COPY_MS, compareGatewayCopy, type GatewayCopy } from '../verify/gatewayCopy';
import { verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { verdictOf } from '../verify/verify';
import { trustedWitnesses, witnessLabel } from '../witness';
import {
  CHAIN_NAMES,
  connectWallet,
  ensureChain,
  getProvider,
  isUserRejection,
  useWallet,
  WalletError,
  type ChainId,
} from '../wallet';
import './approve.css';

/**
 * #/approve/:captureId — publishes the Arkiv record of a capture the extension holds as
 * pending. The page never takes the extension's word for anything: it runs checks A to C on
 * the evidence itself (A and B must pass, C must not fail), checks that the uploaded evidence
 * reference really is these bytes (or, for a confirmation, that the earlier capture verifies
 * and has the same bytes), and builds the record only from the verified facts. MetaMask then
 * writes it (`permissionlessExtension`, 30 days), and the extension is told, which removes
 * its pending copy (so the record is never read back from the extension after that).
 */

/** What `recall.getPending` answers (JSON-safe). */
type PendingRecord = {
  captureId: string;
  kind: 'capture' | 'confirmation';
  evidence: EvidenceFile;
  evidenceRef?: Hex;
  batchId?: Hex;
  captureKey?: Hex;
  bodySha256: Hex;
  createdAt: number;
};

/** Evidence inline in an Arkiv record must stay within this size (spec 3.2). */
const INLINE_EVIDENCE_MAX = 128 * 1024;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const RECORD_DAYS = 30;

type Ready = {
  pending: PendingRecord;
  bytes: Uint8Array;
  report: CheckReport;
  facts: VerifiedFacts;
  /** Confirmations: the verified earlier capture. */
  earlier?: { key: Hex; signedAt: bigint };
  /** Free-mode captures: whether the download gateways hold these very bytes under the reference. */
  gatewayCopy?: GatewayCopy;
};

type Load =
  | { phase: 'loading'; step: string }
  | { phase: 'none' }
  | { phase: 'unreachable'; message: string }
  | { phase: 'offline'; message: string }
  | { phase: 'refused'; reason: string; report?: CheckReport; kind?: 'capture' | 'confirmation' }
  | ({ phase: 'ready' } & Ready);

type Publish =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'switching' }
  | { state: 'looking' }
  | { state: 'signing' }
  | { state: 'publishing' }
  | { state: 'rejected' }
  | { state: 'failed'; reason: string; technical?: string }
  | { state: 'published'; entityKey: Hex; until: Date | null; markError?: string };

const reasonOf = (e: unknown) => shortErrorText(e).split('\n')[0];
const sentence = (s: string) => {
  const t = s.trim().replace(/\.+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** The extension to ask: the `?ext=` the extension put in the link, else the one in Settings. */
function extensionIdFromLink(): string | undefined {
  const q = window.location.hash.split('?')[1];
  const id = q ? new URLSearchParams(q).get('ext') : null;
  return id && EXTENSION_ID.test(id) ? id : undefined;
}

/** Loads the pending capture and checks everything the record will say. */
async function loadPending(captureId: string, extensionId: string | undefined, onStep: (s: string) => void): Promise<Load> {
  let pending: PendingRecord;
  try {
    pending = await ext.send<PendingRecord>({ type: 'recall.getPending', captureId }, extensionId ? { extensionId } : {});
  } catch (e) {
    if (e instanceof ExtError && e.kind === 'rejected') return { phase: 'none' };
    return { phase: 'unreachable', message: errorText(e) };
  }
  if (!pending || pending.captureId !== captureId || (pending.kind !== 'capture' && pending.kind !== 'confirmation')) {
    return { phase: 'refused', reason: 'The extension sent something that is not a pending capture.' };
  }

  onStep('Checking the evidence in this browser…');
  let bytes: Uint8Array;
  let report: CheckReport;
  try {
    // The canonical bytes: the ones that were uploaded (or go inline in a confirmation).
    bytes = encodeEvidence(decodeEvidence(encodeEvidence(pending.evidence)));
    report = await runChecks(decodeEvidence(bytes), { pinnedWitnesses: trustedWitnesses().map((w) => w.address) });
  } catch (e) {
    return { phase: 'refused', kind: pending.kind, reason: `The evidence file could not be read: ${reasonOf(e)}.` };
  }
  const facts = report.facts;
  if (report.A.status !== 'pass' || report.B.status !== 'pass' || report.C.status === 'fail' || !facts) {
    return { phase: 'refused', kind: pending.kind, reason: 'The checks in this browser did not pass, so this capture cannot be published.', report };
  }
  if (pending.bodySha256?.toLowerCase() !== facts.bodySha256.toLowerCase()) {
    return { phase: 'refused', kind: pending.kind, reason: "The extension's details of this capture don't match its evidence.", report };
  }

  const cfg = getNetConfig();
  if (pending.kind === 'capture') {
    if (!pending.evidenceRef || !KEY.test(pending.evidenceRef) || !pending.batchId || !KEY.test(pending.batchId)) {
      return { phase: 'refused', kind: pending.kind, reason: 'The capture has no valid Swarm reference or storage batch.', report };
    }
    onStep('Checking the uploaded evidence reference…');
    // The Swarm reference is a hash of the bytes, so it is checked here without a download.
    // A free-mode capture (all-zero batch id: the evidence went to a gateway's own storage) is
    // the one case where that does not hold: for files over 4 KB the gateway's reference differs
    // from the locally computed root (R13). Its evidence is bound by checks A to C above, and by
    // the record being built from the facts of this very evidence. Every other batch id keeps the root check.
    if (!isFreeBatch(pending.batchId) && (await swarmRootOf(bytes)) !== pending.evidenceRef.slice(2).toLowerCase()) {
      return { phase: 'refused', kind: pending.kind, reason: "The uploaded evidence reference doesn't match this capture's evidence.", report };
    }
    if (!isFreeBatch(pending.batchId)) return { phase: 'ready', pending, bytes, report, facts };

    // Free mode has no local proof that the reference names these bytes, so ask the gateways:
    // other bytes under it block the publish; no answer is only a warning.
    onStep("Checking the gateway's copy of the evidence…");
    let copy: Uint8Array | null = null;
    try {
      copy = (await downloadEvidence(cfg, { evidenceRef: pending.evidenceRef, batchId: pending.batchId }, { signal: AbortSignal.timeout(GATEWAY_COPY_MS) })).bytes;
    } catch {
      copy = null;
    }
    const gatewayCopy = compareGatewayCopy(copy, bytes);
    if (gatewayCopy === 'different') {
      return {
        phase: 'refused',
        kind: pending.kind,
        reason: "The file the gateway holds under this Swarm reference is not this capture's evidence, so a record pointing at it would be wrong.",
        report,
      };
    }
    return { phase: 'ready', pending, bytes, report, facts, gatewayCopy };
  }

  // A confirmation: the evidence goes inline, and the capture it confirms must verify too.
  if (!pending.captureKey || !KEY.test(pending.captureKey)) {
    return { phase: 'refused', kind: pending.kind, reason: 'The confirmation does not name a valid earlier capture.', report };
  }
  if (bytes.length > INLINE_EVIDENCE_MAX) {
    return { phase: 'refused', kind: pending.kind, reason: 'The evidence is too large to publish inline as a confirmation.', report };
  }
  onStep('Checking the earlier capture…');
  let claims: { urlHash: Hex; bodySha256: Hex; witness: Address; signedAt: bigint; evidenceRef: Hex; batchId: Hex };
  try {
    const e = await arkivPublic(cfg).getEntity(pending.captureKey, CaptureSchema);
    claims = {
      urlHash: e.urlHash.value,
      bodySha256: e.bodySha256.value,
      witness: e.witness.value as Address,
      signedAt: e.signedAt.value,
      evidenceRef: e.evidenceRef.value,
      batchId: e.batchId.value,
    };
  } catch (e) {
    if (/not found|NoEntityFound|does not exist/i.test(String(e))) {
      return { phase: 'refused', kind: pending.kind, reason: 'The earlier capture this confirms is not on Arkiv.', report };
    }
    return { phase: 'offline', message: reasonOf(e) };
  }
  let earlierBytes: Uint8Array;
  try {
    earlierBytes = (await downloadEvidence(cfg, claims)).bytes;
  } catch (e) {
    return { phase: 'offline', message: reasonOf(e) };
  }
  const { evidenceRef: _ref, batchId: _batch, ...recordClaims } = claims;
  const earlier = await verifyRecordEvidence(recordClaims, earlierBytes);
  // Checks that could not run (e.g. the signature code failed to load) are not a failure of
  // the earlier capture: that is "try again", not "can't be a confirmation".
  const verdict = verdictOf(earlier);
  if (verdict.kind === 'na' || verdict.kind === 'pending') {
    return { phase: 'offline', message: earlier.technical ?? earlier.A.detail };
  }
  const ef = earlier.facts;
  const ok =
    verdict.kind === 'pass' &&
    ef !== undefined &&
    ef.urlHash.toLowerCase() === facts.urlHash.toLowerCase() &&
    ef.bodySha256.toLowerCase() === facts.bodySha256.toLowerCase() &&
    ef.signedAt < facts.signedAt;
  if (!ok || !ef) {
    return { phase: 'refused', kind: pending.kind, reason: "The earlier capture didn't pass its checks or has different bytes, so this can't be a confirmation of it.", report };
  }
  return { phase: 'ready', pending, bytes, report, facts, earlier: { key: pending.captureKey, signedAt: ef.signedAt } };
}

const sameHex = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * A record this account already wrote for this pending capture, if any. After a failure that
 * came after MetaMask sent the transaction (a receipt timeout, a reload), the record may exist
 * already: it is reused (and marked published) instead of writing a second one. It must match
 * what markPublished checks: the same evidence reference for a capture, the same earlier
 * capture for a confirmation, and the same bytes and signed time.
 */
async function existingRecord(ready: Ready, owner: Address): Promise<Hex | null> {
  try {
    const { rows } = await listByUrl(arkivPublic(getNetConfig()), ready.facts.urlHash);
    const hit = rows.find(
      (r) =>
        sameHex(r.owner, owner) &&
        r.kind === ready.pending.kind &&
        sameHex(r.bodySha256, ready.facts.bodySha256) &&
        r.signedAt === ready.facts.signedAt &&
        (r.kind === 'capture' ? sameHex(r.evidenceRef, ready.pending.evidenceRef) : sameHex(r.captureKey, ready.earlier?.key)),
    );
    return hit?.entityKey ?? null;
  } catch {
    return null; // unknown: write (a duplicate is better than never publishing)
  }
}

/**
 * When the record expires, from the chain (the SDK turns 30 days into a block number). The
 * node's query index can trail the receipt by a moment, so the read is retried briefly.
 */
async function recordUntil(entityKey: Hex): Promise<Date | null> {
  const pub = arkivPublic(getNetConfig());
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [entity, timing] = await Promise.all([pub.getEntity(entityKey), pub.getBlockTiming()]);
      const seconds = Number(entity.$expiresAt - timing.currentBlock) * timing.blockDuration;
      return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return null;
}

type Discard = { state: 'idle' } | { state: 'working' } | { state: 'done' } | { state: 'error'; reason: string };

/**
 * "Discard this capture?" (design brief 4.2): a native modal dialog (focus stays inside, Esc
 * closes it, focus goes back to the button that opened it). Discarding removes the pending copy
 * from the extension; nothing is published.
 */
function DiscardDialog({
  dialog,
  kind,
  discard,
  onConfirm,
  onClosed,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  /** 'unknown': the extension could not be asked, so what is pending is not known. */
  kind: 'capture' | 'confirmation' | 'unknown';
  discard: Discard;
  onConfirm: () => void;
  onClosed: () => void;
}) {
  return (
    <dialog ref={dialog} className="approve-dialog" aria-labelledby="discard-title" onClose={onClosed}>
      <h2 id="discard-title" className="section-title">
        {kind === 'confirmation' ? 'Discard this confirmation?' : 'Discard this capture?'}
      </h2>
      <p>
        {kind === 'capture'
          ? "The uploaded evidence stays on Swarm but won't be listed."
          : kind === 'confirmation'
            ? 'Nothing was uploaded for it, and nothing will be published.'
            : 'It is removed from the extension, and nothing will be published.'}
      </p>
      {discard.state === 'error' ? (
        <p className="field-error" role="alert">
          {discard.reason}
        </p>
      ) : null}
      <div className="approve-dialog-actions">
        <button type="button" className="btn btn-danger" disabled={discard.state === 'working'} aria-busy={discard.state === 'working'} onClick={onConfirm}>
          {discard.state === 'working' ? 'Discarding…' : 'Discard'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => dialog.current?.close()}>
          Keep it
        </button>
      </div>
    </dialog>
  );
}

/** Tells the extension, which checks the record on Arkiv first; retried while the read catches up. */
async function markPublished(captureId: string, entityKey: Hex, extensionId: string | undefined): Promise<string | undefined> {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await ext.send({ type: 'recall.markPublished', captureId, entityKey }, { timeoutMs: 15_000, ...(extensionId ? { extensionId } : {}) });
      return undefined;
    } catch (e) {
      last = reasonOf(e);
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }
  return last;
}

const CHECK_TITLES = {
  A: 'Bytes match the signed hashes',
  B: 'Request and response are well-formed',
  C: 'Signed by a trusted witness',
} as const;

function CheckSummary({ report }: { report: CheckReport }) {
  return (
    <section className="approve-checks" aria-labelledby="approve-checks-title">
      <h2 id="approve-checks-title" className="section-title">
        Checked in this browser
      </h2>
      <ul className="approve-check-list">
        {(['A', 'B', 'C'] as const).map((k) => (
          <li key={k} data-check={k}>
            <span className="check-letter" aria-hidden="true">
              {k}
            </span>
            <span>
              <span className="visually-hidden">Check {k}: </span>
              {CHECK_TITLES[k]}
            </span>
            <StatusBadge status={report[k].status as Status} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Approve({ captureId }: { captureId: string | null }) {
  const cfg = useMemo(getNetConfig, []);
  const arkivId: ChainId = cfg.arkiv.chain === 'local' ? 1337 : 7794095;
  const arkivName = CHAIN_NAMES[arkivId];
  const extensionId = useMemo(extensionIdFromLink, []);
  const wallet = useWallet();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ phase: 'loading', step: 'Asking the Recall extension for the capture…' });
  const [publish, setPublish] = useState<Publish>({ state: 'idle' });
  const [discard, setDiscard] = useState<Discard>({ state: 'idle' });
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openDiscard = useCallback((e: MouseEvent<HTMLElement>) => {
    opener.current = e.currentTarget;
    setDiscard({ state: 'idle' });
    dialog.current?.showModal();
  }, []);
  const confirmDiscard = useCallback(async () => {
    if (!captureId) return;
    setDiscard({ state: 'working' });
    try {
      await ext.send({ type: 'recall.discardPending', captureId }, extensionId ? { extensionId } : {});
      setDiscard({ state: 'done' });
      dialog.current?.close();
    } catch (e) {
      setDiscard({ state: 'error', reason: `${sentence(reasonOf(e))}. The capture is still pending.` });
    }
  }, [captureId, extensionId]);
  const discardDialog = (kind: 'capture' | 'confirmation' | 'unknown') => (
    <DiscardDialog
      dialog={dialog}
      kind={kind}
      discard={discard}
      onConfirm={() => void confirmDiscard()}
      onClosed={() => opener.current?.isConnected && opener.current.focus()}
    />
  );
  const discardButton = (
    <button type="button" className="btn btn-danger" onClick={openDiscard}>
      Discard capture
    </button>
  );

  useEffect(() => {
    if (!captureId) {
      setLoad({ phase: 'none' });
      return;
    }
    let live = true;
    setLoad({ phase: 'loading', step: 'Asking the Recall extension for the capture…' });
    loadPending(captureId, extensionId, (step) => live && setLoad({ phase: 'loading', step }))
      .catch((e): Load => ({ phase: 'refused', reason: `The checks could not run: ${reasonOf(e)}.` }))
      .then((l) => live && setLoad(l));
    return () => {
      live = false;
    };
  }, [captureId, extensionId, attempt]);

  const busy = ['connecting', 'switching', 'looking', 'signing', 'publishing'].includes(publish.state);
  const connected = wallet.address !== null;
  const onArkiv = connected && wallet.chainId === arkivId;

  const run = useCallback(
    async (what: 'connect' | 'switch' | 'publish') => {
      if (load.phase !== 'ready' || !captureId) return;
      try {
        if (what === 'connect' || !connected) {
          setPublish({ state: 'connecting' });
          await connectWallet();
          if (what === 'connect') return setPublish({ state: 'idle' });
        }
        setPublish({ state: 'switching' });
        await ensureChain(arkivId);
        if (what === 'switch') return setPublish({ state: 'idle' });

        const provider = getProvider();
        if (!provider) throw new WalletError('no-wallet', 'MetaMask not found. Install it, then reload this page.');
        // Already connected above: read the account without opening another prompt.
        const [address] = (await provider.request({ method: 'eth_accounts' })) as Address[];
        if (!address) throw new WalletError('no-account', 'MetaMask is not connected. Connect it, then try again.');
        // Same provider, but the step moves on once MetaMask has sent the transaction.
        const watched = custom({
          async request(args: { method: string; params?: unknown }) {
            const res = await provider.request(args);
            if (args.method === 'eth_sendTransaction') setPublish({ state: 'publishing' });
            return res;
          },
        });
        const w = arkivWallet(cfg, watched, { address, type: 'json-rpc' } as unknown as Account);
        // Already written by this account (a failure after sending, a reload)? Reuse it.
        setPublish({ state: 'looking' });
        const existing = await existingRecord(load, address);
        if (!existing) setPublish({ state: 'signing' });
        const { pending, facts, bytes } = load;
        const { entityKey } = existing
          ? { entityKey: existing }
          : pending.kind === 'capture'
            ? await writeCapture(w, {
                urlHash: facts.urlHash,
                bodySha256: facts.bodySha256,
                serverName: facts.serverName,
                witness: facts.witness,
                signedAt: facts.signedAt,
                httpStatus: facts.httpStatus,
                batchId: pending.batchId!,
                evidenceRef: pending.evidenceRef!,
                canonicalUrl: facts.canonicalUrl,
              })
            : await writeConfirmation(w, {
                captureKey: load.earlier!.key,
                urlHash: facts.urlHash,
                bodySha256: facts.bodySha256,
                witness: facts.witness,
                signedAt: facts.signedAt,
                evidence: bytes,
              });
        // The record exists now (the receipt arrived). The pending copy goes away with this.
        const [markError, until] = await Promise.all([markPublished(captureId, entityKey, extensionId), recordUntil(entityKey)]);
        setPublish({ state: 'published', entityKey, until, ...(markError ? { markError } : {}) });
      } catch (e) {
        if (isUserRejection(e)) setPublish({ state: 'rejected' });
        else if (e instanceof WalletError) setPublish({ state: 'failed', reason: e.message });
        else setPublish({ state: 'failed', reason: sentence(reasonOf(e)), technical: errorText(e) });
      }
    },
    [load, captureId, connected, arkivId, cfg, extensionId],
  );

  const isConfirmation = load.phase === 'ready' && load.pending.kind === 'confirmation';
  // What the heading and the discard dialog call it. Only a confirmation reads an earlier capture,
  // so the offline view is always one; an unreachable extension says nothing about it.
  const itemKind: 'capture' | 'confirmation' | 'unknown' =
    load.phase === 'ready'
      ? load.pending.kind
      : load.phase === 'refused'
        ? (load.kind ?? 'capture')
        : load.phase === 'offline'
          ? 'confirmation'
          : load.phase === 'unreachable'
            ? 'unknown'
            : 'capture';
  const title = itemKind === 'confirmation' ? 'Publish this confirmation' : 'Publish this capture';

  if (load.phase === 'none') {
    return (
      <>
        <h1 tabIndex={-1}>Publish a capture</h1>
        <Notice kind="info" title="No capture waiting for approval">
          Start a capture from the Recall extension. If you already published this one, it is on its timeline.
        </Notice>
      </>
    );
  }
  if (load.phase === 'loading') {
    return (
      <>
        <h1 tabIndex={-1}>Publish this capture</h1>
        <p className="muted approve-loading" aria-live="polite">
          <StatusBadge status="pending" label={load.step} />
        </p>
      </>
    );
  }
  if (discard.state === 'done') {
    return (
      <>
        <h1 tabIndex={-1}>{title}</h1>
        <Notice kind="info" title="Capture discarded" focus>
          The capture was removed from the extension. Nothing was published.
        </Notice>
      </>
    );
  }
  if (load.phase === 'unreachable' || load.phase === 'offline') {
    return (
      <>
        <h1 tabIndex={-1}>{title}</h1>
        <Notice
          kind="error"
          title={load.phase === 'unreachable' ? "Couldn't reach the Recall extension" : "Couldn't reach Arkiv or Swarm"}
          focus
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
              <a className="btn btn-ghost" href="#/settings">
                Check settings
              </a>
              {captureId ? discardButton : null}
            </>
          }
        >
          {load.phase === 'unreachable'
            ? 'Open this page from the link the extension opened, or check the extension ID in Settings. Your capture is still pending in the extension.'
            : 'The earlier capture could not be read, so the confirmation was not checked yet. Your capture is still pending in the extension.'}
          <TechnicalDetails text={load.message} />
        </Notice>
        {discardDialog(itemKind)}
      </>
    );
  }
  if (load.phase === 'refused') {
    // Not a dead end: the reason, and a way to drop the pending capture.
    return (
      <>
        <h1 tabIndex={-1}>{title}</h1>
        <Notice kind="error" title="This capture can't be published" focus actions={captureId ? discardButton : undefined}>
          {load.reason} Nothing was published.
        </Notice>
        {load.report ? <CheckSummary report={load.report} /> : null}
        {discardDialog(itemKind)}
      </>
    );
  }

  const { facts, report, pending } = load;
  const trusted = witnessLabel(facts.witness) !== undefined;
  const published = publish.state === 'published';
  const timelineHref = `#/u/${facts.urlHash}`;

  const connectState: StepState = connected ? 'done' : publish.state === 'connecting' ? 'active' : publish.state === 'rejected' && !connected ? 'failed' : 'active';
  const networkState: StepState = !connected ? 'waiting' : onArkiv ? 'done' : 'active';
  const publishState: StepState = published
    ? 'done'
    : !onArkiv
      ? 'waiting'
      : publish.state === 'rejected' || publish.state === 'failed'
        ? 'failed'
        : 'active';

  // One primary action at a time: after a rejection or failure the notice's "Try again" is it.
  let primary: { label: string; busyLabel?: string; onClick: () => void } | null = null;
  if (!published && publish.state !== 'rejected' && publish.state !== 'failed') {
    if (!connected) primary = { label: 'Connect MetaMask', onClick: () => void run('connect') };
    else if (!onArkiv) primary = { label: `Switch to ${arkivName}`, onClick: () => void run('switch') };
    else primary = { label: isConfirmation ? 'Publish confirmation' : 'Publish record', onClick: () => void run('publish') };
  }
  const busyLabel =
    publish.state === 'connecting'
      ? 'Connecting…'
      : publish.state === 'switching'
        ? 'Switching network…'
        : publish.state === 'looking'
          ? 'Checking Arkiv…'
        : publish.state === 'signing'
          ? 'Confirm in MetaMask…'
          : publish.state === 'publishing'
            ? 'Publishing… waiting for the network'
            : '';

  return (
    <div className="approve" data-kind={pending.kind}>
      <h1 tabIndex={-1}>{title}</h1>
      <ExhibitCard facts={facts} {...(pending.evidenceRef ? { evidenceRef: pending.evidenceRef } : {})} />

      <section className="approve-proves" aria-labelledby="proves-title">
        <h2 id="proves-title" className="section-title">
          What this proves
        </h2>
        <p>
          The witness saw these exact bytes from {facts.serverName} at {formatUtc(facts.signedAt)}. It does not show
          that the content is true.
        </p>
        {load.earlier ? (
          <p>
            Unchanged since {formatUtc(load.earlier.signedAt)}: the bytes are the same as the{' '}
            <a href={`#/c/${load.earlier.key}`}>earlier capture</a>, so the record holds this evidence itself and
            nothing new is uploaded.
          </p>
        ) : null}
        <p className="approve-witness">
          <span>{witnessLabel(facts.witness) ?? 'Unknown witness'}</span>
          <MonoValue value={facts.witness} />
          <StatusBadge status={trusted ? 'pass' : 'warn'} label={trusted ? 'In your trusted list' : 'Unknown witness'} />
        </p>
        <WhyWitness />
      </section>

      <CheckSummary report={report} />

      {load.gatewayCopy === 'unavailable' && !published ? (
        <Notice kind="warn" title="Stored copy not confirmed">
          The download gateway didn&apos;t return this evidence under its Swarm reference, so Recall couldn&apos;t confirm that the stored
          copy is the same file. You can still publish. Open the capture afterwards to check it.
        </Notice>
      ) : null}

      <section aria-labelledby="publish-steps-title">
        <h2 id="publish-steps-title" className="section-title">
          Publish on Arkiv
        </h2>
        <Steps
          steps={[
            { label: 'Connect MetaMask', state: connectState },
            { label: `Switch to ${arkivName}`, state: networkState },
            { label: isConfirmation ? 'Publish the confirmation' : 'Publish the record', state: publishState },
          ]}
        />
      </section>

      {!getProvider() && !published ? (
        <Notice kind="error" title="MetaMask not found">
          MetaMask not found. Install it, then reload this page.
        </Notice>
      ) : null}
      {connected && !onArkiv && !published && !busy ? (
        <Notice kind="info" title="Wrong network">
          MetaMask is on {wallet.chainId !== null ? (CHAIN_NAMES[wallet.chainId as ChainId] ?? `network ${wallet.chainId}`) : 'another network'}. Records are
          published on {arkivName}.
        </Notice>
      ) : null}
      {publish.state === 'rejected' ? (
        <Notice
          kind="warn"
          title="Not published"
          focus
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => void run(onArkiv ? 'publish' : connected ? 'switch' : 'connect')}>
                Try again
              </button>
              {discardButton}
            </>
          }
        >
          You rejected the request in MetaMask. Your capture is kept as pending in the extension, so you can retry any time.
        </Notice>
      ) : null}
      {publish.state === 'failed' ? (
        <Notice
          kind="error"
          title="Publishing failed"
          focus
          actions={
            <button type="button" className="btn btn-secondary" onClick={() => void run('publish')}>
              Try again
            </button>
          }
        >
          {publish.reason}. Your capture is still pending.
          {publish.technical ? <TechnicalDetails text={publish.technical} /> : null}
        </Notice>
      ) : null}
      {publish.state === 'published' ? (
        <Notice
          kind="success"
          title="Published"
          focus
          actions={
            <>
              <a className="btn btn-secondary" href={timelineHref}>
                View timeline
              </a>
              <a className="btn btn-ghost" href={`#/c/${pending.kind === 'capture' ? publish.entityKey : load.earlier!.key}`}>
                {pending.kind === 'capture' ? 'View this capture' : 'View the earlier capture'}
              </a>
            </>
          }
        >
          {publish.until ? `Record on Arkiv until ${formatDay(publish.until)}.` : `Record on Arkiv for ${RECORD_DAYS} days.`}{' '}
          <span className="approve-record">
            Record <MonoValue value={publish.entityKey} />
          </span>
          {publish.markError ? (
            <span className="approve-record">
              The extension could not be told, so it still lists this capture as pending.
              <TechnicalDetails text={publish.markError} />
            </span>
          ) : null}
        </Notice>
      ) : null}

      {primary ? (
        <div className="approve-bar">
          <button
            type="button"
            className="btn btn-primary btn-wide"
            disabled={busy || !getProvider()}
            aria-busy={busy}
            onClick={primary.onClick}
          >
            {busy ? (
              <>
                <LoaderCircle size={16} strokeWidth={1.75} aria-hidden="true" className="spin" />
                {busyLabel}
              </>
            ) : (
              primary.label
            )}
          </button>
          <p className="field-helper">
            MetaMask will show the network fee. The record lasts {RECORD_DAYS} days; anyone can extend it.
          </p>
        </div>
      ) : null}
      {discardDialog(pending.kind)}
    </div>
  );
}
