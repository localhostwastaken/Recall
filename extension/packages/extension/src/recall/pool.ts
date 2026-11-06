// The batch pool (service worker side): batches the web app bought for the stamp key.
// Every batch an app hands over is checked on Gnosis first (ruling R27), so a hostile
// page on an allowed origin can only add batches that really are paid for our key, for
// at least MIN_BATCH_TTL_SECONDS.
import { getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { POSTAGE_STAMP } from '@recall/net/postage';
import { formatTtl, lastPrice, postageAbi, ttlSeconds } from './batchChain';
import {
  MIN_BATCH_TTL_SECONDS,
  POOL_KEY,
  mergeStamperStates,
  parsePool,
  poolView,
  type BatchUpdate,
  type PoolBatch,
  type PoolView,
} from './poolState';

/** Bee accepts stamps about this many blocks after a batch is created (see waitBatchUsable). */
export const USABLE_AFTER_BLOCKS = 12n;
/** At most this many batch ids per request (the web app buys up to 20 at a time). */
export const MAX_BATCH_IDS = 50;
/** A refused batch is answered from memory for this long (no chain reads for repeats). */
export const REFUSED_CACHE_MS = 2 * 60_000;

export type PoolArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

const defaultArea = (): PoolArea => chrome.storage.local as unknown as PoolArea;

/** Batch ids from an untrusted request: an array of 0x + 64 hex, lower-cased and deduplicated. */
export function parseBatchIds(v: unknown): Hex[] | { error: string } {
  if (!Array.isArray(v)) return { error: 'batchIds must be a list of batch ids' };
  if (v.length > MAX_BATCH_IDS) return { error: `at most ${MAX_BATCH_IDS} batch ids at a time` };
  const out: Hex[] = [];
  for (const id of v) {
    if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
      return { error: `not a batch id (0x + 64 hex): ${String(id).slice(0, 80)}` };
    }
    const lower = id.toLowerCase() as Hex;
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

/** A batch as the PostageStamp contract reports it. */
export type BatchInfo = {
  owner: Address;
  depth: number;
  bucketDepth: number;
  immutable: boolean;
  /** Creation (or last top-up) block. */
  startBlock: bigint;
  /** Remaining lifetime, or null when expired or without balance. */
  ttlSeconds: bigint | null;
};

/** Why a batch cannot join the pool, or null when it can (ruling R27). */
export function batchProblem(info: BatchInfo | null, stampAddress: Address): string | null {
  if (!info) return 'batch not found on Gnosis';
  if (info.owner.toLowerCase() !== stampAddress.toLowerCase()) {
    return `owner is ${info.owner}, not this extension's stamp key`;
  }
  if (info.depth !== 17 && info.depth !== 18) return `depth ${info.depth}; expected 17 or 18`;
  if (info.bucketDepth !== 16) return `bucket depth ${info.bucketDepth}; expected 16`;
  if (!info.immutable) return 'mutable batch; expected immutable';
  if (info.ttlSeconds === null) return 'batch expired or has no balance';
  if (info.ttlSeconds < MIN_BATCH_TTL_SECONDS) {
    return `batch has only ${formatTtl(info.ttlSeconds)} of storage left; needs at least 2 days`;
  }
  return null;
}

/**
 * Reads a batch (null when it does not exist). The lifetime is read only for a batch
 * owned by `stampAddress`: others are refused on the owner alone.
 */
export async function readBatch(
  pub: PublicClient,
  batchId: Hex,
  stampAddress: Address,
  price: () => Promise<bigint>,
): Promise<BatchInfo | null> {
  const [owner, depth, bucketDepth, immutable, , lastUpdated] = await pub.readContract({
    address: POSTAGE_STAMP,
    abi: postageAbi,
    functionName: 'batches',
    args: [batchId],
  });
  if (/^0x0{40}$/i.test(owner)) return null;
  const info: BatchInfo = {
    owner: getAddress(owner),
    depth: Number(depth),
    bucketDepth: Number(bucketDepth),
    immutable,
    startBlock: lastUpdated,
    ttlSeconds: null,
  };
  if (info.owner.toLowerCase() !== stampAddress.toLowerCase()) return info;
  info.ttlSeconds = await ttlSeconds(pub, batchId, await price());
  return info;
}

// Every read-modify-write of the pool runs in this chain (add, upload result).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

// addBatches calls run one at a time, chain reads included (a burst of requests from a
// page cannot fan out into parallel RPC storms).
let adding: Promise<unknown> = Promise.resolve();
function oneAdd<T>(fn: () => Promise<T>): Promise<T> {
  const next = adding.then(fn, fn);
  adding = next.catch(() => undefined);
  return next;
}

/** Recent refusals: batch id -> reason, until. "Not found" and read errors are not kept. */
const refused = new Map<string, { reason: string; until: number }>();

/** Test hook: forget remembered refusals. */
export function clearRefusedCache(): void {
  refused.clear();
}

export async function loadPool(area: PoolArea = defaultArea()): Promise<PoolBatch[]> {
  return parsePool((await area.get(POOL_KEY))[POOL_KEY]);
}

const savePool = (pool: PoolBatch[], area: PoolArea) => area.set({ [POOL_KEY]: pool });

export type AddResult = { pool: PoolView[]; rejected: { batchId: Hex; reason: string }[] };

/**
 * Adds batches after checking each on Gnosis: it exists, its owner is the stamp key,
 * depth 17 or 18 with bucket depth 16, immutable, and paid for at least two more days.
 * Batches already in the pool are kept as they are. Not-yet-usable batches are accepted
 * (marked). Calls run one at a time; `lastPrice` is read at most once per call.
 */
export function addBatches(
  ids: Hex[],
  deps: { pub: PublicClient; stampAddress: Address; area?: PoolArea; now?: number },
): Promise<AddResult> {
  return oneAdd(async () => {
    const area = deps.area ?? defaultArea();
    const now = deps.now ?? Date.now();
    const known = new Set((await loadPool(area)).map((b) => b.batchId));
    const fresh = ids.filter((id) => !known.has(id));
    let pricePromise: Promise<bigint> | undefined;
    const price = () => (pricePromise ??= lastPrice(deps.pub));
    const checked = await Promise.all(
      fresh.map(async (batchId) => {
        const hit = refused.get(batchId);
        if (hit && hit.until > now) return { batchId, info: null, problem: hit.reason };
        try {
          const info = await readBatch(deps.pub, batchId, deps.stampAddress, price);
          const problem = batchProblem(info, deps.stampAddress);
          if (problem && info)
            refused.set(batchId, { reason: problem, until: now + REFUSED_CACHE_MS });
          return { batchId, info, problem };
        } catch (err) {
          const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
          return { batchId, info: null, problem: `could not read the batch on Gnosis: ${why}` };
        }
      }),
    );
    const block = checked.some((c) => !c.problem) ? await deps.pub.getBlockNumber() : 0n;
    return serial(async () => {
      const pool = await loadPool(area);
      const rejected: AddResult['rejected'] = [];
      for (const c of checked) {
        if (c.problem || !c.info) {
          rejected.push({ batchId: c.batchId, reason: c.problem ?? 'unknown batch' });
          continue;
        }
        if (pool.some((b) => b.batchId === c.batchId)) continue;
        pool.push({
          batchId: c.batchId,
          depth: c.info.depth,
          used: false,
          usable: block >= c.info.startBlock + USABLE_AFTER_BLOCKS,
          startBlock: c.info.startBlock.toString(10),
          addedAt: now,
        });
      }
      if (checked.length > rejected.length) await savePool(pool, area);
      return { pool: poolView(pool), rejected };
    });
  });
}

/**
 * Stores what an upload attempt learned: bucket heights (merged, highest per bucket, so
 * a slot is never stamped twice), used, dead, or moved to the back of the queue.
 */
export function applyBatchUpdates(
  updates: BatchUpdate[],
  area: PoolArea = defaultArea(),
  now = Date.now(),
): Promise<void> {
  if (updates.length === 0) return Promise.resolve();
  return serial(async () => {
    const pool = await loadPool(area);
    for (const u of updates) {
      const b = pool.find((x) => x.batchId === u.batchId.toLowerCase());
      if (!b) continue;
      if (u.stamper) b.stamper = mergeStamperStates(b.stamper, u.stamper);
      if (u.used) {
        b.used = true;
        b.usable = true;
      }
      if (u.dead) {
        b.dead = u.dead;
        b.usable = false;
      }
      if (u.demote) b.queuedAt = now;
    }
    await savePool(pool, area);
  });
}
