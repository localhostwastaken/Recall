// The batch pool's stored shape (chrome.storage.local), shared by the service worker,
// the offscreen document and the popup. Types, constants and pure helpers only, so the
// popup stays light.
import type { Hex } from 'viem';

export const POOL_KEY = 'recall.pool';

/** Bee's bucket depth: a Stamper tracks 2^16 buckets. */
export const BUCKETS = 65536;

/**
 * A Stamper's bucket heights, sparse: `[bucket, height]` for each bucket in use. One
 * capture fills a handful of buckets, so this stays tiny next to the 256 KiB array.
 */
export type StamperState = [number, number][];

/** One prepaid postage batch, owned by the stamp key. One capture uses one batch. */
export type PoolBatch = {
  batchId: Hex;
  depth: number;
  used: boolean;
  /** Last known: Bee (or the chain, as a fallback) accepts stamps for it. */
  usable: boolean;
  /** Gnosis block the batch was created or last updated at (decimal string). */
  startBlock: string;
  addedAt: number;
  /** Bucket heights after the last upload with this batch, if any. */
  stamper?: StamperState;
};

/** What the app sees of the pool (JSON-safe). */
export type PoolView = { batchId: Hex; used: boolean; usable: boolean };

export const poolView = (pool: PoolBatch[]): PoolView[] =>
  pool.map((b) => ({ batchId: b.batchId, used: b.used, usable: b.usable }));

/** Batches a new capture may upload with, oldest first. */
export const unusedBatches = (pool: PoolBatch[]): PoolBatch[] =>
  pool.filter((b) => !b.used).sort((a, b) => a.addedAt - b.addedAt);

const isHex32 = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const isState = (v: unknown): v is StamperState =>
  Array.isArray(v) &&
  v.every(
    (e) =>
      Array.isArray(e) &&
      e.length === 2 &&
      Number.isInteger(e[0]) &&
      e[0] >= 0 &&
      e[0] < BUCKETS &&
      Number.isInteger(e[1]) &&
      e[1] > 0,
  );

/** Reads the stored pool, dropping malformed entries (storage is never trusted blindly). */
export function parsePool(stored: unknown): PoolBatch[] {
  if (!Array.isArray(stored)) return [];
  const out: PoolBatch[] = [];
  for (const raw of stored) {
    const b = raw as Partial<PoolBatch> | null;
    if (!b || !isHex32(b.batchId) || (b.depth !== 17 && b.depth !== 18)) continue;
    if (typeof b.startBlock !== 'string' || !/^\d+$/.test(b.startBlock)) continue;
    out.push({
      batchId: b.batchId.toLowerCase() as Hex,
      depth: b.depth,
      used: b.used === true,
      usable: b.usable === true,
      startBlock: b.startBlock,
      addedAt: typeof b.addedAt === 'number' ? b.addedAt : 0,
      ...(isState(b.stamper) ? { stamper: b.stamper } : {}),
    });
  }
  return out;
}

export function encodeStamperState(buckets: Uint32Array): StamperState {
  const out: StamperState = [];
  buckets.forEach((height, bucket) => {
    if (height > 0) out.push([bucket, height]);
  });
  return out;
}

export function decodeStamperState(state: StamperState | undefined): Uint32Array {
  const buckets = new Uint32Array(BUCKETS);
  for (const [bucket, height] of state ?? []) buckets[bucket] = height;
  return buckets;
}
