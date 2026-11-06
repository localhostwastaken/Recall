// The upload of a pending capture (service worker side, R44 capture first). The publish tab
// starts it with `recall.uploadPending` once the person chose how to store the evidence; the
// offscreen document stamps and uploads it (stamped: one pool batch; free: the gateway's own
// storage). Never before the person chose, never twice: a second request while one runs, or
// after the evidence is on Swarm, only reports the state. A failure keeps the capture and the
// chosen storage, so the tab can offer "Try upload again".
//
// One upload at a time across ALL captures: while any capture is uploading, another request is
// refused, and the pool (batches and stamp heights) is read inside the pending lock only once no
// upload runs, so it already holds the last upload's heights: two captures never stamp the same
// slots of a batch.
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { loadSettings, netConfigFor, type Settings } from './settings';
import { ensureOffscreen } from './offscreen';
import { applyBatchUpdates, loadPool } from './pool';
import { MIN_BATCH_TTL_SECONDS, unusedBatches, type PoolBatch } from './poolState';
import { lastPrice, ttlSeconds } from './batchChain';
import { stampKey } from './stamp';
import {
  CAPTURE_ID,
  allPending,
  isUploaded,
  lostAfter,
  newCaptureId,
  pendingLocked,
  pendingUploadState,
  readPending,
  updatePending,
  writePending,
  type PendingRecord,
} from './pending';
import { USABLE_WAIT_MS, canonicalEvidence, type OffscreenUpload, type UploadOutcome } from './uploadParts';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const NO_BATCH = 'the extension has no storage batch to upload with';
export const UPLOAD_BUSY = 'another capture is uploading right now; try again in a moment';
export const NO_DEEP_BATCH =
  'a repository snapshot needs a storage batch of depth 18 or more, and the extension has none';
export const SNAPSHOT_NOT_UPLOADED = 'the repository snapshot was not uploaded';

/** The storage depth a pending record's stamped upload needs (0: any). */
const depthNeeded = (rec: PendingRecord) => (rec.attachment ? Math.max(18, rec.needsDepth ?? 18) : 0);

/** Uploads sent to the offscreen document whose result has not come back (this worker's life), and until when. */
const inFlight = new Map<string, number>();
const uploadRunning = () => [...inFlight.values()].some((until) => Date.now() < until);

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

/** A batch lifetime read on Gnosis is reused this long (getPending is polled during an upload). */
const TTL_CACHE_MS = 60_000;
const ttlCache = new Map<string, { at: number; ttl: bigint | null }>();

/** Test hook: forget cached lifetimes and in-flight uploads. */
export function clearTtlCache(): void {
  ttlCache.clear();
  inFlight.clear();
}

/**
 * Unused pool batches that still have at least MIN_BATCH_TTL_SECONDS of storage on Gnosis. A
 * lifetime that cannot be read keeps the batch (the upload re-checks every batch anyway).
 */
export async function usableBatches(settings: Settings, pool?: PoolBatch[]): Promise<PoolBatch[]> {
  const unused = unusedBatches(pool ?? (await loadPool()));
  if (unused.length === 0) return [];
  let pub: PublicClient | undefined;
  let price: Promise<bigint> | undefined;
  const out: PoolBatch[] = [];
  for (const b of unused) {
    const hit = ttlCache.get(b.batchId);
    let ttl: bigint | null | undefined = hit && Date.now() - hit.at < TTL_CACHE_MS ? hit.ttl : undefined;
    if (ttl === undefined) {
      try {
        pub ??= createPublicClient({ transport: http(netConfigFor(settings).gnosis.rpcUrl) }) as PublicClient;
        price ??= lastPrice(pub);
        ttl = await ttlSeconds(pub, b.batchId, await price);
        ttlCache.set(b.batchId, { at: Date.now(), ttl });
      } catch {
        out.push(b); // unknown: the upload decides
        continue;
      }
    }
    if (ttl !== null && ttl >= MIN_BATCH_TTL_SECONDS) out.push(b);
  }
  return out;
}

export type UploadAnswer =
  | { status: 'uploading'; mode: 'stamped' | 'free' }
  | { status: 'uploaded'; evidenceRef: Hex; batchId: Hex; attachmentRef?: Hex }
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

  let msg: OffscreenUpload | null = null;
  const answer = await pendingLocked(async (): Promise<UploadAnswer> => {
    const rec = await readPending(captureId);
    if (!rec) return { error: 'no pending capture with this id' };
    if (rec.kind !== 'capture') return { error: 'a confirmation needs no upload' };
    const now = pendingUploadState(rec);
    if (now.status === 'uploaded' || now.status === 'uploading') return now;
    const others = (await allPending()).filter((r) => r.captureId !== captureId);
    if (uploadRunning() || others.some((r) => pendingUploadState(r).status === 'uploading')) {
      return { error: UPLOAD_BUSY };
    }
    // Read here, with no upload running: the pool holds every height stamped so far.
    // A repository snapshot needs a deep batch (R46): both files go into the same one.
    const depth = depthNeeded(rec);
    const candidates = mode === 'free' ? [] : (await usableBatches(settings)).filter((b) => b.depth >= depth);
    if (mode === 'stamped' && candidates.length === 0) return { error: depth ? NO_DEEP_BATCH : NO_BATCH };
    const attempt = newCaptureId().slice(0, 12);
    await writePending({ ...rec, upload: { status: 'uploading', mode, at: Date.now(), attempt } });
    const net = netConfigFor(settings);
    msg = {
      type: 'recall.offscreen.upload',
      id: `${captureId}.${attempt}`,
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
      ...(rec.attachment
        ? { attachment: { captureId, sha256: rec.attachment.sha256, size: rec.attachment.size } }
        : {}),
    };
    inFlight.set(msg.id, Date.now() + lostAfter(rec));
    return { status: 'uploading', mode };
  });
  const sending = msg as OffscreenUpload | null;
  if (!sending) return answer;

  try {
    await ensureOffscreen();
    const ack = await toOffscreen(sending);
    if (!ack?.accepted) throw new Error('the uploader did not start');
  } catch (err) {
    inFlight.delete(sending.id);
    await failed(captureId, sending.id.split('.')[1]!, errorText(err), mode);
    return { error: `the upload could not start: ${errorText(err)}` };
  }
  return answer;
}

/** Ends the attempt `attempt` as failed, unless a newer attempt (or the upload) took its place. */
function failed(captureId: string, attempt: string, reason: string, mode: 'stamped' | 'free'): Promise<unknown> {
  return updatePending(captureId, (rec) =>
    isUploaded(rec) || rec.upload?.status !== 'uploading' || rec.upload.attempt !== attempt
      ? null
      : { ...rec, upload: { status: 'failed', reason, at: Date.now(), mode } },
  );
}

/**
 * Offscreen upload result for `<captureId>.<attempt>`. What the attempt learned about each batch
 * is stored whatever became of the capture (a stamped slot is never stamped again). Only the
 * attempt the record is waiting for may end it; a capture discarded or published meanwhile stays
 * gone.
 */
export async function onPendingUploadResult(id: string, outcome: UploadOutcome): Promise<void> {
  try {
    await applyBatchUpdates(outcome.updates ?? []);
  } catch (err) {
    console.error('[recall] pool update failed', errorText(err));
  } finally {
    inFlight.delete(id);
  }
  const [captureId, attempt] = id.split('.');
  if (!captureId || !attempt || !CAPTURE_ID.test(captureId)) return;
  if (!outcome.ok) {
    const rec = await readPending(captureId);
    const mode = rec?.upload?.mode === 'free' ? 'free' : 'stamped';
    const reason = outcome.code === 'no_storage' ? 'no storage batch has enough time left' : outcome.error;
    await failed(captureId, attempt, reason, mode);
    return;
  }
  const rec = await readPending(captureId);
  if (rec?.attachment && !outcome.attachmentRef) {
    await failed(captureId, attempt, SNAPSHOT_NOT_UPLOADED, rec.upload?.mode === 'free' ? 'free' : 'stamped');
    return;
  }
  await updatePending(captureId, (rec) => {
    if (rec.kind !== 'capture' || isUploaded(rec)) return null;
    if (rec.upload?.status !== 'uploading' || rec.upload.attempt !== attempt) return null;
    if (rec.attachment && !outcome.attachmentRef) return null;
    const { upload: _done, ...rest } = rec;
    return {
      ...rest,
      evidenceRef: outcome.evidenceRef,
      batchId: outcome.batchId,
      ...(rec.attachment && outcome.attachmentRef ? { attachmentRef: outcome.attachmentRef } : {}),
    };
  });
}

/** `recall.getPending`: the record, its upload state, and what the publish tab may offer. */
export async function pendingAnswer(captureId: unknown): Promise<Record<string, unknown>> {
  const rec = await readPending(captureId);
  if (!rec) return { error: 'no pending capture with this id' };
  const { upload: _stored, ...rest } = rec;
  const settings = await loadSettings();
  return {
    ...rest,
    upload: rec.kind === 'capture' ? pendingUploadState(rec) : { status: 'none' },
    // Whether a batch in the pool, with at least 2 days left (and deep enough for a repository
    // snapshot), can take the upload now (stamped).
    storage: (await usableBatches(settings)).some((b) => b.depth >= depthNeeded(rec)) ? 'ok' : 'empty',
    // `free`: the settings allow the gateway's free storage (the demo fallback).
    uploadMode: settings.uploadMode,
  };
}
