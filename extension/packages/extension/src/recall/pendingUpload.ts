// The upload of a pending capture (service worker side, R44 capture first). The publish tab
// starts it with `recall.uploadPending` once the person chose how to store the evidence; the
// offscreen document stamps and uploads it (stamped: one pool batch; free: the gateway's own
// storage). Never before the person chose, never twice: a second request while one runs, or
// after the evidence is on Swarm, only reports the state. A failure keeps the capture, so the
// tab can offer "Try upload again".
import type { Hex } from 'viem';
import { loadSettings, netConfigFor } from './settings';
import { ensureOffscreen } from './offscreen';
import { applyBatchUpdates, loadPool } from './pool';
import { unusedBatches } from './poolState';
import { stampKey } from './stamp';
import { CAPTURE_ID, pendingUploadState, readPending, updatePending, type PendingRecord } from './pending';
import { USABLE_WAIT_MS, canonicalEvidence, type OffscreenUpload, type UploadOutcome } from './uploadParts';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Sends to the offscreen document, retrying briefly while a new document is still loading. */
async function toOffscreen(msg: OffscreenUpload): Promise<{ accepted?: boolean } | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await chrome.runtime.sendMessage(msg)) as { accepted?: boolean } | undefined;
    } catch (err) {
      if (attempt >= 20 || !/receiving end does not exist/i.test(String(err))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

export type UploadAnswer =
  | { status: 'uploading' }
  | { status: 'uploaded'; evidenceRef: Hex; batchId: Hex }
  | { error: string };

/**
 * `recall.uploadPending({captureId, mode})`. The exact captureId is the authority (as for
 * getPending). Starts the upload and answers `{status:'uploading'}`; an upload already running
 * or done is not started again.
 */
export async function uploadPending(captureId: unknown, mode: unknown): Promise<UploadAnswer> {
  if (mode !== 'stamped' && mode !== 'free') return { error: "mode must be 'stamped' or 'free'" };
  if (typeof captureId !== 'string' || !CAPTURE_ID.test(captureId)) {
    return { error: 'no pending capture with this id' };
  }
  const settings = await loadSettings();
  if (mode === 'free' && settings.uploadMode !== 'free') {
    return { error: 'free storage is turned off in the extension settings' };
  }
  const candidates = mode === 'free' ? [] : unusedBatches(await loadPool());

  let answer: UploadAnswer = { error: 'no pending capture with this id' };
  let start: PendingRecord | null = null;
  await updatePending(captureId, (rec) => {
    if (rec.kind !== 'capture') {
      answer = { error: 'a confirmation needs no upload' };
      return null;
    }
    const now = pendingUploadState(rec);
    if (now.status === 'uploaded' || now.status === 'uploading') {
      answer = now;
      return null;
    }
    if (mode === 'stamped' && candidates.length === 0) {
      answer = { error: 'the extension has no storage batch to upload with' };
      return null;
    }
    answer = { status: 'uploading' };
    start = { ...rec, upload: { status: 'uploading', mode, at: Date.now() } };
    return start;
  });
  const rec = start as PendingRecord | null;
  if (!rec) return answer;

  try {
    const net = netConfigFor(settings);
    await ensureOffscreen();
    const msg: OffscreenUpload = {
      type: 'recall.offscreen.upload',
      id: captureId,
      mode,
      // Stored as a JSON string, so it came back in its uploaded key order; canonical again anyway.
      evidence: canonicalEvidence(rec.evidence),
      ...(mode === 'free' ? {} : { stampKey: await stampKey() }),
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
    const ack = await toOffscreen(msg);
    if (!ack?.accepted) throw new Error('the uploader did not start');
  } catch (err) {
    await failed(captureId, errorText(err));
    return { error: `the upload could not start: ${errorText(err)}` };
  }
  return answer;
}

function failed(captureId: string, reason: string): Promise<unknown> {
  return updatePending(captureId, (rec) =>
    rec.evidenceRef ? null : { ...rec, upload: { status: 'failed', reason, at: Date.now() } },
  );
}

/**
 * Offscreen upload result for the pending capture `captureId`. What the attempt learned about
 * each batch is stored whatever became of the capture (a stamped slot is never stamped again).
 * A capture discarded or published meanwhile stays gone.
 */
export async function onPendingUploadResult(captureId: string, outcome: UploadOutcome): Promise<void> {
  try {
    await applyBatchUpdates(outcome.updates ?? []);
  } catch (err) {
    console.error('[recall] pool update failed', errorText(err));
  }
  if (!outcome.ok) {
    const reason =
      outcome.code === 'no_storage'
        ? 'no storage batch has enough time left'
        : outcome.error;
    await failed(captureId, reason);
    return;
  }
  await updatePending(captureId, (rec) => {
    if (rec.kind !== 'capture' || rec.evidenceRef) return null;
    const { upload: _done, ...rest } = rec;
    return { ...rest, evidenceRef: outcome.evidenceRef, batchId: outcome.batchId };
  });
}

/** `recall.getPending`: the record, its upload state, and what the publish tab may offer. */
export async function pendingAnswer(captureId: unknown): Promise<Record<string, unknown>> {
  const rec = await readPending(captureId);
  if (!rec) return { error: 'no pending capture with this id' };
  const { upload: _stored, ...rest } = rec;
  const [settings, pool] = await Promise.all([loadSettings(), loadPool()]);
  return {
    ...rest,
    upload: rec.kind === 'capture' ? pendingUploadState(rec) : { status: 'none' },
    // Whether a batch in the pool can take the upload now (stamped mode).
    storage: unusedBatches(pool).length > 0 ? 'ok' : 'empty',
    // `free`: the settings allow the gateway's free storage (the demo fallback).
    uploadMode: settings.uploadMode,
  };
}
