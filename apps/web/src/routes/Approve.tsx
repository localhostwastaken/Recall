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
  isLikelyNetworkFailure,
  listAttachments,
  listByUrl,
  swarmRootOf,
  waitBatchUsable,
  writeAttachment,
  writeCapture,
  writeCaptureWithAttachment,
  writeConfirmation,
  type AttachmentRow,
} from '@recall/net';
import { LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { createPublicClient, custom, erc20Abi, http, type Account, type Address, type Hex, type PublicClient } from 'viem';
import {
  GIT_CONTENT_TYPE,
  computeCode,
  downloadCode,
  repoOf,
  repoUrlHash,
  summaryDisagrees,
  type CodeComputed,
  type GitHubBranch,
  type RepoSummary,
} from '../attachments/git';
import { ExhibitCard } from '../components/ExhibitCard';
import { OutsideLink } from '../components/OutsideLinks';
import { CommitId } from '../components/RepoSnapshot';
import { downloadEvidence } from '../download';
import { errorText, shortErrorText } from '../errors';
import { arkivEntityUrl, gnosisTxUrl } from '../explorers';
import { UPLOAD_NETWORK_COPY, publishNetworkCopy } from '../networkCopy';
import { ExtError, addBatches, ext, extensionIdFromLink, getStampAddress } from '../ext';
import { formatBytes, formatBzzCeil, formatDay, formatUtc } from '../format';
import { saveSettingsChecked } from '../settings';
import { ATTACHMENT_DEPTH, USABLE_TIMEOUT_MS, buyOneBatch, depthFor, forgetSent, linkNeedsConfirm, reason as buyReason, recallSent, settlePurchase } from '../storage/buy';
import { choiceSettled } from '../storage/choice';
import { getNetConfig } from '../net';
import { MonoValue } from '../ui/MonoValue';
import { Notice } from '../ui/Notice';
import { StatusBadge, type Status } from '../ui/StatusBadge';
import { Steps, type StepState } from '../ui/Steps';
import { ChecksCard, TechnicalDetails, WhyWitness } from '../verify/CheckPanel';
import { GATEWAY_COPY_MS, compareGatewayCopy, type GatewayCopy } from '../verify/gatewayCopy';
import { verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { verdictOf } from '../verify/verify';
import { trustedWitnesses } from '../witness';
import {
  CHAIN_NAMES,
  chainFor,
  connectWallet,
  ensureChain,
  getProvider,
  isUserRejection,
  refreshWallet,
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
 *     (MetaMask on Gnosis, never twice), or use the gateway's free storage (always a choice here;
 *     the primary one when the wallet holds no xBZZ for a batch); then publish. Until the price, the
 *     wallet and its balance are read the choice reads "Checking storage options…" (no button); then
 *     the two buttons keep their place and label, and only the primary styling can move;
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
  | { status: 'uploading'; mode?: 'stamped' | 'free'; progress?: { done: number; total: number } }
  /** `attachmentRef`: the repository tarball's Swarm reference (R46), same batch. */
  | { status: 'uploaded'; evidenceRef: Hex; batchId: Hex; attachmentRef?: Hex }
  /** `mode`: the storage the person chose; "Try upload again" uses it again. */
  | { status: 'failed'; reason: string; mode?: 'stamped' | 'free' };

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
  /** The extension's settings: only the default suggestion (free storage is always allowed). */
  uploadMode?: 'stamped' | 'free';
  /** R46: the repository snapshot the extension checked and holds (no bytes here). */
  attachment?: RepoSummary;
  /** R46: the batch depth the upload needs (18 with a repository snapshot). */
  needsDepth?: number;
};

/** One batch of this many days is bought for a capture that has no storage. */
const BUY_DAYS = 7;
/** How long the page follows an upload the extension runs (batch wait 2 min + upload 1 min). */
const UPLOAD_WAIT_MS = 6 * 60_000;
/** With a repository snapshot (up to 25 MB of chunks); any progress of its upload adds this again. */
const UPLOAD_WAIT_CODE_MS = 20 * 60_000;
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
  /** R46: the uploaded code, downloaded and recomputed here (set only when it matched). */
  code?: { ref: Hex; computed: CodeComputed };
};

/** R46: the repository this capture proves (from the page's own facts) and the extension's summary, which agree. */
type Repo = { branch: GitHubBranch; summary: RepoSummary };

type Ready = {
  pending: PendingRecord;
  bytes: Uint8Array;
  report: CheckReport;
  facts: VerifiedFacts;
  /** Confirmations: the verified earlier capture. */
  earlier?: { key: Hex; signedAt: bigint };
  /** Captures: set only once the uploaded reference passed its check here. */
  stored?: Stored;
  /** R46: set when the capture comes with a repository snapshot. */
  repo?: Repo;
};

type Load =
  | { phase: 'loading'; step: string }
  | { phase: 'none' }
  | { phase: 'unreachable'; message: string }
  /** `what: 'code'`: the uploaded code could not be downloaded to check it (else: the earlier capture). */
  | { phase: 'offline'; message: string; what?: 'code' }
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
  /** `network`: the failure came from the network; `sent`: the wallet had already sent the transaction. */
  | { state: 'failed'; reason: string; technical?: string; network?: { sent: boolean } }
  | { state: 'published'; entityKey: Hex; attachmentKey?: Hex; until: Date | null; markError?: string };

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
  up: { evidenceRef?: Hex; batchId?: Hex; attachmentRef?: Hex },
  bytes: Uint8Array,
  onStep: (s: string) => void,
  repo?: Repo,
  onProgress?: (received: number, total: number | null) => void,
): Promise<Stored | { reason: string; retry?: boolean }> {
  const evidence = await checkStoredEvidence(up, bytes, onStep);
  if ('reason' in evidence || !repo) return evidence;
  const code = await checkUploadedCode(up, repo, onStep, onProgress);
  if ('reason' in code) return code;
  return { ...evidence, code };
}

const CODE_STEP = 'Checking the uploaded code…';
/** Public gateways can take 30 to 90 s to serve a 15 MB file just uploaded: wait that long, backing off. */
const CODE_WAIT_MS = 90_000;
const CODE_BACKOFF_MS = [3_000, 5_000, 8_000, 12_000, 15_000];
const CODE_WAITING = 'Waiting for Swarm to serve the code…';

/**
 * R46: downloads the uploaded tarball (25 MB cap; the Swarm root is checked for a stamped
 * upload) and recomputes it here: its git tree must be the one GitHub reported for the commit
 * (the page's own facts) and its hash and size the ones the extension checked. A download that
 * fails is retryable; bytes that don't match are not.
 */
async function checkUploadedCode(
  up: { batchId?: Hex; attachmentRef?: Hex },
  repo: Repo,
  onStep: (s: string) => void,
  onProgress?: (received: number, total: number | null) => void,
): Promise<{ ref: Hex; computed: CodeComputed } | { reason: string; retry?: boolean }> {
  const ref = up.attachmentRef;
  if (!ref || !KEY.test(ref) || !up.batchId) return { reason: "The extension didn't report where it uploaded the code." };
  onStep(CODE_STEP);
  let bytes: Uint8Array | null = null;
  let last: unknown;
  // A gateway can take a while to serve a file just uploaded: retry with backoff for up to
  // CODE_WAIT_MS, saying so, before "Try upload again" is offered.
  const deadline = Date.now() + CODE_WAIT_MS;
  for (let attempt = 1; !bytes; attempt++) {
    if (attempt > 1) {
      const wait = CODE_BACKOFF_MS[Math.min(attempt - 2, CODE_BACKOFF_MS.length - 1)]!;
      if (Date.now() + wait > deadline) break;
      onStep(`${CODE_WAITING} (try ${attempt})`);
      await sleep(wait);
    }
    try {
      bytes = (
        await downloadCode(ref, up.batchId, getNetConfig().swarm.downloadUrls, {
          signal: AbortSignal.timeout(120_000),
          ...(onProgress ? { onProgress } : {}),
        })
      ).bytes;
    } catch (e) {
      last = e;
    }
  }
  if (!bytes) return { reason: `The uploaded code couldn't be downloaded to check it: ${reasonOf(last)}.`, retry: true };
  let computed: CodeComputed;
  try {
    computed = await computeCode(bytes);
  } catch (e) {
    return { reason: `The uploaded code can't be read as a git snapshot: ${reasonOf(e)}.` };
  }
  if (computed.treeSha !== repo.branch.treeSha) return { reason: "The uploaded code doesn't match the commit GitHub reported." };
  if (computed.sha256.toLowerCase() !== repo.summary.sha256.toLowerCase() || computed.size !== repo.summary.size) {
    return { reason: "The uploaded code isn't the file the extension checked." };
  }
  return { ref, computed };
}

async function checkStoredEvidence(
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

  // R46: a repository snapshot is described by the page's own facts (the notarized GitHub
  // answer); the extension's summary must agree with them, or nothing is published.
  let repo: Repo | undefined;
  if (pending.attachment !== undefined && pending.attachment !== null) {
    const branch = pending.kind === 'capture' ? repoOf(facts) : null;
    const why = summaryDisagrees(pending.attachment, branch);
    if (why || !branch) {
      return { phase: 'refused', kind: pending.kind, reason: `The repository snapshot doesn't match the commit GitHub reported: ${why ?? 'unknown'}.`, report };
    }
    repo = { branch, summary: pending.attachment };
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
    if (!uploaded) return { phase: 'ready', pending, bytes, report, facts, ...(repo ? { repo } : {}) };
    const stored = await checkStored(uploaded, bytes, onStep, repo);
    if ('reason' in stored) {
      if (stored.retry) return { phase: 'offline', message: stored.reason, what: 'code' };
      return { phase: 'refused', kind: pending.kind, reason: stored.reason, report };
    }
    return { phase: 'ready', pending, bytes, report, facts, stored, ...(repo ? { repo } : {}) };
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

/** R46: the attachment record of a ready capture with checked code (without its parent key). */
function attachmentRowOf(r: Ready): Omit<AttachmentRow, 'parentCaptureKey'> | null {
  const code = r.stored?.code;
  if (!r.repo || !code || !r.stored) return null;
  return {
    urlHash: repoUrlHash(r.repo.branch),
    sha256: code.computed.sha256,
    kind: 'git',
    commitSha: r.repo.branch.commitSha,
    treeSha: code.computed.treeSha,
    proofLevel: 1,
    evidenceRef: code.ref,
    batchId: r.stored.batchId,
    size: BigInt(code.computed.size),
    contentType: GIT_CONTENT_TYPE,
  };
}

/** An attachment record this account already wrote for this capture and these bytes (a retry), if any. */
async function existingAttachment(parentKey: Hex, owner: Address, row: Omit<AttachmentRow, 'parentCaptureKey'>): Promise<Hex | null> {
  try {
    const { rows } = await listAttachments(arkivPublic(getNetConfig()), parentKey);
    const hit = rows.find(
      (a) =>
        sameHex(a.creator, owner) &&
        a.kind === 'git' &&
        sameHex(a.sha256, row.sha256) &&
        sameHex(a.evidenceRef, row.evidenceRef) &&
        sameHex(a.urlHash, row.urlHash) &&
        a.commitSha === row.commitSha &&
        a.treeSha === row.treeSha,
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
  /** `code`: downloading and recomputing the uploaded repository snapshot (R46). */
  | { state: 'checking'; how: SaveHow; code?: { received: number; total: number | null; note?: string } }
  | { state: 'error'; how: SaveHow; stage: 'buy' | 'upload'; title: string; body: string; retryLabel: string; technical?: string };
/** The ?ext= rule (as on Storage): an extension only the link names owns nothing bought until the person says so. */
type ExtAsk = { state: 'none' } | { state: 'ask'; address: Address | null | 'error' } | { state: 'ok'; address: Address };
type Price = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; perBatch: bigint };
/**
 * The connected wallet's xBZZ on Gnosis; `unknown`: no wallet connected yet, or the read failed.
 * `for`: the account the read was made for (so a read of another account never counts as settled).
 */
type Funds = { kind: 'loading' } | { kind: 'unknown'; for?: Address } | { kind: 'ready'; have: bigint; for: Address };
/** The storage choice stops waiting for a slow read after this long (the free option is never held back). */
const CHECK_CAP_MS = 10_000;

const FREE_NOTE =
  "Free storage: the public Swarm gateway keeps it, no xBZZ needed. The gateway decides how long it stays, and nobody can pay to keep it alive. Good for trying Recall; use paid storage for evidence you'll need later.";

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
  /** The createBatch transaction of the storage this page bought, for the Gnosisscan link once published. */
  const [buyTx, setBuyTx] = useState<Hex | null>(null);
  const [extAsk, setExtAsk] = useState<ExtAsk>({ state: 'none' });
  const [price, setPrice] = useState<Price>({ kind: 'loading' });
  const [priceTry, setPriceTry] = useState(0);
  /** Shown in the storage choice when the page went back to it (the storage ran out). */
  const [offerNote, setOfferNote] = useState<string | null>(null);
  /** Another tab of this app holds this capture's publish lock. */
  const [otherTab, setOtherTab] = useState(false);
  const followed = useRef(false);
  // The wallet sent a publish transaction at some point: a network failure since then may have
  // written the record, so the page never says "nothing was written" after that.
  const txSent = useRef(false);
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
  // Free storage is always offered for a capture that still needs storing (the extension's
  // uploadMode setting is only a default suggestion).
  const freeAllowed = needsStorage;
  const needsBuy = needsStorage && !hasBatch;
  // R46: a capture with a repository snapshot needs a bigger batch (depth 18).
  const buyDepth = ready?.repo ? ATTACHMENT_DEPTH : depthFor(ready?.pending.needsDepth);

  // The price of one batch, read before any buying is offered (no wallet needed to read it).
  const showPrice = needsStorage;
  useEffect(() => {
    if (!showPrice) return;
    let live = true;
    setPrice({ kind: 'loading' });
    costFor(gnosisPub, buyDepth, BUY_DAYS).then(
      (perBatch) => live && setPrice({ kind: 'ready', perBatch }),
      () => live && setPrice({ kind: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [showPrice, gnosisPub, priceTry, buyDepth]);

  // The connected wallet's xBZZ, read only to choose the primary action (no prompt: an account
  // MetaMask already shares with this page).
  const [funds, setFunds] = useState<Funds>({ kind: 'unknown' });
  useEffect(() => {
    const account = wallet.address;
    if (!needsBuy || !account) {
      setFunds({ kind: 'unknown' });
      return;
    }
    let live = true;
    setFunds({ kind: 'loading' });
    gnosisPub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [account] }).then(
      (have) => live && setFunds({ kind: 'ready', have, for: account }),
      () => live && setFunds({ kind: 'unknown', for: account }),
    );
    return () => {
      live = false;
    };
  }, [needsBuy, wallet.address, gnosisPub]);

  // No account in the wallet state can only mean "not read yet" until the wallet has been asked once.
  const [walletChecked, setWalletChecked] = useState(false);
  useEffect(() => {
    let live = true;
    void refreshWallet().then(() => live && setWalletChecked(true));
    return () => {
      live = false;
    };
  }, []);

  // No xBZZ for a batch (or no way to tell: no price, no wallet account to read): free storage
  // is the primary action and buying the secondary one.
  const noXbzz = needsBuy && price.kind === 'ready' && funds.kind === 'ready' && funds.have < price.perBatch;
  const freeFirst = needsBuy && (price.kind === 'error' || (price.kind === 'ready' && (funds.kind === 'unknown' || noXbzz)));
  // What decides the primary action is settled: the price is read (or failed), and the wallet is
  // not connected, or its balance is read (or failed).
  const inputsSettled = choiceSettled({ price: price.kind, account: wallet.address, funds, walletChecked, hasProvider: wallet.hasProvider });
  const [checkCapped, setCheckCapped] = useState(false);
  // The order of the two buttons, fixed once the inputs settle (later changes only move the
  // primary styling): until then the choice reads "Checking storage options…" and has no button.
  const [storageChoice, setStorageChoice] = useState<{ freeFirst: boolean } | null>(null);
  if (needsBuy && storageChoice === null && (inputsSettled || checkCapped)) setStorageChoice({ freeFirst });
  useEffect(() => {
    if (!needsBuy || storageChoice) return;
    const t = setTimeout(() => setCheckCapped(true), CHECK_CAP_MS);
    return () => clearTimeout(t);
  }, [needsBuy, storageChoice]);

  const run = useCallback(
    async (what: 'connect' | 'switch' | 'publish', readyArg?: Ready) => {
      const r = readyArg ?? (load.phase === 'ready' ? load : null);
      if (!r || !captureId) return;
      // A capture is published only with an uploaded reference that passed its check here,
      // and one with a repository snapshot only once the uploaded code passed its check too.
      if (what === 'publish' && r.pending.kind === 'capture' && (!r.stored || (r.repo && !r.stored.code))) return;
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
            if (args.method === 'eth_sendTransaction') {
              txSent.current = true;
              setPublish({ state: 'publishing' });
            }
            return res;
          },
        });
        const w = arkivWallet(cfg, watched, { address, type: 'json-rpc' } as unknown as Account);
        // Already written by this account (a failure after sending, a reload)? Reuse it.
        setPublish({ state: 'looking' });
        const existing = await existingRecord(r, address);
        if (!existing) setPublish({ state: 'signing' });
        const { pending, facts, bytes, stored } = r;
        const captureRow = () => ({
          urlHash: facts.urlHash,
          bodySha256: facts.bodySha256,
          serverName: facts.serverName,
          witness: facts.witness,
          signedAt: facts.signedAt,
          httpStatus: facts.httpStatus,
          batchId: stored!.batchId,
          evidenceRef: stored!.evidenceRef,
          canonicalUrl: facts.canonicalUrl,
        });
        // R46: the capture and its code record in one transaction (one MetaMask prompt). After a
        // partial failure the capture exists already: only the code record is written then.
        const attachment = pending.kind === 'capture' ? attachmentRowOf(r) : null;
        let attachmentKey: Hex | undefined;
        if (attachment) {
          let captureKey: Hex;
          if (existing) {
            captureKey = existing;
            const had = await existingAttachment(existing, address, attachment);
            if (had) attachmentKey = had;
            else {
              setPublish({ state: 'signing' });
              attachmentKey = (await writeAttachment(w, { ...attachment, parentCaptureKey: existing })).entityKey;
            }
          } else {
            const both = await writeCaptureWithAttachment(w, cfg, captureRow(), attachment);
            captureKey = both.captureKey;
            attachmentKey = both.attachmentKey;
          }
          const [markError, until] = await Promise.all([markPublished(captureId, captureKey, extensionId), recordUntil(captureKey)]);
          setPublish({ state: 'published', entityKey: captureKey, attachmentKey, until, ...(markError ? { markError } : {}) });
          return;
        }
        const { entityKey } = existing
          ? { entityKey: existing }
          : pending.kind === 'capture'
            ? await writeCapture(w, captureRow())
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
        else if (/another key than predicted/i.test(String((e as Error)?.message ?? e))) {
          // R46: another record from this account landed in the same moment, so the code record
          // names no capture. Retrying reuses the capture and writes only the code record.
          setPublish({
            state: 'failed',
            reason: 'Another record from this account was written at the same moment, so the code record must be written again. Try again: the capture is kept',
            technical: errorText(e),
          });
        } else if (isLikelyNetworkFailure(e)) {
          // A timeout or a dropped connection, not a refusal: say so, and say what is true about the record.
          setPublish({ state: 'failed', reason: sentence(reasonOf(e)), technical: errorText(e), network: { sent: txSent.current } });
        } else setPublish({ state: 'failed', reason: sentence(reasonOf(e)), technical: errorText(e) });
      }
    },
    [load, captureId, connected, arkivId, cfg, extensionId],
  );

  /** What the extension says now about storage and the upload (never the evidence: that was checked). */
  const refreshOffer = useCallback(async (): Promise<PendingRecord['storage']> => {
    if (!captureId) return undefined;
    try {
      const a = await ext.send<PendingRecord>({ type: 'recall.getPending', captureId }, extOpts);
      setLoad((l) =>
        l.phase === 'ready' && !l.stored
          ? { ...l, pending: { ...l.pending, storage: a.storage, uploadMode: a.uploadMode, upload: a.upload } }
          : l,
      );
      return a.storage;
    } catch {
      return undefined; // keep what is shown
    }
  }, [captureId, extOpts]);

  /**
   * One tab at a time stores and publishes this capture (Web Locks, this origin): a second tab
   * for the same capture can neither buy, upload nor publish while the first one works.
   */
  const exclusive = useCallback(
    async (fn: () => Promise<unknown>): Promise<void> => {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (!locks || !captureId) {
        await fn();
        return;
      }
      await locks.request(`recall.publish.${captureId}`, { ifAvailable: true }, async (lock) => {
        setOtherTab(lock === null);
        if (lock) await fn();
      });
    },
    [captureId],
  );

  /** Follows the extension's upload until the evidence is on Swarm, then checks its reference here. */
  const followUpload = useCallback(
    async (r: Ready, how: SaveHow): Promise<Ready | null> => {
      setSave({ state: 'uploading', how });
      const wait = r.repo ? UPLOAD_WAIT_CODE_MS : UPLOAD_WAIT_MS;
      let deadline = Date.now() + wait;
      let lastDone = -1;
      let up: { evidenceRef: Hex; batchId: Hex; attachmentRef?: Hex } | null = null;
      while (!up) {
        const a = await ext.send<PendingRecord>({ type: 'recall.getPending', captureId }, extOpts);
        const u = a.upload;
        // An upload that is still moving is not timed out.
        if (u?.status === 'uploading' && u.progress && u.progress.done > lastDone) {
          lastDone = u.progress.done;
          deadline = Math.max(deadline, Date.now() + wait);
        }
        if (u?.status === 'uploaded') up = u;
        else if (u?.status === 'failed') throw new Error(u.reason);
        else if (!u || u.status === 'none') throw new Error('the upload did not start');
        else if (Date.now() > deadline) throw new Error('the upload did not finish in time');
        else await sleep(1_500);
      }
      setSave({ state: 'checking', how });
      let lastPaint = 0;
      const stored = await checkStored(
        up,
        r.bytes,
        (step) =>
          (step === CODE_STEP || step.startsWith(CODE_WAITING)) &&
          setSave({
            state: 'checking',
            how,
            code: { received: 0, total: r.repo?.summary.size ?? null, ...(step === CODE_STEP ? {} : { note: step }) },
          }),
        r.repo,
        (received, total) => {
          // A new try starts again from 0.
          if (received >= lastPaint && received - lastPaint < 256 * 1024 && received !== total) return;
          lastPaint = received;
          setSave({ state: 'checking', how, code: { received, total: total ?? r.repo?.summary.size ?? null } });
        },
      );
      // A download that failed is "try again" (the upload is idempotent), not a refusal.
      if ('reason' in stored && stored.retry) throw new Error(stored.reason);
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

  const codeSize = ready?.repo?.summary.size;
  const uploadFailed = useCallback((how: SaveHow, e: unknown): Save => {
    const why = sentence(reasonOf(e));
    // A slow or dropped connection comes first: whatever the storage, the way forward is the same.
    if (isLikelyNetworkFailure(e)) {
      return { state: 'error', how, stage: 'upload', ...UPLOAD_NETWORK_COPY, technical: errorText(e) };
    }
    // The gateway's free storage may refuse a big file (a repository snapshot is up to 25 MB):
    // say so and point at paid storage. The person decides; nothing retries by itself.
    if (how === 'free' && (codeSize !== undefined || /\b413\b|too (large|big)|payload|size limit|limit/i.test(why))) {
      return {
        state: 'error',
        how,
        stage: 'upload',
        title: 'Free storage did not take this',
        body:
          codeSize !== undefined
            ? `${why}. The public gateway may refuse a free upload as big as this code snapshot (${formatBytes(codeSize)}). Nothing is lost: buy storage to publish it, or try free storage once more.`
            : `${why}. The public gateway may limit the size of a free upload. Nothing is lost: buy storage to publish it, or try free storage once more.`,
        retryLabel: 'Try free storage again',
      };
    }
    return {
      state: 'error',
      how,
      stage: 'upload',
      title: 'Upload failed',
      body: `${why}. Your capture is kept in the extension, so nothing is lost: try the upload again.`,
      retryLabel: 'Try upload again',
    };
  }, [codeSize]);

  // Back on this page while an upload runs (a reload), or after one failed: follow it, or say so.
  useEffect(() => {
    if (!ready || ready.pending.kind !== 'capture' || ready.stored || followed.current) return;
    const u = ready.pending.upload;
    if (u?.status === 'uploading') {
      followed.current = true;
      const how: SaveHow = u.mode === 'free' ? 'free' : 'stamped';
      void exclusive(() =>
        followUpload(ready, how)
          .then((next) => {
            if (next && next.stored?.gatewayCopy !== 'unavailable') return run('publish', next);
          })
          .catch((e) => {
            setSave(uploadFailed(how, e));
            void refreshOffer();
          }),
      );
    } else if (u?.status === 'failed') {
      followed.current = true;
      // An error already shown here (this tab's own attempt) stays as it is.
      setSave((now) => (now.state === 'error' ? now : uploadFailed(u.mode === 'free' ? 'free' : 'stamped', new Error(u.reason))));
    }
  }, [ready, followUpload, run, uploadFailed, refreshOffer, exclusive]);

  /**
   * Buys one batch for the extension's stamp key, hands it to the extension at once, then waits
   * until Bee takes stamps for it. A purchase sent before (a lost receipt, a reload, this tab closed
   * and opened again) is looked up first and never bought again: its hash is kept per capture in
   * localStorage until the extension holds the batch.
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
    const earlier = recallSent(key, true);
    if (earlier) {
      setSave({ state: 'buying', how: 'buy', step: 'checking' });
      const found = await settlePurchase(gnosisPub, earlier, owner, buyDepth);
      if (found.kind === 'unknown') return mayHaveGone(earlier);
      if (found.kind === 'bought') {
        batchId = found.batchId;
        setBuyTx(earlier);
      } else forgetSent(key); // it bought nothing: buy below
    }
    if (!batchId) {
      // Only at a price read just now: the purchase may cost at most 10% more than shown.
      if (price.kind !== 'ready') {
        setPriceTry((n) => n + 1);
        return stop('Storage price not read yet', 'Recall reads the price before it buys anything. Wait a moment, then try again. Nothing was bought.');
      }
      setSave({ state: 'buying', how: 'buy', step: 'wallet' });
      let w: ReturnType<typeof walletFor>;
      try {
        const { address } = await connectWallet();
        await ensureChain(100);
        const need = await costFor(gnosisPub, buyDepth, BUY_DAYS);
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
      let sentTx: Hex | null = null;
      const r = await buyOneBatch(w, gnosisPub, {
        owner,
        days: BUY_DAYS,
        depth: buyDepth,
        quotedTotal: price.perBatch,
        sentKey: key,
        durable: true,
        onSent: (txHash) => {
          sentTx = txHash;
        },
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
      setBuyTx(sentTx);
    }
    // Handed over at once: from now on the extension holds it, so a reopened tab offers
    // "Upload and publish", never a second purchase.
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
    // Bee takes stamps a little after creation (the extension also waits before it uploads).
    setSave({ state: 'buying', how: 'buy', step: 'waiting' });
    await waitBatchUsable(cfg.swarm.uploadUrl, batchId, USABLE_TIMEOUT_MS, { chain: gnosisPub }).catch(() => undefined);
    return true;
  };

  /** The storage ran out: back to the choice (buy, or free storage), never an upload loop. */
  const backToOffer = () => {
    setSave({ state: 'idle' });
    setOfferNote('Your extension has no storage left for this capture. Buy storage, or use free storage.');
  };

  /** Path (b): store the evidence (buying a batch first when asked), then publish. One tab at a time. */
  const saveAndPublish = (how: SaveHow, confirmedOwner?: Address) =>
    exclusive(async () => {
      if (!ready || !captureId || ready.pending.kind !== 'capture' || ready.stored) return;
      setPublish({ state: 'idle' });
      setSave({ state: 'idle' });
      setOfferNote(null);
      if (how === 'buy' && !(await buyStorage(confirmedOwner))) return;
      try {
        // Nothing is uploaded before this request: the extension starts it once, whatever the clicks.
        await ext.send({ type: 'recall.uploadPending', captureId, mode: how === 'free' ? 'free' : 'stamped' }, { timeoutMs: 15_000, ...extOpts });
        const next = await followUpload(ready, how);
        // A stored copy the gateways did not confirm is shown first; the person publishes from there.
        if (next && next.stored?.gatewayCopy !== 'unavailable') await run('publish', next);
      } catch (e) {
        const storage = await refreshOffer();
        if (how !== 'free' && /no storage batch/i.test(reasonOf(e)) && storage !== 'ok') backToOffer();
        else setSave(uploadFailed(how, e));
      }
    });
  /** Publishes (connect, switch, write) under the same one-tab lock. */
  const publishNow = () => void exclusive(() => run('publish'));

  const startBuy = () => {
    setSave({ state: 'idle' });
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
  /**
   * "Try again" after a failure, with the storage chosen before: a failed purchase buys (looking up
   * the earlier one first), free storage uploads free again, and an upload with the extension's
   * storage uploads again only while a batch is there; else the page goes back to the choice.
   */
  const retrySave = async () => {
    if (save.state !== 'error') return;
    const { how, stage } = save;
    if (stage === 'buy') return startBuy();
    if (how === 'free') return void saveAndPublish('free');
    setSave({ state: 'idle' });
    if ((await refreshOffer()) === 'ok') void saveAndPublish('stamped');
    else backToOffer();
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
          ? load.what === 'code'
            ? 'capture'
            : 'confirmation'
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
            : load.what === 'code'
              ? 'The uploaded code could not be downloaded, so it was not checked yet and nothing was published. Your capture is still pending in the extension.'
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
  const published = publish.state === 'published';
  // "Check it yourself" once published: the records in the Arkiv explorer and, when this page
  // bought the storage, its payment on Gnosisscan (live only: the devnet has no explorers).
  const recordUrl = publish.state === 'published' ? arkivEntityUrl(cfg, publish.entityKey) : null;
  const codeRecordUrl = publish.state === 'published' ? arkivEntityUrl(cfg, publish.attachmentKey) : null;
  const buyTxUrl = published ? gnosisTxUrl(cfg, buyTx) : null;
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
    const checkingCode = save.state === 'checking' && save.code !== undefined;
    steps.push({
      label: how === 'free' ? 'Upload to free storage' : load.repo ? 'Upload the evidence and the code' : 'Upload the evidence',
      state: load.stored ? 'done' : (save.state === 'uploading' || save.state === 'checking') && !checkingCode ? 'active' : upFailed ? 'failed' : checkingCode ? 'done' : 'waiting',
    });
    if (load.repo) {
      steps.push({ label: 'Check the uploaded code', state: load.stored?.code ? 'done' : checkingCode ? 'active' : 'waiting' });
    }
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
      label: isConfirmation ? 'Publish the confirmation' : load.repo ? 'Publish the capture and code records' : 'Publish the record',
      state: published
        ? 'done'
        : !atPublish || !onArkiv
          ? 'waiting'
          : publish.state === 'rejected' || publish.state === 'failed'
            ? 'failed'
            : 'active',
    },
  );

  // Buying is paused while the price (or the balance of a connected wallet) is being read, or
  // when the price can't be read.
  const buyBlocked = !needsBuy
    ? undefined
    : price.kind === 'loading'
      ? 'Reading the storage price…'
      : price.kind === 'error'
        ? 'The storage price could not be read, so buying is paused.'
        : funds.kind === 'loading'
          ? 'Checking your xBZZ balance…'
          : undefined;
  const checking = needsBuy && !storageChoice && !busy;
  // One primary action at a time: after a rejection or failure the notice's "Try again" is it.
  let primary: { label: string; onClick: () => void; blocked?: string } | null = null;
  if (!published && publish.state !== 'rejected' && publish.state !== 'failed' && save.state !== 'error' && extAsk.state !== 'ask') {
    if (isConfirmation) primary = { label: "Confirm it's still the same", onClick: publishNow };
    else if (!needsStorage) primary = { label: 'Publish record', onClick: publishNow };
    else if (hasBatch) primary = { label: 'Upload and publish', onClick: () => void saveAndPublish('stamped') };
    else if (freeFirst) primary = { label: 'Use free storage instead', onClick: () => void saveAndPublish('free') };
    else {
      primary = {
        label: 'Buy storage and publish',
        onClick: startBuy,
        ...(buyBlocked ? { blocked: buyBlocked } : {}),
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
          ? save.code?.note
            ? save.code.note
            : save.code
            ? `Checking the uploaded code${save.code.received > 0 ? ` (${(save.code.received / 1024 / 1024).toFixed(1)}${save.code.total ? ` of ${(save.code.total / 1024 / 1024).toFixed(1)}` : ''} MB)` : ''}…`
            : 'Checking the upload…'
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
  const helper = checking
    ? 'Reading the storage price and your xBZZ balance…'
    : primary?.blocked
    ? primary.blocked
    : freeFirst && !hasBatch
      ? `${
          noXbzz
            ? 'You have no xBZZ for paid storage.'
            : price.kind === 'error'
              ? "The storage price couldn't be read, so paid storage is paused."
              : "Your xBZZ balance isn't known yet (connect MetaMask to check it)."
        } ${FREE_NOTE}`
      : isConfirmation
      ? `No upload is needed. MetaMask will show the network fee. The record lasts ${RECORD_DAYS} days; anyone can extend it.`
      : needsStorage && hasBatch
        ? 'The extension uploads the evidence with your storage, then MetaMask publishes the record.'
        : needsStorage && load.repo
          ? `One storage batch for ${BUY_DAYS} days, big enough for the code (depth ${buyDepth})${price.kind === 'ready' ? `: about ${formatBzzCeil(price.perBatch)} xBZZ` : ''}, paid in MetaMask on Gnosis. Then the extension uploads the evidence and the code, this page checks the code, and MetaMask publishes both records.`
        : needsStorage
          ? `One storage batch for ${BUY_DAYS} days${price.kind === 'ready' ? `: about ${formatBzzCeil(price.perBatch)} xBZZ` : ''}, paid in MetaMask on Gnosis. Then the extension uploads the evidence and MetaMask publishes the record.`
          : `MetaMask will show the network fee. The record lasts ${RECORD_DAYS} days; anyone can extend it.`;

  return (
    <div className="approve" data-kind={pending.kind}>
      <h1 tabIndex={-1}>{heading}</h1>
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
        {/* The witness itself is in the exhibit below, and whether you trust it is check C. */}
        <WhyWitness />
      </section>

      {load.repo ? (
        <section className="approve-repo" aria-labelledby="repo-title" data-checked={load.stored?.code ? 'true' : 'false'}>
          <h2 id="repo-title" className="section-title">
            Repository {load.repo.branch.owner}/{load.repo.branch.repo} @ <CommitId sha={load.repo.branch.commitSha} />
            {/* Claimed only once this browser has checked the uploaded code. */}
            {load.stored?.code ? ': the code matches the commit GitHub reported' : null}
          </h2>
          <p>
            Recall notarized GitHub&apos;s answer for branch <span className="mono">{load.repo.branch.branch}</span>. The code is that
            commit&apos;s snapshot ({load.repo.summary.files.toLocaleString('en')} files, {formatBytes(load.repo.summary.size)}); it is stored
            next to the evidence and checked by its git tree hash.
          </p>
          <p>
            {load.stored?.code ? (
              <StatusBadge status="pass" label="Uploaded code checked in this browser" />
            ) : (
              <StatusBadge status="unavailable" label="Checked by the extension; checked again here after the upload" />
            )}
          </p>
        </section>
      ) : null}

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
          {offerNote ? (
            <Notice kind="info" title="Choose the storage again" focus>
              {offerNote}
            </Notice>
          ) : null}
        </section>
      ) : null}

      <CheckSummary report={report} />
      <ExhibitCard
        facts={facts}
        unverified={report.C.status !== 'pass'}
        {...(load.stored ? { evidenceRef: load.stored.evidenceRef } : {})}
      />

      {load.stored?.gatewayCopy === 'unavailable' && !published ? (
        <Notice kind="warn" title="Stored copy not confirmed">
          The download gateway didn&apos;t return this evidence under its Swarm reference, so Recall couldn&apos;t confirm that the stored
          copy is the same file. You can still publish. Open the capture afterwards to check it.
        </Notice>
      ) : null}

      {/* The side panel: what is happening now (published, the steps, the questions and errors, the
          actions). Desktop keeps it in view beside the record; phones show it in the page flow. */}
      <aside className="approve-side" aria-label={isConfirmation ? 'Confirm on Arkiv' : 'Save and publish'}>
      {publish.state === 'published' ? (
        <Notice
          kind="success"
          title="Published"
          focus
          actions={
            <>
              <a className="btn btn-primary" href={timelineHref}>
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
            {publish.attachmentKey ? 'Capture record' : 'Record'} <MonoValue value={publish.entityKey} />
            {recordUrl ? (
              <OutsideLink after href={recordUrl}>
                View on Arkiv explorer
              </OutsideLink>
            ) : null}
          </span>
          {publish.attachmentKey ? (
            <span className="approve-record">
              Code record <MonoValue value={publish.attachmentKey} />
              {codeRecordUrl ? (
                <OutsideLink after href={codeRecordUrl}>
                  View on Arkiv explorer
                </OutsideLink>
              ) : null}
            </span>
          ) : null}
          {buyTxUrl ? (
            <span className="approve-record">
              <OutsideLink href={buyTxUrl}>Storage payment on Gnosisscan</OutsideLink>
            </span>
          ) : null}
          {publish.markError ? (
            <span className="approve-record">
              The extension could not be told, so it still lists this capture as pending.
              <TechnicalDetails text={publish.markError} />
            </span>
          ) : null}
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
      {otherTab ? (
        <Notice kind="warn" title="Open in another tab" focus>
          This capture is being saved or published in another Recall tab. Finish there, or close that tab and try again here.
        </Notice>
      ) : null}
      {save.state === 'error' ? (
        <Notice
          kind="error"
          title={save.title}
          focus
          actions={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => void retrySave()}>
                {save.retryLabel}
              </button>
              {/* Every way out stays open: buy storage, free storage (when allowed), discard. */}
              {save.stage !== 'buy' && !hasBatch ? (
                <button type="button" className="btn btn-secondary" onClick={startBuy}>
                  Buy storage
                </button>
              ) : null}
              {freeAllowed && save.how !== 'free' ? (
                <button type="button" className="btn btn-secondary" onClick={() => void saveAndPublish('free')}>
                  Use free storage
                </button>
              ) : null}
              {save.how === 'free' && hasBatch ? (
                <button type="button" className="btn btn-secondary" onClick={() => void saveAndPublish('stamped')}>
                  Use my storage
                </button>
              ) : null}
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
              <button type="button" className="btn btn-secondary" onClick={publishNow}>
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
          kind={publish.network ? 'warn' : 'error'}
          title={publish.network ? publishNetworkCopy(publish.network.sent).title : 'Publishing failed'}
          focus
          actions={
            <button type="button" className="btn btn-secondary" onClick={publishNow}>
              Try again
            </button>
          }
        >
          {publish.network ? publishNetworkCopy(publish.network.sent).body : `${publish.reason}. Your capture is still pending.`}
          {publish.technical ? <TechnicalDetails text={publish.technical} /> : null}
        </Notice>
      ) : null}
      {primary ? (
        <div className="approve-bar">
          {needsBuy && !busy ? (
            // Two buttons in fixed places with fixed labels once the inputs settle; only the
            // primary styling (and the helper line) can change afterwards.
            <div className="approve-choices" data-state={storageChoice ? 'ready' : 'checking'}>
              {storageChoice ? (
                (storageChoice.freeFirst ? ['free', 'buy'] : ['buy', 'free']).map((which) =>
                  which === 'buy' ? (
                    <button
                      key="buy"
                      type="button"
                      className={`btn btn-wide ${freeFirst ? 'btn-secondary' : 'btn-primary'}`}
                      disabled={buyBlocked !== undefined || !getProvider()}
                      onClick={startBuy}
                    >
                      Buy storage and publish
                    </button>
                  ) : (
                    <button
                      key="free"
                      type="button"
                      className={`btn btn-wide ${freeFirst ? 'btn-primary' : 'btn-secondary'}`}
                      disabled={!getProvider()}
                      onClick={() => void saveAndPublish('free')}
                    >
                      Use free storage instead
                    </button>
                  ),
                )
              ) : (
                <p className="approve-checking" role="status">
                  <LoaderCircle size={16} strokeWidth={1.75} aria-hidden="true" className="spin" />
                  Checking storage options…
                </p>
              )}
            </div>
          ) : (
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
          )}
          <p className={needsBuy ? 'field-helper approve-helper-reserve' : 'field-helper'} aria-live="polite">
            {helper}
          </p>
          {needsBuy && !busy && storageChoice ? (
            // Tertiary: buying ahead on the Storage page makes later captures one confirmation.
            // Same tab; the capture stays pending in the extension ("Open Recall tab" reopens it).
            <a className="approve-storage-link" href={`#/storage${extensionId ? `?ext=${extensionId}` : ''}`}>
              Buy storage once in Storage, then each capture needs one confirmation
            </a>
          ) : null}
          {!busy ? (
            <div className="approve-more">
              {isConfirmation && load.earlier ? (
                <a className="btn btn-secondary" href={`#/c/${load.earlier.key}`}>
                  Keep the earlier capture alive…
                </a>
              ) : null}
              {needsStorage && hasBatch ? (
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
          {!busy && needsStorage && freeAllowed && !freeFirst && !checking ? <p className="field-helper">{FREE_NOTE}</p> : null}
        </div>
      ) : null}
      </aside>
      {discardDialog(pending.kind)}
    </div>
  );
}
