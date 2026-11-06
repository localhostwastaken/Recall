// The capture job (service worker side): one capture at a time, run by the offscreen
// document. Its state lives in chrome.storage.session, so the popup can close and
// reopen while the capture keeps running. After the checks, a capture that may be
// published is compared with the page's newest verified capture (the same bytes make it a
// confirmation), then kept as a pending record WITHOUT any upload, and the web app's publish
// tab opens (R44, capture first). There the person chooses: confirm, upload with storage they
// have or buy, or discard; the upload itself is pendingUpload.ts.
import { encodeEvidence, runChecks, urlHash, type CheckReport, type EvidenceFile } from '@recall/evidence';
import type { Hex } from 'viem';
import { RECALL_DEV } from './build';
import { loadSettings } from './settings';
import { ensureOffscreen } from './offscreen';
import { newCaptureId, savePending, type PendingRecord } from './pending';
import { latestVerifiedCapture, openApproveTab, witnessForCapture } from './lookup';
import { canonicalEvidence, uploadGate } from './uploadParts';
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
async function sendToOffscreen(msg: OffscreenCapture): Promise<{ accepted?: boolean } | undefined> {
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
  // Never a witness that failed its signer check (fail closed).
  const witness = await witnessForCapture();
  return update(async () => {
    if (isLive(await readCaptureState())) return { error: 'A capture is already running.' };
    const base: Base = { id: crypto.randomUUID(), url, startedAt: Date.now() };
    const witnessUrl = witness.url;
    if (!witnessUrl) {
      await finish(failure(base, 'no witness address is set', 'witness_offline'));
      return { id: base.id };
    }
    if (!witness.online) {
      await finish(failure(base, 'the witness is offline', 'witness_offline'));
      return { id: base.id };
    }
    // Storage is chosen after the capture, in the publish tab: nothing here depends on the pool.
    const lookupPlanned = (await loadSettings()).pinnedWitnesses.length > 0;
    await area().set({
      [CAPTURE_STATE_KEY]: {
        ...base,
        status: 'running',
        step: 1,
        lookupPlanned,
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
 * cancel is never held up by the network) the same-page check, which ends in a pending
 * confirmation or a pending capture. A capture the checks refused is stored as final at once.
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
        [CAPTURE_STATE_KEY]: {
          ...s,
          step: 3,
          stepAt: Date.now(),
          lookup: s.lookupPlanned === true,
          evidence,
          checks,
        } satisfies CaptureState,
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
 * cut short, Arkiv or Swarm unreachable) makes it a new capture (fails safe toward upload).
 */
async function sameAsLatest(evidence: EvidenceFile, checks: CheckSummary): Promise<{ captureKey: Hex; since: string } | null> {
  const f = checks.facts;
  if (!f || encodeEvidence(evidence).length > INLINE_EVIDENCE_MAX) return null;
  const latest = await latestVerifiedCapture(urlHash(f.canonicalUrl), BigInt(f.signedAt));
  if (!latest || latest.bodySha256.toLowerCase() !== f.bodySha256.toLowerCase()) return null;
  if (BigInt(latest.signedAt) >= BigInt(f.signedAt)) return null;
  return { captureKey: latest.entityKey, since: latest.signedAt };
}

/**
 * Keeps the checked capture as a pending record (no upload) and opens the publish tab. With
 * the same bytes as the newest verified capture it is a confirmation; if that cannot be kept,
 * it is kept as a new capture instead.
 */
async function afterChecks(id: string, evidence: EvidenceFile, checks: CheckSummary): Promise<void> {
  const same = await sameAsLatest(evidence, checks).catch(() => null);
  let opened: string | undefined;
  await update(async () => {
    const s = await readCaptureState();
    if (s?.status !== 'running' || s.id !== id || s.step !== 3 || !s.evidence) return; // cancelled
    const base: Base = { id: s.id, url: s.url, startedAt: s.startedAt };
    const f = checks.facts;
    if (!f) {
      await finishDone(base, evidence, checks, { status: 'skipped', reason: 'the checks gave no verified facts' });
      return;
    }
    const common = {
      evidence: canonicalEvidence(evidence),
      bodySha256: f.bodySha256,
      createdAt: Date.now(),
    };
    if (same) {
      try {
        const captureId = newCaptureId();
        await savePending({ captureId, kind: 'confirmation', captureKey: same.captureKey, since: same.since, ...common });
        await finishDone(base, evidence, checks, {
          status: 'confirmation',
          captureId,
          captureKey: same.captureKey,
          since: same.since,
        });
        opened = captureId;
        return;
      } catch (err) {
        // Could not keep the confirmation: keep it as a new capture instead.
        console.error('[recall] confirmation could not be kept', errorText(err));
      }
    }
    try {
      const captureId = newCaptureId();
      const rec: PendingRecord = { captureId, kind: 'capture', ...common };
      await savePending(rec);
      await finishDone(base, evidence, checks, { status: 'pending', captureId });
      opened = captureId;
    } catch (err) {
      await finishDone(base, evidence, checks, {
        status: 'failed',
        error: `the capture could not be kept for publishing: ${errorText(err)}`,
      });
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

/** Cancels the running capture: the popup shows "cancelled" at once, the prover stops soon after. */
export function cancelCapture(): Promise<void> {
  return update(async () => {
    const s = await readCaptureState();
    if (s?.status !== 'running') return;
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

/**
 * The publish tab published or discarded the pending capture `captureId`: if the popup's result
 * is that capture, clear it, so the popup is idle again instead of offering a publish tab with
 * nothing left to do. Anything else stays.
 */
export function clearFinishedCapture(captureId: string): Promise<void> {
  return update(async () => {
    const s = await readCaptureState();
    const u = s?.status === 'done' ? s.upload : undefined;
    if ((u?.status === 'pending' || u?.status === 'confirmation') && u.captureId === captureId) {
      await area().remove(CAPTURE_STATE_KEY);
    }
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
