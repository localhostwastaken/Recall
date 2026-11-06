// The batch pool (service worker side): batches the web app bought for the stamp key.
// Every batch an app hands over is checked on Gnosis first (ruling R27), so a hostile
// page on an allowed origin can only add batches that really are paid for our key.
import { getAddress, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { POSTAGE_STAMP } from '@recall/net/postage';
import {
  POOL_KEY,
  parsePool,
  poolView,
  type PoolBatch,
  type PoolView,
  type StamperState,
} from './poolState';

/** Gnosis block time in seconds (17280 blocks a day). */
const BLOCK_SECONDS = 5n;
/** Bee accepts stamps about this many blocks after a batch is created (see waitBatchUsable). */
export const USABLE_AFTER_BLOCKS = 12n;
/** At most this many batch ids per request (the web app buys up to 20 at a time). */
export const MAX_BATCH_IDS = 50;

const postageAbi = parseAbi([
  'function batches(bytes32) view returns (address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag, uint256 normalisedBalance, uint256 lastUpdatedBlockNumber)',
  'function remainingBalance(bytes32) view returns (uint256)',
  'function lastPrice() view returns (uint64)',
]);

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

/** Reads a batch from the PostageStamp contract; null when it does not exist. */
export async function readBatch(pub: PublicClient, batchId: Hex): Promise<BatchInfo | null> {
  const [owner, depth, bucketDepth, immutable, , lastUpdated] = await pub.readContract({
    address: POSTAGE_STAMP,
    abi: postageAbi,
    functionName: 'batches',
    args: [batchId],
  });
  if (/^0x0{40}$/i.test(owner)) return null;
  const [remaining, price] = await Promise.all([
    // remainingBalance reverts for expired batches.
    pub
      .readContract({
        address: POSTAGE_STAMP,
        abi: postageAbi,
        functionName: 'remainingBalance',
        args: [batchId],
      })
      .catch(() => 0n),
    pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'lastPrice' }),
  ]);
  const ttlSeconds =
    remaining > 0n && BigInt(price) > 0n ? (remaining / BigInt(price)) * BLOCK_SECONDS : null;
  return {
    owner: getAddress(owner),
    depth: Number(depth),
    bucketDepth: Number(bucketDepth),
    immutable,
    startBlock: lastUpdated,
    ttlSeconds: ttlSeconds !== null && ttlSeconds > 0n ? ttlSeconds : null,
  };
}

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
  return null;
}

// Every read-modify-write of the pool runs in this chain (add, upload result).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export async function loadPool(area: PoolArea = defaultArea()): Promise<PoolBatch[]> {
  return parsePool((await area.get(POOL_KEY))[POOL_KEY]);
}

const savePool = (pool: PoolBatch[], area: PoolArea) => area.set({ [POOL_KEY]: pool });

export type AddResult = { pool: PoolView[]; rejected: { batchId: Hex; reason: string }[] };

/**
 * Adds batches after checking each on Gnosis: it exists, its owner is the stamp key,
 * depth 17 or 18 with bucket depth 16, immutable, and still paid for. Batches already
 * in the pool are kept as they are. Not-yet-usable batches are accepted (marked).
 */
export async function addBatches(
  ids: Hex[],
  deps: { pub: PublicClient; stampAddress: Address; area?: PoolArea; now?: number },
): Promise<AddResult> {
  const area = deps.area ?? defaultArea();
  const known = new Set((await loadPool(area)).map((b) => b.batchId));
  const fresh = ids.filter((id) => !known.has(id));
  // Chain reads happen outside the storage chain; only the write is serialised.
  const [checked, block] = await Promise.all([
    Promise.all(
      fresh.map(async (batchId) => {
        try {
          const info = await readBatch(deps.pub, batchId);
          return { batchId, info, problem: batchProblem(info, deps.stampAddress) };
        } catch (err) {
          const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
          return { batchId, info: null, problem: `could not read the batch on Gnosis: ${why}` };
        }
      }),
    ),
    fresh.length ? deps.pub.getBlockNumber() : Promise.resolve(0n),
  ]);
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
        addedAt: deps.now ?? Date.now(),
      });
    }
    if (checked.length > rejected.length) await savePool(pool, area);
    return { pool: poolView(pool), rejected };
  });
}

/**
 * Records an upload attempt with `batchId`: the stamper's new bucket heights (always,
 * so a slot is never stamped twice), and `used` once the evidence is on Swarm.
 */
export function recordUpload(
  batchId: Hex,
  update: { stamper?: StamperState; used: boolean },
  area: PoolArea = defaultArea(),
): Promise<void> {
  return serial(async () => {
    const pool = await loadPool(area);
    const b = pool.find((x) => x.batchId === batchId.toLowerCase());
    if (!b) return;
    if (update.stamper) b.stamper = update.stamper;
    if (update.used) {
      b.used = true;
      b.usable = true;
    }
    await savePool(pool, area);
  });
}
