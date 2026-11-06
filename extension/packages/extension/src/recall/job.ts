// The capture job (service worker side): one capture at a time, run by the offscreen
// document. Its state lives in chrome.storage.session, so the popup can close and
// reopen while the capture keeps running.
import { runChecks, type CheckReport, type EvidenceFile } from '@recall/evidence';
import { RECALL_DEV } from './build';
import { loadSettings } from './settings';
import { ensureOffscreen } from './offscreen';
import {
  MAX_RECV_DATA,
  type CaptureErrorCode,
  type CaptureOutcome,
  type CaptureOverrides,
  type CaptureStep,
} from './captureParts';
import type { OffscreenCancel, OffscreenCapture } from './messages';
import {
  CAPTURE_STATE_KEY,
  STALE_AFTER_MS,
  type CaptureBase as Base,
  type CaptureState,
  type CheckSummary,
  type FinalState,
} from './jobState';

export { CAPTURE_STATE_KEY, STALE_AFTER_MS } from './jobState';
export type { CaptureState, CheckSummary, FinalState } from './jobState';

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

const isLive = (s: CaptureState | undefined): s is Extract<CaptureState, { status: 'running' }> =>
  s?.status === 'running' && Date.now() - s.startedAt < STALE_AFTER_MS;

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

/** Starts a capture of `url`. Overrides are honoured by dev builds only. */
export function startCapture(
  url: string,
  overrides?: CaptureOverrides,
): Promise<{ id: string } | { error: string }> {
  return update(async () => {
    if (isLive(await readCaptureState())) return { error: 'A capture is already running.' };
    const settings = await loadSettings();
    const base: Base = { id: crypto.randomUUID(), url, startedAt: Date.now() };
    if (!settings.witnessUrl) {
      await finish(failure(base, 'no witness address is set', 'witness_offline'));
      return { id: base.id };
    }
    await area().set({
      [CAPTURE_STATE_KEY]: { ...base, status: 'running', step: 1 } satisfies CaptureState,
    });
    try {
      await ensureOffscreen();
      const msg: OffscreenCapture = {
        type: 'recall.offscreen.capture',
        id: base.id,
        url,
        witnessUrl: settings.witnessUrl,
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
      await area().set({ [CAPTURE_STATE_KEY]: { ...s, step } satisfies CaptureState });
    }
  });
}

/** Offscreen result: run checks A-C on fresh evidence, then store the final state. */
export function onCaptureResult(id: string, outcome: CaptureOutcome): Promise<void> {
  return update(async () => {
    const s = await readCaptureState();
    if (s?.status !== 'running' || s.id !== id) return; // cancelled or superseded
    const base: Base = { id: s.id, url: s.url, startedAt: s.startedAt };
    if ('evidence' in outcome) {
      await area().set({ [CAPTURE_STATE_KEY]: { ...s, step: 3 } satisfies CaptureState });
      try {
        const { pinnedWitnesses } = await loadSettings();
        const report = await runChecks(outcome.evidence, { pinnedWitnesses });
        await finish({
          ...base,
          status: 'done',
          finishedAt: Date.now(),
          evidence: outcome.evidence,
          checks: summarizeChecks(report),
        });
      } catch (err) {
        await finish(failure(base, `the evidence could not be checked: ${String(err)}`, 'failed'));
      }
    } else if (outcome.code === 'cancelled') {
      await finish({ ...base, status: 'cancelled', finishedAt: Date.now() });
    } else {
      await finish(failure(base, outcome.error, outcome.code, outcome.size));
    }
  });
}

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
): Promise<{ evidence: EvidenceFile; checks: CheckSummary } | { error: string; code?: CaptureErrorCode }> {
  const started = await startCapture(url, overrides);
  if ('error' in started) return started;
  const s = await waitForCapture(started.id);
  if (s.status === 'done') return { evidence: s.evidence, checks: s.checks };
  if (s.status === 'cancelled') return { error: 'capture cancelled', code: 'cancelled' };
  return { error: s.error, code: s.code };
}
