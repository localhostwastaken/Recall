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
  XBZZ,
  arkivPublic,
  arkivWallet,
  costFor,
  isFreeBatch,
  listByUrl,
  swarmRootOf,
  waitBatchUsable,
  writeCapture,
  writeConfirmation,
} from '@recall/net';
import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { createPublicClient, custom, erc20Abi, http, type Account, type Address, type Hex, type PublicClient } from 'viem';
import { ExhibitCard } from '../components/ExhibitCard';
import { downloadEvidence } from '../download';
import { errorText, shortErrorText } from '../errors';
import { ExtError, addBatches, ext, extensionIdFromLink, getStampAddress } from '../ext';
import { formatBzzCeil, formatDay, formatUtc } from '../format';
import { saveSettingsChecked } from '../settings';
import { DEPTH, USABLE_TIMEOUT_MS, buyOneBatch, forgetSent, linkNeedsConfirm, reason as buyReason, recallSent, settlePurchase } from '../storage/buy';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { StatusBadge, type Status } from '../ui/StatusBadge';
import { Steps, type StepState } from '../ui/Steps';
import { ChecksCard, TechnicalDetails, WhyWitness } from '../verify/CheckPanel';
import { GATEWAY_COPY_MS, compareGatewayCopy, type GatewayCopy } from '../verify/gatewayCopy';
import { verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { verdictOf } from '../verify/verify';
import { trustedWitnesses, witnessLabel } from '../witness';
import {
  CHAIN_NAMES,
  chainFor,
  connectWallet,
  ensureChain,
  getProvider,
  isUserRejection,
  useWallet,
  walletFor,
  WalletError,
  type ChainId,
} from '../wallet';
import './approve.css';

/**
 * #/approve/:captureId — the publish page of a capture the extension holds as pending (R44,
 * capture first). The extension opens it right after the checks, before anything is uploaded,
 * and the person chooses here:
 * (a) the same bytes as the verified earlier capture: confirm it (no upload), keep the earlier
 *     capture alive, or discard;
 * (b) a new or changed page: upload with a batch the extension has, or buy one batch first
 *     (MetaMask on Gnosis, never twice), or use the gateway's free storage when the extension's
 *     settings allow it; then publish;
 * (c) published.
 * The page never takes the extension's word for anything: it runs checks A to C on the evidence
 * itself (A and B must pass, C must not fail), checks that the uploaded evidence reference really
 * is these bytes (or, for a confirmation, that the earlier capture verifies and has the same
 * bytes), and builds the record only from the verified facts. MetaMask then writes it
 * (`permissionlessExtension`, 30 days), and the extension is told, which removes its pending copy
 * (so the record is never read back from the extension after that).
 */

/** The upload of a pending capture, as the extension reports it. */
type UploadInfo =
  | { status: 'none' }
  | { status: 'uploading' }
  | { status: 'uploaded'; evidenceRef: Hex; batchId: Hex }
  | { status: 'failed'; reason: string };

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
  /** Captures (R44): the upload the person started here, if any. */
  upload?: UploadInfo;
  /** Whether a batch in the extension's pool can take the upload now. */
  storage?: 'ok' | 'empty';
  /** `free`: the extension's settings allow the gateway's free storage. */
  uploadMode?: 'stamped' | 'free';
};

/** One batch of this many days is bought for a capture that has no storage. */
const BUY_DAYS = 7;
/** How long the page follows an upload the extension runs (batch wait 2 min + upload 1 min). */
const UPLOAD_WAIT_MS = 6 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Evidence inline in an Arkiv record must stay within this size (spec 3.2). */
const INLINE_EVIDENCE_MAX = 128 * 1024;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const RECORD_DAYS = 30;

/** A capture's evidence on Swarm, its reference checked against the verified bytes here. */
type Stored = {
  evidenceRef: Hex;
  batchId: Hex;
  /** Free-mode captures: whether the download gateways hold these very bytes under the reference. */
  gatewayCopy?: GatewayCopy;
};

type Ready = {
  pending: PendingRecord;
  bytes: Uint8Array;
  report: CheckReport;
  facts: VerifiedFacts;
  /** Confirmations: the verified earlier capture. */
  earlier?: { key: Hex; signedAt: bigint };
  /** Captures: set only once the uploaded reference passed its check here. */
  stored?: Stored;
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

/**
 * Checks that an uploaded evidence reference names these very bytes. The Swarm reference is a
 * hash of the bytes, so it is checked here without a download. A free-mode capture (all-zero
 * batch id: the evidence went to a gateway's own storage) is the one case where that does not
 * hold: for files over 4 KB the gateway's reference differs from the locally computed root (R13).
 * Its evidence is bound by checks A to C, and by the record being built from the facts of this
 * very evidence; the gateways are asked whether they hold these bytes under it: other bytes block
 * the publish, no answer is only a warning. Every other batch id keeps the root check.
 */
async function checkStored(
  up: { evidenceRef?: Hex; batchId?: Hex },
  bytes: Uint8Array,
  onStep: (s: string) => void,
): Promise<Stored | { reason: string }> {
  const { evidenceRef, batchId } = up;
  if (!evidenceRef || !KEY.test(evidenceRef) || !batchId || !KEY.test(batchId)) {
    return { reason: 'The capture has no valid Swarm reference or storage batch.' };
  }
  onStep('Checking the uploaded evidence reference…');
  if (!isFreeBatch(batchId)) {
    if ((await swarmRootOf(bytes)) !== evidenceRef.slice(2).toLowerCase()) {
      return { reason: "The uploaded evidence reference doesn't match this capture's evidence." };
    }
    return { evidenceRef, batchId };
  }
  onStep("Checking the gateway's copy of the evidence…");
  let copy: Uint8Array | null = null;
  try {
    copy = (await downloadEvidence(getNetConfig(), { evidenceRef, batchId }, { signal: AbortSignal.timeout(GATEWAY_COPY_MS) })).bytes;
  } catch {
    copy = null;
  }
  const gatewayCopy = compareGatewayCopy(copy, bytes);
  if (gatewayCopy === 'different') {
    return {
      reason: "The file the gateway holds under this Swarm reference is not this capture's evidence, so a record pointing at it would be wrong.",
    };
  }
  return { evidenceRef, batchId, gatewayCopy };
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
    // Not uploaded yet (R44): the person chooses the storage here. An older extension that
    // uploaded first sends the reference without an upload state.
    const uploaded =
      pending.upload?.status === 'uploaded'
        ? pending.upload
        : !pending.upload && pending.evidenceRef && pending.batchId
          ? { evidenceRef: pending.evidenceRef, batchId: pending.batchId }
          : null;
    if (!uploaded) return { phase: 'ready', pending, bytes, report, facts };
    const stored = await checkStored(uploaded, bytes, onStep);
    if ('reason' in stored) return { phase: 'refused', kind: pending.kind, reason: stored.reason, report };
    return { phase: 'ready', pending, bytes, report, facts, stored };
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
        (r.kind === 'capture' ? sameHex(r.evidenceRef, ready.stored?.evidenceRef) : sameHex(r.captureKey, ready.earlier?.key)),
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
    <ChecksCard
      className="approve-checks"
      title="Checked in this browser"
      titleId="approve-checks-title"
      checks={(['A', 'B', 'C'] as const).map((k) => ({ letter: k, status: report[k].status as Status }))}
    >
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
    </ChecksCard>
  );
}

/** How the evidence of a new capture is stored (path b): a batch the extension has, a bought one, or free storage. */
type SaveHow = 'stamped' | 'buy' | 'free';
type BuyStep = 'checking' | 'wallet' | 'buying' | 'waiting' | 'handing';
type Save =
  | { state: 'idle' }
  | { state: 'buying'; how: 'buy'; step: BuyStep }
  | { state: 'uploading'; how: SaveHow }
  | { state: 'checking'; how: SaveHow }
  | { state: 'error'; how: SaveHow; stage: 'buy' | 'upload'; title: string; body: string; retryLabel: string; technical?: string };
/** The ?ext= rule (as on Storage): an extension only the link names owns nothing bought until the person says so. */
type ExtAsk = { state: 'none' } | { state: 'ask'; address: Address | null | 'error' } | { state: 'ok'; address: Address };
type Price = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; perBatch: bigint };

const BUY_LABEL: Record<BuyStep, string> = {
  checking: 'Checking the earlier purchase…',
  wallet: 'Confirm in MetaMask…',
  buying: 'Buying storage… confirm in MetaMask',
  waiting: 'Getting the storage ready (1–2 min)…',
  handing: 'Handing the storage to the extension…',
};

export function Approve({ captureId }: { captureId: string | null }) {
  const cfg = useMemo(getNetConfig, []);
  const gnosisPub = useMemo(
    () => createPublicClient({ chain: chainFor(100), transport: http(cfg.gnosis.rpcUrl) }) as PublicClient,
    [cfg],
  );
  const arkivId: ChainId = cfg.arkiv.chain === 'local' ? 1337 : 7794095;
  const arkivName = CHAIN_NAMES[arkivId];
  const extensionId = useMemo(extensionIdFromLink, []);
  const extOpts = useMemo(() => (extensionId ? { extensionId } : {}), [extensionId]);
  const wallet = useWallet();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ phase: 'loading', step: 'Asking the Recall extension for the capture…' });
  const [publish, setPublish] = useState<Publish>({ state: 'idle' });
  const [discard, setDiscard] = useState<Discard>({ state: 'idle' });
  const [save, setSave] = useState<Save>({ state: 'idle' });
  const [bought, setBought] = useState(false);
  const [extAsk, setExtAsk] = useState<ExtAsk>({ state: 'none' });
  const [price, setPrice] = useState<Price>({ kind: 'loading' });
  const [priceTry, setPriceTry] = useState(0);
  const followed = useRef(false);
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
      await ext.send({ type: 'recall.discardPending', captureId }, extOpts);
      setDiscard({ state: 'done' });
      dialog.current?.close();
    } catch (e) {
      setDiscard({ state: 'error', reason: `${sentence(reasonOf(e))}. The capture is still pending.` });
    }
  }, [captureId, extOpts]);
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

  const publishBusy = ['connecting', 'switching', 'looking', 'signing', 'publishing'].includes(publish.state);
  const saving = save.state === 'buying' || save.state === 'uploading' || save.state === 'checking';
  const busy = publishBusy || saving;
  const connected = wallet.address !== null;
  const onArkiv = connected && wallet.chainId === arkivId;
  const ready = load.phase === 'ready' ? load : null;
  const needsStorage = ready?.pending.kind === 'capture' && !ready.stored;
  const hasBatch = ready?.pending.storage === 'ok';
  const freeAllowed = ready?.pending.uploadMode === 'free';

  // The price of one batch, shown before buying (no wallet needed to read it).
  const showPrice = needsStorage && !hasBatch;
  useEffect(() => {
    if (!showPrice) return;
    let live = true;
    setPrice({ kind: 'loading' });
    costFor(gnosisPub, DEPTH, BUY_DAYS).then(
      (perBatch) => live && setPrice({ kind: 'ready', perBatch }),
      () => live && setPrice({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [showPrice, gnosisPub, priceTry]);

  const run = useCallback(
    async (what: 'connect' | 'switch' | 'publish', readyArg?: Ready) => {
      const r = readyArg ?? (load.phase === 'ready' ? load : null);
      if (!r || !captureId) return;
      // A capture is published only with an uploaded reference that passed its check here.
      if (what === 'publish' && r.pending.kind === 'capture' && !r.stored) return;
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
        const existing = await existingRecord(r, address);
        if (!existing) setPublish({ state: 'signing' });
        const { pending, facts, bytes, stored } = r;
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
                batchId: stored!.batchId,
                evidenceRef: stored!.evidenceRef,
                canonicalUrl: facts.canonicalUrl,
              })
            : await writeConfirmation(w, {
                captureKey: r.earlier!.key,
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

  /** What the extension says now about storage and the upload (never the evidence: that was checked). */
  const refreshOffer = useCallback(async () => {
    if (!captureId) return;
    try {
      const a = await ext.send<PendingRecord>({ type: 'recall.getPending', captureId }, extOpts);
      setLoad((l) =>
        l.phase === 'ready' && !l.stored
          ? { ...l, pending: { ...l.pending, storage: a.storage, uploadMode: a.uploadMode, upload: a.upload } }
          : l,
      );
    } catch {
      /* keep what is shown */
    }
  }, [captureId, extOpts]);

  /** Follows the extension's upload until the evidence is on Swarm, then checks its reference here. */
  const followUpload = useCallback(
    async (r: Ready, how: SaveHow): Promise<Ready | null> => {
      setSave({ state: 'uploading', how });
      const deadline = Date.now() + UPLOAD_WAIT_MS;
      let up: { evidenceRef: Hex; batchId: Hex } | null = null;
      while (!up) {
        const a = await ext.send<PendingRecord>({ type: 'recall.getPending', captureId }, extOpts);
        const u = a.upload;
        if (u?.status === 'uploaded') up = u;
        else if (u?.status === 'failed') throw new Error(u.reason);
        else if (!u || u.status === 'none') throw new Error('the upload did not start');
        else if (Date.now() > deadline) throw new Error('the upload did not finish in time');
        else await sleep(1_500);
      }
      setSave({ state: 'checking', how });
      const stored = await checkStored(up, r.bytes, () => undefined);
      if ('reason' in stored) {
        setSave({ state: 'idle' });
        setLoad({ phase: 'refused', kind: 'capture', reason: stored.reason, report: r.report });
        return null;
      }
      const next: Ready = { ...r, stored };
      setLoad({ phase: 'ready', ...next });
      setSave({ state: 'idle' });
      return next;
    },
    [captureId, extOpts],
  );

  const uploadFailed = useCallback((how: SaveHow, e: unknown): Save => {
    const why = sentence(reasonOf(e));
    return {
      state: 'error',
      how,
      stage: 'upload',
      title: 'Upload failed',
      body: `${why}. Your capture is kept in the extension, so nothing is lost: try the upload again.`,
      retryLabel: 'Try upload again',
    };
  }, []);

  // Back on this page while an upload runs (a reload), or after one failed: follow it, or say so.
  useEffect(() => {
    if (!ready || ready.pending.kind !== 'capture' || ready.stored || followed.current) return;
    const u = ready.pending.upload;
    if (u?.status === 'uploading') {
      followed.current = true;
      const how: SaveHow = ready.pending.uploadMode === 'free' && ready.pending.storage !== 'ok' ? 'free' : 'stamped';
      followUpload(ready, how)
        .then((next) => {
          if (next && next.stored?.gatewayCopy !== 'unavailable') return run('publish', next);
        })
        .catch((e) => {
          setSave(uploadFailed(how, e));
          void refreshOffer();
        });
    } else if (u?.status === 'failed') {
      followed.current = true;
      setSave(uploadFailed('stamped', new Error(u.reason)));
    }
  }, [ready, followUpload, run, uploadFailed, refreshOffer]);

  /**
   * Buys one batch for the extension's stamp key, waits until Bee takes stamps for it and hands it
   * to the extension. A purchase sent before (a lost receipt, a reload) is looked up first and never
   * bought again; its hash is kept until the extension holds the batch.
   */
  const buyStorage = async (confirmedOwner?: Address): Promise<boolean> => {
    const key = `recall.approve.sentTx.v1.${captureId}`;
    const stop = (title: string, body: string, technical?: string) => {
      setSave({ state: 'error', how: 'buy', stage: 'buy', title, body, retryLabel: 'Try again', ...(technical ? { technical } : {}) });
      return false;
    };
    const mayHaveGone = (txHash: Hex) =>
      stop(
        'The purchase may have gone through',
        "Recall couldn't read the result of the storage purchase, so it won't buy again by itself. Wait a minute, then try again: it looks the purchase up first.",
        txHash,
      );
    let owner: Address;
    try {
      owner = confirmedOwner ?? (await getStampAddress(extOpts));
    } catch (e) {
      return stop("Couldn't reach the Recall extension", `${sentence(reasonOf(e))}. Nothing was bought.`);
    }
    let batchId: Hex | null = null;
    const earlier = recallSent(key);
    if (earlier) {
      setSave({ state: 'buying', how: 'buy', step: 'checking' });
      const found = await settlePurchase(gnosisPub, earlier, owner);
      if (found.kind === 'unknown') return mayHaveGone(earlier);
      if (found.kind === 'bought') batchId = found.batchId;
      else forgetSent(key); // it bought nothing: buy below
    }
    if (!batchId) {
      setSave({ state: 'buying', how: 'buy', step: 'wallet' });
      let w: ReturnType<typeof walletFor>;
      try {
        const { address } = await connectWallet();
        await ensureChain(100);
        const need = await costFor(gnosisPub, DEPTH, BUY_DAYS);
        const have = await gnosisPub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
        if (have < need) {
          return stop('Not enough xBZZ', `One storage batch costs about ${formatBzzCeil(need)} xBZZ on Gnosis. Add xBZZ to this account, then try again. Nothing was bought.`);
        }
        w = walletFor(address, 100);
      } catch (e) {
        if (isUserRejection(e)) return stop('Storage not bought', 'You rejected the request in MetaMask. Nothing was bought.');
        return stop('Storage not bought', `${sentence(buyReason(e))}. Nothing was bought.`);
      }
      setSave({ state: 'buying', how: 'buy', step: 'buying' });
      const r = await buyOneBatch(w, gnosisPub, {
        owner,
        days: BUY_DAYS,
        quotedTotal: price.kind === 'ready' ? price.perBatch : undefined,
        sentKey: key,
      });
      if (r.kind === 'unknown') return mayHaveGone(r.txHash);
      if (r.kind === 'cancelled') {
        forgetSent(key);
        return stop('Storage not bought', 'You rejected the request in MetaMask, so no storage was bought.');
      }
      if (r.kind === 'failed') {
        forgetSent(key);
        if (r.rose) setPriceTry((n) => n + 1);
        return stop(
          'Storage not bought',
          r.rose
            ? `The price rose to ${formatBzzCeil(r.rose.total)} xBZZ from the ${formatBzzCeil(r.rose.quoted)} xBZZ shown, so nothing was sent. Check the new price, then try again.`
            : `${sentence(r.message)}.`,
        );
      }
      batchId = r.batchId;
    }
    // Bee takes stamps a little after creation; the extension also waits before it uploads.
    setSave({ state: 'buying', how: 'buy', step: 'waiting' });
    await waitBatchUsable(cfg.swarm.uploadUrl, batchId, USABLE_TIMEOUT_MS, { chain: gnosisPub }).catch(() => undefined);
    setSave({ state: 'buying', how: 'buy', step: 'handing' });
    try {
      await addBatches([batchId], extOpts);
    } catch (e) {
      return stop(
        "The extension didn't take the storage",
        `${sentence(reasonOf(e))}. The storage is bought: try again to hand it over (it is not bought twice).`,
      );
    }
    forgetSent(key);
    setBought(true);
    return true;
  };

  /** Path (b): store the evidence (buying a batch first when asked), then publish. */
  const saveAndPublish = async (how: SaveHow, confirmedOwner?: Address) => {
    if (!ready || !captureId || ready.pending.kind !== 'capture' || ready.stored) return;
    setPublish({ state: 'idle' });
    if (how === 'buy' && !(await buyStorage(confirmedOwner))) return;
    try {
      // Nothing is uploaded before this request: the extension starts it once, whatever the clicks.
      await ext.send({ type: 'recall.uploadPending', captureId, mode: how === 'free' ? 'free' : 'stamped' }, { timeoutMs: 15_000, ...extOpts });
      const next = await followUpload(ready, how);
      // A stored copy the gateways did not confirm is shown first; the person publishes from there.
      if (next && next.stored?.gatewayCopy !== 'unavailable') await run('publish', next);
    } catch (e) {
      setSave(uploadFailed(how, e));
      void refreshOffer();
    }
  };

  const startBuy = () => {
    if (linkNeedsConfirm(extensionId) && extAsk.state !== 'ok') {
      setExtAsk({ state: 'ask', address: null });
      getStampAddress(extOpts).then(
        (address) => setExtAsk({ state: 'ask', address }),
        () => setExtAsk({ state: 'ask', address: 'error' }),
      );
      return;
    }
    void saveAndPublish('buy', extAsk.state === 'ok' ? extAsk.address : undefined);
  };
  const adoptLinkExtension = (address: Address) => {
    // Saved to Settings, except on a shared /bzz/ origin (R38), where it holds for this page only.
    if (extensionId) saveSettingsChecked({ extensionId });
    // The owner is the address the person was shown, not a second answer from the extension.
    setExtAsk({ state: 'ok', address });
    void saveAndPublish('buy', address);
  };
  const retrySave = () => {
    if (save.state !== 'error') return;
    const { how, stage } = save;
    setSave({ state: 'idle' });
    if (how === 'free') void saveAndPublish('free');
    else if (stage === 'buy' || (how === 'buy' && !bought && !hasBatch)) startBuy();
    else if (hasBatch || how === 'stamped' || bought) void saveAndPublish('stamped');
    else startBuy();
  };

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
  const title = itemKind === 'confirmation' ? 'Confirm this capture' : 'Save this capture';

  if (load.phase === 'none') {
    return (
      <>
        <h1 tabIndex={-1}>Publish a capture</h1>
        <Notice kind="info" title="No capture waiting here">
          Start a capture from the Recall extension. If you already published this one, it is on its timeline.
        </Notice>
      </>
    );
  }
  if (load.phase === 'loading') {
    return (
      <>
        <h1 tabIndex={-1}>{title}</h1>
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
  const heading = isConfirmation && load.earlier ? `Unchanged since ${formatUtc(load.earlier.signedAt)}` : title;
  const how: SaveHow | null = save.state === 'idle' ? null : save.how;

  // Steps (design brief: Steps on Approve). A new capture first stores its evidence.
  const steps: { label: string; state: StepState }[] = [];
  if (pending.kind === 'capture') {
    const buyFailed = save.state === 'error' && save.stage === 'buy';
    if (bought || how === 'buy' || (needsStorage && !hasBatch && how !== 'free')) {
      const buyStep = save.state === 'buying' ? save.step : null;
      const buyDone = bought || (buyStep !== null && (buyStep === 'waiting' || buyStep === 'handing'));
      steps.push(
        { label: 'Buy storage (Gnosis)', state: buyDone ? 'done' : buyFailed ? 'failed' : buyStep ? 'active' : 'waiting' },
        { label: 'Get the storage ready', state: bought ? 'done' : buyStep === 'waiting' || buyStep === 'handing' ? 'active' : 'waiting' },
      );
    }
    const upFailed = save.state === 'error' && save.stage === 'upload';
    steps.push({
      label: how === 'free' ? 'Upload to free storage' : 'Upload the evidence',
      state: load.stored ? 'done' : save.state === 'uploading' || save.state === 'checking' ? 'active' : upFailed ? 'failed' : 'waiting',
    });
  }
  const atPublish = !needsStorage;
  steps.push(
    {
      label: 'Connect MetaMask',
      state: connected
        ? 'done'
        : !atPublish
          ? 'waiting'
          : publish.state === 'rejected'
            ? 'failed'
            : 'active',
    },
    { label: `Switch to ${arkivName}`, state: !connected || !atPublish ? 'waiting' : onArkiv ? 'done' : 'active' },
    {
      label: isConfirmation ? 'Publish the confirmation' : 'Publish the record',
      state: published
        ? 'done'
        : !atPublish || !onArkiv
          ? 'waiting'
          : publish.state === 'rejected' || publish.state === 'failed'
            ? 'failed'
            : 'active',
    },
  );

  // One primary action at a time: after a rejection or failure the notice's "Try again" is it.
  let primary: { label: string; onClick: () => void; blocked?: string } | null = null;
  if (!published && publish.state !== 'rejected' && publish.state !== 'failed' && save.state !== 'error' && extAsk.state !== 'ask') {
    if (isConfirmation) primary = { label: "Confirm it's still the same", onClick: () => void run('publish') };
    else if (!needsStorage) primary = { label: 'Publish record', onClick: () => void run('publish') };
    else if (hasBatch) primary = { label: 'Upload and publish', onClick: () => void saveAndPublish('stamped') };
    else {
      primary = {
        label: 'Buy storage and publish',
        onClick: startBuy,
        ...(price.kind === 'loading'
          ? { blocked: 'Reading the storage price…' }
          : price.kind === 'error'
            ? { blocked: 'The storage price could not be read, so buying is paused.' }
            : {}),
      };
    }
  }
  const busyLabel =
    save.state === 'buying'
      ? BUY_LABEL[save.step]
      : save.state === 'uploading'
        ? how === 'free'
          ? 'Uploading to free storage…'
          : 'Uploading the evidence…'
        : save.state === 'checking'
          ? 'Checking the upload…'
          : publish.state === 'connecting'
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
  const helper = primary?.blocked
    ? primary.blocked
    : isConfirmation
      ? `No upload is needed. MetaMask will show the network fee. The record lasts ${RECORD_DAYS} days; anyone can extend it.`
      : needsStorage && hasBatch
        ? 'The extension uploads the evidence with your storage, then MetaMask publishes the record.'
        : needsStorage
          ? `One storage batch for ${BUY_DAYS} days${price.kind === 'ready' ? `: about ${formatBzzCeil(price.perBatch)} xBZZ` : ''}, paid in MetaMask on Gnosis. Then the extension uploads the evidence and MetaMask publishes the record.`
          : `MetaMask will show the network fee. The record lasts ${RECORD_DAYS} days; anyone can extend it.`;

  return (
    <div className="approve" data-kind={pending.kind}>
      <h1 tabIndex={-1}>{heading}</h1>
      <ExhibitCard
        facts={facts}
        unverified={report.C.status !== 'pass'}
        {...(load.stored ? { evidenceRef: load.stored.evidenceRef } : {})}
      />

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

      {needsStorage && !published ? (
        <section className="approve-save" aria-labelledby="save-title">
          <h2 id="save-title" className="section-title">
            Store the evidence
          </h2>
          <p>
            {hasBatch
              ? 'Your extension has storage for this capture. The evidence goes to Swarm, then its record is published on Arkiv.'
              : 'Your extension has no storage left. Buy one storage batch, then the evidence goes to Swarm and its record is published on Arkiv.'}
          </p>
          {freeAllowed ? (
            <p className="muted">
              Free storage (the gateway&apos;s own) needs no batch, but has no known end date and can&apos;t be kept alive.
            </p>
          ) : null}
        </section>
      ) : null}

      {load.stored?.gatewayCopy === 'unavailable' && !published ? (
        <Notice kind="warn" title="Stored copy not confirmed">
          The download gateway didn&apos;t return this evidence under its Swarm reference, so Recall couldn&apos;t confirm that the stored
          copy is the same file. You can still publish. Open the capture afterwards to check it.
        </Notice>
      ) : null}

      <section aria-labelledby="publish-steps-title">
        <h2 id="publish-steps-title" className="section-title">
          {isConfirmation ? 'Confirm on Arkiv' : 'Save and publish'}
        </h2>
        <Steps steps={steps} />
      </section>

      {!getProvider() && !published ? (
        <Notice kind="error" title="MetaMask not found">
          MetaMask not found. Install it, then reload this page.
        </Notice>
      ) : null}
      {connected && !onArkiv && atPublish && !published && !busy ? (
        <Notice kind="info" title="Wrong network">
          MetaMask is on {wallet.chainId !== null ? (CHAIN_NAMES[wallet.chainId as ChainId] ?? `network ${wallet.chainId}`) : 'another network'}. Records are
          published on {arkivName}.
        </Notice>
      ) : null}
      {extAsk.state === 'ask' ? (
        <Notice
          kind="warn"
          title="Which extension should own this storage?"
          focus
          actions={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={extAsk.address === null || extAsk.address === 'error'}
                onClick={() => extAsk.address && extAsk.address !== 'error' && adoptLinkExtension(extAsk.address)}
              >
                Use this extension
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setExtAsk({ state: 'none' })}>
                Cancel
              </button>
            </>
          }
        >
          <p>This link uses extension {extensionId}, which isn&apos;t the one in your Settings.</p>
          <p>
            {extAsk.address && extAsk.address !== 'error' ? (
              <>
                It reports the stamp address <MonoValue value={extAsk.address} />. The storage you buy belongs to that address,
                so use it only if it is your Recall extension.
              </>
            ) : extAsk.address === null ? (
              'Asking it for its stamp address…'
            ) : (
              'It did not answer, so it cannot be used.'
            )}
          </p>
        </Notice>
      ) : null}
      {save.state === 'error' ? (
        <Notice
          kind="error"
          title={save.title}
          focus
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={retrySave}>
                {save.retryLabel}
              </button>
              {discardButton}
            </>
          }
        >
          {save.body}
          {save.technical ? <TechnicalDetails text={save.technical} /> : null}
        </Notice>
      ) : null}
      {publish.state === 'rejected' ? (
        <Notice
          kind="warn"
          title="Not published"
          focus
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => void run('publish')}>
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
            disabled={busy || !getProvider() || primary.blocked !== undefined}
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
          <p className="field-helper" aria-live="polite">
            {helper}
          </p>
          {!busy ? (
            <div className="approve-more">
              {isConfirmation && load.earlier ? (
                <a className="btn btn-secondary" href={`#/c/${load.earlier.key}`}>
                  Keep the earlier capture alive…
                </a>
              ) : null}
              {needsStorage && freeAllowed ? (
                <button type="button" className="btn btn-secondary" onClick={() => void saveAndPublish('free')}>
                  Use free storage instead
                </button>
              ) : null}
              {isConfirmation || needsStorage ? (
                <button type="button" className="btn btn-ghost" onClick={openDiscard}>
                  Discard capture
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {discardDialog(pending.kind)}
    </div>
  );
}
