// Offscreen document: stamps the evidence file with the stamp key (client-side postage,
// bee-js Stamper) and uploads it chunk by chunk to the Swarm upload URL. Kept out of the
// service worker, so bee-js never lands in the worker bundle.
import { createPublicClient, http, type Hex, type PublicClient } from 'viem';
import { encodeEvidence } from '@recall/evidence';
import { Stamper, uploadFree, uploadStamped } from '@recall/net/swarm';
import { withTimeout } from './captureParts';
import { formatTtl, lastPrice, ttlSeconds } from './batchChain';
import {
  MIN_BATCH_TTL_SECONDS,
  decodeStamperState,
  encodeStamperState,
  type BatchUpdate,
  type StamperState,
} from './poolState';
import { getAttachment } from './attachmentStore';
import { uploadStampedConcurrent } from './chunkPush';
import { sha256Hex } from './gitRepo';
import {
  ATTACHMENT_UPLOAD_TIMEOUT_MS,
  FREE_BATCH_ID,
  UPLOAD_TIMEOUT_MS,
  type OffscreenUpload,
  type UploadCandidate,
  type UploadOutcome,
} from './uploadParts';

/** Bee accepts stamps about this many blocks after the batch was created (bee 2.8: ~11). */
const USABLE_AFTER_BLOCKS = 12;
const POLL_MS = 2_000;

export type UploadDeps = {
  fetch: typeof fetch;
  /** Current Gnosis block, for the chain fallback when Bee hides /batches. */
  blockNumber: () => Promise<bigint>;
  /** Seconds of storage a batch has left, read on Gnosis; null when expired or unknown. */
  batchTtl: (batchId: Hex) => Promise<bigint | null>;
  upload: typeof uploadStamped;
  /** Free mode: the gateway's own storage (POST /bytes). */
  uploadFree: typeof uploadFree;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** A repository snapshot's bytes, by captureId (IndexedDB). */
  loadAttachment: (captureId: string) => Promise<Uint8Array | null>;
  /** A big file's stamped upload: chunks stamped in order, pushes in parallel (chunkPush.ts). */
  uploadMany: typeof uploadStampedConcurrent;
  /** Chunks of the big file accepted so far. */
  onProgress?: (done: number, total: number) => void;
};

/** One file of an upload, and how long its upload may take. `big`: pushed in parallel, with progress. */
type UploadFile = { bytes: Uint8Array; timeoutMs: number; big?: boolean };

type BeeView = { starts: Map<string, number>; block: number };

/** Bee's own view of the chain (`/batches` + `/chainstate`), or null when it does not share it. */
async function beeView(uploadUrl: string, f: typeof fetch): Promise<BeeView | null> {
  try {
    const base = uploadUrl.replace(/\/+$/, '');
    const opts = {
      signal: AbortSignal.timeout(5_000),
      credentials: 'omit' as const,
      cache: 'no-store' as const,
    };
    // /chainstate first: public gateways answer it 404, and their /batches is a ~2 MB list of
    // every batch on the network, which is then not worth downloading on every poll.
    const c = await f(`${base}/chainstate`, opts);
    if (!c.ok) return null;
    const { block } = (await c.json()) as { block?: unknown };
    const b = await f(`${base}/batches`, opts);
    if (!b.ok) return null;
    const body = (await b.json()) as unknown;
    const list = (Array.isArray(body) ? body : (body as { batches?: unknown } | null)?.batches) as
      | { batchID?: unknown; start?: unknown }[]
      | undefined;
    if (!Array.isArray(list) || typeof block !== 'number') return null;
    const starts = new Map<string, number>();
    for (const x of list) {
      if (typeof x.batchID === 'string' && typeof x.start === 'number') {
        starts.set(x.batchID.replace(/^0x/, '').toLowerCase(), x.start);
      }
    }
    return { starts, block };
  } catch {
    return null;
  }
}

/** Lifetimes read during one attempt (they do not change in two minutes). */
export type TtlCache = Map<Hex, bigint | null>;

export type PickResult = {
  /** The first live candidate the node accepts stamps for now, if any. */
  pick: UploadCandidate | null;
  /** Candidates that must never take an upload again, and why. */
  dead: { batchId: Hex; reason: string }[];
  /** Candidates whose lifetime could not be read this round (RPC trouble). */
  unreadable: number;
};

/**
 * Re-checks each candidate on Gnosis first: a batch that has expired, or has less than
 * MIN_BATCH_TTL_SECONDS left, is reported dead and skipped. Of the rest, the first one the
 * upload node accepts stamps for wins. Bee's view decides when the node shares one;
 * otherwise (public gateways) the chain does: 12 blocks after the batch's start.
 */
export async function pickUsable(
  candidates: UploadCandidate[],
  uploadUrl: string,
  d: Pick<UploadDeps, 'fetch' | 'blockNumber' | 'batchTtl'>,
  ttls: TtlCache = new Map(),
): Promise<PickResult> {
  const out: PickResult = { pick: null, dead: [], unreadable: 0 };
  const live: UploadCandidate[] = [];
  for (const c of candidates) {
    if (!ttls.has(c.batchId)) {
      try {
        ttls.set(c.batchId, await d.batchTtl(c.batchId));
      } catch {
        out.unreadable++;
        continue; // read again next round
      }
    }
    const ttl = ttls.get(c.batchId) ?? null;
    if (ttl === null) out.dead.push({ batchId: c.batchId, reason: 'batch expired' });
    else if (ttl < MIN_BATCH_TTL_SECONDS) {
      out.dead.push({
        batchId: c.batchId,
        reason: `only ${formatTtl(ttl)} of storage left; needs at least 2 days`,
      });
    } else live.push(c);
  }
  if (live.length === 0) return out;

  const view = await beeView(uploadUrl, d.fetch);
  let block: bigint | null = null;
  for (const c of live) {
    if (view) {
      const start = view.starts.get(c.batchId.replace(/^0x/, '').toLowerCase());
      if (start !== undefined && view.block >= start + USABLE_AFTER_BLOCKS) {
        out.pick = c;
        return out;
      }
      continue;
    }
    try {
      block ??= await d.blockNumber();
    } catch {
      return out;
    }
    if (block >= BigInt(c.startBlock) + BigInt(USABLE_AFTER_BLOCKS)) {
      out.pick = c;
      return out;
    }
  }
  return out;
}

/**
 * How a failed upload relates to its batch:
 * - bucket_full: the Stamper ran out of slots in a bucket; the batch is finished.
 * - rejected: the node refused it (a 4xx other than 408/429), so try another batch now.
 * - transient: network, 5xx, timeout; try other batches first next time.
 */
export function failureKind(err: unknown): 'bucket_full' | 'rejected' | 'transient' {
  const text = err instanceof Error ? err.message : String(err);
  if (/bucket is full/i.test(text)) return 'bucket_full';
  const status = httpStatus(err);
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return 'rejected';
  }
  return 'transient';
}

/** The HTTP status an upload error carries, if any. */
export function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; response?: { status?: unknown } } | null;
  return typeof e?.status === 'number'
    ? e.status
    : typeof e?.response?.status === 'number'
      ? e.response.status
      : undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

/**
 * Stamps and uploads with one batch. The Stamper is wrapped so that once the attempt
 * has ended (timeout, cancel, failure), no further chunk is stamped: the heights it
 * returns are final, and a late chunk can never take a slot behind our back.
 */
async function stampAndUpload(
  c: UploadCandidate,
  files: UploadFile[],
  req: OffscreenUpload,
  d: UploadDeps,
  signal?: AbortSignal,
): Promise<
  | { ok: true; refs: Hex[]; stamper: StamperState }
  | { ok: false; error: unknown; stamper: StamperState }
> {
  let real: Stamper;
  try {
    if (!req.stampKey) throw new Error('no stamp key');
    real = c.stamper?.length
      ? Stamper.fromState(req.stampKey, c.batchId, decodeStamperState(c.stamper), c.depth)
      : Stamper.fromBlank(req.stampKey, c.batchId, c.depth);
  } catch (error) {
    return { ok: false, error, stamper: c.stamper ?? [] };
  }
  let stopped = false;
  const guard = {
    stamp(address: Uint8Array, timestampMs?: number) {
      if (stopped || signal?.aborted) throw new Error('upload stopped');
      return real.stamp(address, timestampMs);
    },
  } as unknown as Stamper;
  try {
    // Every file with the same batch, one after the other (the evidence first).
    const refs: Hex[] = [];
    for (const f of files) {
      const ref = await withTimeout(
        f.big
          ? d.uploadMany(f.bytes, {
              uploadUrl: req.uploadUrl,
              stamper: guard,
              ...(d.onProgress ? { onProgress: d.onProgress } : {}),
              ...(signal ? { signal } : {}),
            })
          : d.upload(f.bytes, { uploadUrl: req.uploadUrl, stamper: guard }),
        f.timeoutMs,
        `the upload did not finish within ${f.timeoutMs / 1000} s`,
      );
      refs.push(ref.toLowerCase() as Hex);
    }
    stopped = true;
    return {
      ok: true,
      refs,
      stamper: encodeStamperState(real.getState()),
    };
  } catch (error) {
    stopped = true;
    return { ok: false, error, stamper: encodeStamperState(real.getState()) };
  }
}

/**
 * Reads a batch's lifetime on Gnosis through `pub`. `lastPrice` is read once and kept.
 * Resolves null for a batch that has expired (the contract reverts) and rejects on any
 * RPC error, which pickUsable counts as "could not be read", never as dead.
 */
export function ttlReader(pub: PublicClient): (batchId: Hex) => Promise<bigint | null> {
  let price: Promise<bigint> | undefined;
  return async (batchId) => {
    price ??= lastPrice(pub).catch((err) => {
      price = undefined;
      throw err;
    });
    return ttlSeconds(pub, batchId, await price);
  };
}

/**
 * Free upload mode: the evidence goes to the gateway's own free storage with `POST /bytes`.
 * No batch is read, stamped or marked (the pool is not touched: `updates` is always empty) and
 * the result carries the all-zero batch id. The reference is whatever the gateway answers (for
 * files over 4 KB it can differ from the local Swarm root, so it is not compared here: the web
 * app binds such records another way). Never throws.
 */
async function uploadToGateway(
  uploadUrl: string,
  files: UploadFile[],
  d: UploadDeps,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const fail = (error: string): UploadOutcome => ({ ok: false, code: 'failed', error, updates: [] });
  if (signal?.aborted) return fail('upload cancelled');
  try {
    const refs: Hex[] = [];
    for (const f of files) {
      if (signal?.aborted) return fail('upload cancelled');
      const ref = await withTimeout(
        d.uploadFree(f.bytes, uploadUrl),
        f.timeoutMs,
        `the upload did not finish within ${f.timeoutMs / 1000} s`,
      );
      if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) return fail('the upload to Swarm failed: the gateway returned no valid reference');
      refs.push(ref.toLowerCase() as Hex);
    }
    return {
      ok: true,
      batchId: FREE_BATCH_ID,
      evidenceRef: refs[0]!,
      ...(refs[1] ? { attachmentRef: refs[1] } : {}),
      updates: [],
    };
  } catch (err) {
    if (signal?.aborted) return fail('upload cancelled');
    return fail(`the upload to Swarm failed: ${message(err)}`);
  }
}

const defaultTtlReader = (gnosisRpcUrl: string) =>
  ttlReader(createPublicClient({ transport: http(gnosisRpcUrl) }) as PublicClient);

/**
 * In one attempt, at most this many batches may be tried after the node refused the
 * upload (a 4xx). Chunk addresses depend only on the evidence, so every batch is stamped
 * in the same buckets: a refusal that is not about the batch (wrong URL, 401, 403, 404,
 * 413) would otherwise take a slot on every batch in the pool.
 */
const MAX_REJECTED_BATCHES = 2;

/**
 * One upload attempt. Works through the candidates in queue order: re-checks each one's
 * lifetime on Gnosis, waits (up to `req.waitMs`) for a fresh one to become usable, then
 * stamps and uploads `encodeEvidence(req.evidence)`. A full bucket falls through to the
 * next candidate at once (that batch is dead). A node refusal (4xx) demotes the batch and
 * tries one more; a second refusal ends the attempt, with the status when both were the
 * same: that is the node, not the batches, and no batch is marked dead for it. A passing
 * failure (network, 5xx, timeout) ends the attempt and sends that batch to the back of the
 * queue. Every batch touched is reported in `updates`. Never throws.
 */
export async function uploadEvidence(
  req: OffscreenUpload,
  deps: Partial<UploadDeps> = {},
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const d: UploadDeps = {
    fetch: deps.fetch ?? ((...a) => fetch(...a)),
    blockNumber:
      deps.blockNumber ??
      (() => createPublicClient({ transport: http(req.gnosisRpcUrl) }).getBlockNumber()),
    batchTtl: deps.batchTtl ?? defaultTtlReader(req.gnosisRpcUrl),
    upload: deps.upload ?? uploadStamped,
    uploadFree: deps.uploadFree ?? uploadFree,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    loadAttachment:
      deps.loadAttachment ?? (async (id) => (await getAttachment(id))?.bytes ?? null),
    uploadMany: deps.uploadMany ?? uploadStampedConcurrent,
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
  };
  const updates = new Map<Hex, BatchUpdate>();
  const note = (u: BatchUpdate) =>
    updates.set(u.batchId, { ...(updates.get(u.batchId) ?? {}), ...u });
  const fail = (code: 'not_ready' | 'no_storage' | 'failed', error: string): UploadOutcome => ({
    ok: false,
    code,
    error,
    updates: [...updates.values()],
  });

  let bytes: Uint8Array;
  try {
    bytes = encodeEvidence(req.evidence);
  } catch (err) {
    return fail('failed', `the evidence could not be encoded: ${message(err)}`);
  }

  const files: UploadFile[] = [{ bytes, timeoutMs: UPLOAD_TIMEOUT_MS }];
  if (req.attachment) {
    // The repository snapshot kept at capture time; only exactly those bytes are uploaded.
    let snap: Uint8Array | null = null;
    try {
      snap = await d.loadAttachment(req.attachment.captureId);
    } catch {
      snap = null;
    }
    if (!snap) return fail('failed', 'the repository snapshot is no longer in the extension; capture the repository again');
    if (snap.length !== req.attachment.size || (await sha256Hex(snap)) !== req.attachment.sha256.toLowerCase()) {
      return fail('failed', 'the repository snapshot in the extension does not match the checked one');
    }
    files.push({ bytes: snap, timeoutMs: ATTACHMENT_UPLOAD_TIMEOUT_MS, big: true });
  }

  if (req.mode === 'free') return uploadToGateway(req.uploadUrl, files, d, signal);

  const deadline = d.now() + req.waitMs;
  const ttls: TtlCache = new Map();
  let queue = [...req.candidates];
  let lastError = '';
  const refusals: number[] = [];
  while (queue.length > 0) {
    if (signal?.aborted) return fail('failed', 'upload cancelled');
    const { pick, dead, unreadable } = await pickUsable(queue, req.uploadUrl, d, ttls);
    for (const x of dead) note({ batchId: x.batchId, dead: x.reason, deadReason: 'expired' });
    queue = queue.filter((c) => !dead.some((x) => x.batchId === c.batchId));
    if (!pick) {
      if (queue.length === 0) break;
      if (unreadable === queue.length && d.now() >= deadline) {
        return fail('failed', 'the storage batches could not be checked on Gnosis');
      }
      if (d.now() >= deadline) {
        return fail(
          'not_ready',
          'the storage batches are not usable yet (new storage takes about 1-2 minutes)',
        );
      }
      await d.sleep(POLL_MS);
      continue;
    }

    const r = await stampAndUpload(pick, files, req, d, signal);
    note({ batchId: pick.batchId, stamper: r.stamper });
    if (r.ok) {
      note({ batchId: pick.batchId, used: true });
      return {
        ok: true,
        batchId: pick.batchId,
        evidenceRef: r.refs[0]!,
        ...(r.refs[1] ? { attachmentRef: r.refs[1] } : {}),
        updates: [...updates.values()],
      };
    }
    if (signal?.aborted) return fail('failed', 'upload cancelled');
    lastError = message(r.error);
    queue = queue.filter((c) => c.batchId !== pick.batchId);
    const kind = failureKind(r.error);
    if (kind === 'bucket_full') {
      note({
        batchId: pick.batchId,
        dead: 'a bucket of this batch is full',
        deadReason: 'bucket_full',
      });
      continue;
    }
    note({ batchId: pick.batchId, demote: true });
    if (kind === 'rejected') {
      refusals.push(httpStatus(r.error) ?? 0);
      if (refusals.length < MAX_REJECTED_BATCHES) continue;
      const [first, second] = refusals;
      return fail(
        'failed',
        first === second
          ? `the storage node refused the upload (status ${first})`
          : `the storage node refused the upload (status ${first}, then ${second})`,
      );
    }
    return fail('failed', `the upload to Swarm failed: ${lastError}`);
  }

  const allDead = req.candidates.every((c) => updates.get(c.batchId)?.dead);
  if (allDead) return fail('no_storage', 'no storage batch has enough time left');
  return fail(
    'failed',
    lastError
      ? `the upload to Swarm failed: ${lastError}`
      : 'no storage batch could take the upload',
  );
}
