// The capture job (service worker side): one capture at a time, run by the offscreen
// document. Its state lives in chrome.storage.session, so the popup can close and
// reopen while the capture keeps running. After the checks, a capture that may be
// uploaded is compared with the page's newest verified capture: the same bytes become a
// confirmation (evidence inline in the Arkiv record, no upload); anything else is stamped
// with one pool batch and uploaded to Swarm (also in offscreen). Either way the web app's
// approval tab then opens, where MetaMask publishes the Arkiv record.
import { encodeEvidence, runChecks, urlHash, type CheckReport, type EvidenceFile } from '@recall/evidence';
import type { Hex } from 'viem';
import { RECALL_DEV } from './build';
import { loadSettings, netConfigFor } from './settings';
import { ensureOffscreen } from './offscreen';
import { applyBatchUpdates, loadPool } from './pool';
import { unusedBatches } from './poolState';
import { stampKey } from './stamp';
import { newCaptureId, savePending } from './pending';
import { latestVerifiedCapture, openApproveTab, resolveWitness } from './lookup';
import {
  USABLE_WAIT_MS,
  canonicalEvidence,
  uploadGate,
  type OffscreenUpload,
  type UploadOutcome,
} from './uploadParts';
import {
  MAX_RECV_DATA,
  withTimeout,
  type CaptureErrorCode,
  type CaptureOutcome,
  type CaptureOverrides,
  type CaptureStep,
} from './captureParts';
import type { OffscreenCancel, OffscreenCapture } from './messages';
import {
  CAPTURE_STATE_KEY,
  isLiveRunning,
  type CaptureBase as Base,
  type CaptureState,
  type CheckSummary,
  type FinalState,
  type UploadState,
} from './jobState';

export { CAPTURE_STATE_KEY, STALE_AFTER_MS } from './jobState';
export type { CaptureState, CheckSummary, FinalState, UploadState } from './jobState';

/** How long checks A-C may take in the service worker (they normally take milliseconds). */
export const CHECKS_TIMEOUT_MS = 15_000;

export function summarizeChecks(r: CheckReport): CheckSummary {
  const s: CheckSummary = { A: r.A, B: r.B, C: r.C };
  if (r.facts) {
    const f = r.facts;
    s.facts = {
      canonicalUrl: f.canonicalUrl,
      serverName: f.serverName,
      httpStatus: f.httpStatus,
      ...(f.contentType !== undefined ? { contentType: f.contentType } : {}),
      signedAt: f.signedAt.toString(10),
      witness: f.witness,
      bodySha256: f.bodySha256,
      bodySize: f.body.length,
    };
  }
  return s;
}

const area = () => chrome.storage.session;

export async function readCaptureState(): Promise<CaptureState | undefined> {
  return (await area().get(CAPTURE_STATE_KEY))[CAPTURE_STATE_KEY] as CaptureState | undefined;
}

const isLive = (s: CaptureState | undefined) => isLiveRunning(s, Date.now());

// Every read-modify-write of the state runs in this chain, so a late step message
// can never overwrite a finished capture.
let chain: Promise<unknown> = Promise.resolve();
function update<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

const waiters = new Map<string, ((s: FinalState) => void)[]>();

function settle(s: FinalState): void {
  const list = waiters.get(s.id) ?? [];
  waiters.delete(s.id);
  list.forEach((resolve) => resolve(s));
}

async function finish(s: FinalState): Promise<FinalState> {
  await area().set({ [CAPTURE_STATE_KEY]: s });
  settle(s);
  return s;
}

function failure(base: Base, error: string, code: CaptureErrorCode, size?: number): FinalState {
  return {
    ...base,
    status: 'error',
    finishedAt: Date.now(),
    error,
    code,
    ...(size !== undefined ? { size } : {}),
  };
}

/** Sends to the offscreen document, retrying briefly while a new document is still loading. */
async function sendToOffscreen(
  msg: OffscreenCapture | OffscreenUpload,
): Promise<{ accepted?: boolean } | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await chrome.runtime.sendMessage(msg)) as { accepted?: boolean } | undefined;
    } catch (err) {
      if (attempt >= 20 || !/receiving end does not exist/i.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/**
 * Starts a capture of `url`. Overrides are honoured by dev builds only. The witness URL is
 * the one the popup found online (announced on Arkiv by the pinned witness, else settings).
 */
export async function startCapture(
  url: string,
  overrides?: CaptureOverrides,
): Promise<{ id: string } | { error: string }> {
  // A failed lookup (offscreen document or Arkiv down) falls back to the settings URL.
  const witness = await resolveWitness().catch(async () => ({ url: (await loadSettings()).witnessUrl }));
  return update(async () => {
    if (isLive(await readCaptureState())) return { error: 'A capture is already running.' };
    const base: Base = { id: crypto.randomUUID(), url, startedAt: Date.now() };
    const witnessUrl = witness?.url;
    if (!witnessUrl) {
      await finish(failure(base, 'no witness address is set', 'witness_offline'));
      return { id: base.id };
    }
    // With no batch in the pool the capture is still proved and checked, but not uploaded.
    const uploadPlanned = unusedBatches(await loadPool()).length > 0;
    await area().set({
      [CAPTURE_STATE_KEY]: {
        ...base,
        status: 'running',
        step: 1,
        uploadPlanned,
      } satisfies CaptureState,
    });
    try {
      await ensureOffscreen();
      const msg: OffscreenCapture = {
        type: 'recall.offscreen.capture',
        id: base.id,
        url,
        witnessUrl,
        maxRecvData: MAX_RECV_DATA,
        ...(RECALL_DEV && overrides ? { overrides } : {}),
      };
      const ack = await sendToOffscreen(msg);
      if (!ack?.accepted) throw new Error('the prover did not start');
    } catch (err) {
      await finish(failure(base, err instanceof Error ? err.message : String(err), 'failed'));
    }
    return { id: base.id };
  });
}

/** Offscreen progress. Ignored unless it belongs to the running capture. */
export function onCaptureStep(id: string, step: CaptureStep): Promise<void> {
  return update(async () => {
    const s = await readCaptureState();
    if (s?.status === 'running' && s.id === id && step > s.step) {
      await area().set({
        [CAPTURE_STATE_KEY]: { ...s, step, stepAt: Date.now() } satisfies CaptureState,
      });
    }
  });
}

/**
 * Offscreen result: run checks A-C on fresh evidence; then (outside the state chain, so a
 * cancel is never held up by the network) the same-page check, which ends in a confirmation
 * or an upload. A capture the checks refused is stored as final at once.
 */
export async function onCaptureResult(id: string, outcome: CaptureOutcome): Promise<void> {
  const next = await checkCapture(id, outcome);
  if (next) await afterChecks(id, next.evidence, next.checks);
}

function checkCapture(
  id: string,
  outcome: CaptureOutcome,
): Promise<{ evidence: EvidenceFile; checks: CheckSummary } | undefined> {
  return update(async () => {
    const s = await readCaptureState();
    if (s?.status !== 'running' || s.id !== id || s.step > 3 || s.evidence) return; // cancelled or superseded
    const base: Base = { id: s.id, url: s.url, startedAt: s.startedAt };
    if ('evidence' in outcome) {
      await area().set({
        [CAPTURE_STATE_KEY]: { ...s, step: 3, stepAt: Date.now() } satisfies CaptureState,
      });
      // The canonical form is what gets checked, uploaded and kept (see canonicalEvidence).
      let evidence: EvidenceFile;
      let checks: CheckSummary;
      try {
        evidence = canonicalEvidence(outcome.evidence);
        const { pinnedWitnesses } = await loadSettings();
        // Bounded: a hung check must not leave the job "running" and block later captures.
        const report = await withTimeout(
          runChecks(evidence, { pinnedWitnesses }),
          CHECKS_TIMEOUT_MS,
          `the checks did not finish within ${CHECKS_TIMEOUT_MS / 1000} s`,
        );
        checks = summarizeChecks(report);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        await finish(failure(base, `the evidence could not be checked: ${why}`, 'failed'));
        return;
      }
      const gate = uploadGate(checks, base.url);
      if (!gate.ok) {
        await finishDone(base, evidence, checks, { status: 'skipped', reason: gate.reason });
        return undefined;
      }
      // Still step 3: the same-page check runs next. Storing the checked capture marks it.
      await area().set({
        [CAPTURE_STATE_KEY]: { ...s, step: 3, stepAt: Date.now(), evidence, checks } satisfies CaptureState,
      });
      return { evidence, checks };
    } else if (outcome.code === 'cancelled') {
      await finish({ ...base, status: 'cancelled', finishedAt: Date.now() });
    } else {
      await finish(failure(base, outcome.error, outcome.code, outcome.size));
    }
    return undefined;
  });
}

/** Evidence inline in an Arkiv record must stay within this size (spec 3.2). */
export const INLINE_EVIDENCE_MAX = 128 * 1024;

/**
 * The same-page check (security, R10). The newest VERIFIED capture of this page (its
 * evidence downloaded and checked A-C with a pinned witness, its record matching the
 * evidence) with the same bytes makes this capture a confirmation; a record that merely
 * claims the same bytes counts for nothing. Anything unknown (no pinned witness, a listing
 * cut short, Arkiv or Swarm unreachable) leads to an upload.
 */
async function sameAsLatest(evidence: EvidenceFile, checks: CheckSummary): Promise<{ captureKey: Hex; since: string } | null> {
  const f = checks.facts;
  if (!f || encodeEvidence(evidence).length > INLINE_EVIDENCE_MAX) return null;
  const latest = await latestVerifiedCapture(urlHash(f.canonicalUrl));
  if (!latest || latest.bodySha256.toLowerCase() !== f.bodySha256.toLowerCase()) return null;
  if (BigInt(latest.signedAt) >= BigInt(f.signedAt)) return null;
  return { captureKey: latest.entityKey, since: latest.signedAt };
}

async function afterChecks(id: string, evidence: EvidenceFile, checks: CheckSummary): Promise<void> {
  const same = await sameAsLatest(evidence, checks).catch(() => null);
  let opened: string | undefined;
  await update(async () => {
    const s = await readCaptureState();
    if (s?.status !== 'running' || s.id !== id || s.step !== 3 || !s.evidence) return; // cancelled
    const base: Base = { id: s.id, url: s.url, startedAt: s.startedAt };
    if (!same || !checks.facts) {
      await beginUpload(base, evidence, checks);
      return;
    }
    try {
      const captureId = newCaptureId();
      await savePending({
        captureId,
        kind: 'confirmation',
        evidence: canonicalEvidence(evidence),
        captureKey: same.captureKey,
        bodySha256: checks.facts.bodySha256,
        createdAt: Date.now(),
      });
      await finishDone(base, evidence, checks, {
        status: 'confirmation',
        captureId,
        captureKey: same.captureKey,
        since: same.since,
      });
      opened = captureId;
    } catch (err) {
      // Could not keep the confirmation: upload as a new capture instead.
      console.error('[recall] confirmation could not be kept', errorText(err));
      await beginUpload(base, evidence, checks);
    }
  });
  if (opened) await openApproveTab(opened);
}

function finishDone(
  base: Base,
  evidence: EvidenceFile,
  checks: CheckSummary,
  upload: UploadState,
): Promise<FinalState> {
  return finish({ ...base, status: 'done', finishedAt: Date.now(), evidence, checks, upload });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Step 4: hands the checked evidence, the stamp key and the unused batches to the
 * offscreen document, which picks a usable batch, stamps and uploads. Runs inside the
 * state chain. With an empty pool the capture ends without an upload.
 */
async function beginUpload(
  base: Base,
  evidence: EvidenceFile,
  checks: CheckSummary,
): Promise<void> {
  const candidates = unusedBatches(await loadPool());
  if (candidates.length === 0) {
    await finishDone(base, evidence, checks, { status: 'no_storage' });
    return;
  }
  await area().set({
    [CAPTURE_STATE_KEY]: {
      ...base,
      status: 'running',
      step: 4,
      stepAt: Date.now(),
      uploadPlanned: true,
      evidence,
      checks,
    } satisfies CaptureState,
  });
  try {
    const net = netConfigFor(await loadSettings());
    await ensureOffscreen();
    const msg: OffscreenUpload = {
      type: 'recall.offscreen.upload',
      id: base.id,
      // Already canonical after the checks; a retry reads it back from session storage,
      // whose objects come back with sorted keys, so it is put in canonical form again.
      evidence: canonicalEvidence(evidence),
      stampKey: await stampKey(),
      candidates: candidates.map((b) => ({
        batchId: b.batchId,
        depth: b.depth,
        startBlock: b.startBlock,
        ...(b.stamper ? { stamper: b.stamper } : {}),
      })),
      uploadUrl: net.swarm.uploadUrl,
      gnosisRpcUrl: net.gnosis.rpcUrl,
      waitMs: USABLE_WAIT_MS,
    };
    const ack = await sendToOffscreen(msg);
    if (!ack?.accepted) throw new Error('the uploader did not start');
  } catch (err) {
    await finishDone(base, evidence, checks, { status: 'failed', error: errorText(err) });
  }
}

/**
 * Offscreen upload result. What the attempt learned about each batch is stored whatever
 * became of the job (a stamped slot must never be stamped again); the job finishes only
 * if it is still this upload. Nothing here may leave the job stuck at step 4.
 */
export async function onUploadResult(id: string, outcome: UploadOutcome): Promise<void> {
  let opened: string | undefined;
  await update(async () => {
    try {
      await applyBatchUpdates(outcome.updates ?? []);
    } catch (err) {
      console.error('[recall] pool update failed', errorText(err));
    }
    const s = await readCaptureState();
    if (s?.status !== 'running' || s.id !== id || s.step !== 4 || !s.evidence || !s.checks) return;
    const base: Base = { id: s.id, url: s.url, startedAt: s.startedAt };
    if (!outcome.ok) {
      await finishDone(
        base,
        s.evidence,
        s.checks,
        outcome.code === 'no_storage'
          ? { status: 'no_storage' }
          : {
              status: 'failed',
              error: outcome.error,
              ...(outcome.code === 'not_ready' ? { code: 'not_ready' as const } : {}),
            },
      );
      return;
    }
    try {
      if (!s.checks.facts) throw new Error('the checks gave no verified facts');
      const captureId = newCaptureId();
      await savePending({
        captureId,
        kind: 'capture',
        // The same canonical form that was uploaded (session storage sorted its keys).
        evidence: canonicalEvidence(s.evidence),
        evidenceRef: outcome.evidenceRef,
        batchId: outcome.batchId,
        bodySha256: s.checks.facts.bodySha256,
        createdAt: Date.now(),
      });
      await finishDone(base, s.evidence, s.checks, {
        status: 'uploaded',
        captureId,
        evidenceRef: outcome.evidenceRef,
        batchId: outcome.batchId,
      });
      opened = captureId;
    } catch (err) {
      await finishDone(base, s.evidence, s.checks, {
        status: 'failed',
        error: `the evidence is on Swarm, but the capture could not be kept for publishing: ${errorText(err)}`,
      });
    }
  });
  if (opened) await openApproveTab(opened);
}

/** The popup's "Try again" after a failed upload (or once storage was bought): upload the same capture. */
export function retryUpload(): Promise<{ ok: true } | { error: string }> {
  return update(async () => {
    const s = await readCaptureState();
    if (
      s?.status !== 'done' ||
      (s.upload?.status !== 'failed' && s.upload?.status !== 'no_storage')
    ) {
      return { error: 'there is no capture waiting for an upload' };
    }
    await beginUpload({ id: s.id, url: s.url, startedAt: s.startedAt }, s.evidence, s.checks);
    return { ok: true };
  });
}

/** Cancels the running capture: the popup shows "cancelled" at once, the prover stops soon after. */
export function cancelCapture(): Promise<void> {
  return update(async () => {
    const s = await readCaptureState();
    // Once the upload has started it runs to the end: stamped chunks cannot be taken back.
    if (s?.status !== 'running' || s.step === 4) return;
    await finish({
      id: s.id,
      url: s.url,
      startedAt: s.startedAt,
      status: 'cancelled',
      finishedAt: Date.now(),
    });
    const msg: OffscreenCancel = { type: 'recall.offscreen.cancel', id: s.id };
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  });
}

/** Clears a finished capture (the popup's OK). A running one stays. */
export function dismissCapture(): Promise<void> {
  return update(async () => {
    if (!isLive(await readCaptureState())) await area().remove(CAPTURE_STATE_KEY);
  });
}

/** Resolves when the capture `id` has finished. */
export function waitForCapture(id: string): Promise<FinalState> {
  return new Promise((resolve) => {
    waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
    // It may already be over (registering first, then reading, leaves no gap).
    readCaptureState().then((s) => {
      if (s && s.id === id && s.status !== 'running') settle(s);
    });
  });
}

/** Dev builds: `recall.captureForTest(url, overrides)` for Playwright, through the real job path. */
export async function captureForTest(
  url: string,
  overrides?: CaptureOverrides,
): Promise<
  | { evidence: EvidenceFile; checks: CheckSummary; upload?: UploadState }
  | { error: string; code?: CaptureErrorCode }
> {
  const started = await startCapture(url, overrides);
  if ('error' in started) return started;
  const s = await waitForCapture(started.id);
  if (s.status === 'done') return { evidence: s.evidence, checks: s.checks, upload: s.upload };
  if (s.status === 'cancelled') return { error: 'capture cancelled', code: 'cancelled' };
  return { error: s.error, code: s.code };
}
