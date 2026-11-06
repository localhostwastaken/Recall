import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  custom,
  erc20Abi,
  decodeEventLog,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { generatePrivateKey } from 'viem/accounts';

export const POSTAGE_STAMP: Address = '0x45a1502382541Cd610CC9068e88727426b696293';
export const XBZZ: Address = '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da';
export const BUCKET_DEPTH = 16;
/** Gnosis block time; 17280 blocks is one day. */
export const BLOCK_SECONDS = 5n;
export const BLOCKS_PER_DAY = 17280n;

/** The batch id a capture records when its evidence went to a gateway's free storage (no stamp, no batch). */
export const FREE_BATCH_ID: Hex = `0x${'0'.repeat(64)}`;
export const isFreeBatch = (batchId: string): boolean => /^0x0{64}$/i.test(batchId);

const postageAbi = parseAbi([
  'function createBatch(address _owner, uint256 _initialBalancePerChunk, uint8 _depth, uint8 _bucketDepth, bytes32 _nonce, bool _immutable) returns (bytes32)',
  'function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk)',
  'function lastPrice() view returns (uint64)',
  'function remainingBalance(bytes32 _batchId) view returns (uint256)',
  'function batches(bytes32) view returns (address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag, uint256 normalisedBalance, uint256 lastUpdatedBlockNumber)',
  'function batchOwner(bytes32 _batchId) view returns (address)',
  'function batchDepth(bytes32 _batchId) view returns (uint8)',
  'event BatchCreated(bytes32 indexed batchId, uint256 totalAmount, uint256 normalisedBalance, address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag)',
]);

function blocksFor(days: number): bigint {
  if (!(days > 0)) throw new Error('days must be positive');
  return BigInt(Math.round(Number(BLOCKS_PER_DAY) * days));
}

/** Per-chunk balance that buys `days` of storage at the current on-chain price. */
async function perChunkFor(pub: PublicClient, days: number): Promise<bigint> {
  const price = await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'lastPrice' });
  return BigInt(price) * blocksFor(days);
}

/** Total xBZZ (16 decimals) to pay for a batch of `depth` lasting `days`. */
export async function costFor(pub: PublicClient, depth: number, days: number): Promise<bigint> {
  // createBatch requires strictly more than one day's worth, hence the +1 per chunk.
  return ((await perChunkFor(pub, days)) + 1n) * 2n ** BigInt(depth);
}

function requireAccount(wallet: WalletClient) {
  if (!wallet.account) throw new Error('wallet has no account');
  if (!wallet.chain) throw new Error('wallet has no chain');
  return { account: wallet.account, chain: wallet.chain };
}

/** How far above the quoted total a re-quote may be before `buyBatch` refuses to pay (percent). */
export const QUOTE_TOLERANCE_PERCENT = 10n;

/**
 * Pays for and creates an immutable batch whose stamps are signed by `owner`
 * (the stamp key), paid by the wallet's account. Depth 17 is the capture
 * default; 18 is for the app-hosting batch.
 *
 * `quotedTotal` (xBZZ, 16 decimals) is what the person was shown: the price is read again here,
 * and when it is more than QUOTE_TOLERANCE_PERCENT above the quote nothing is sent. The hooks
 * fire as soon as each transaction has a hash, BEFORE its receipt is awaited, so a caller can
 * record the hash even if the wait fails: `onApproveSent` for the xBZZ approval, `onSent` for the
 * createBatch transaction (the money has moved once it is mined).
 */
export async function buyBatch(
  wallet: WalletClient,
  opts: {
    owner: Address;
    depth?: 17 | 18;
    days: number;
    quotedTotal?: bigint;
    onApproveSent?: (hash: Hex) => void;
    onSent?: (txHash: Hex) => void;
  },
): Promise<{ batchId: Hex; txHash: Hex }> {
  const { account, chain } = requireAccount(wallet);
  const depth = opts.depth ?? 17;
  const pub = publicFrom(wallet);
  const perChunk = (await perChunkFor(pub, opts.days)) + 1n;
  const total = perChunk * 2n ** BigInt(depth);
  if (opts.quotedTotal !== undefined && total * 100n > opts.quotedTotal * (100n + QUOTE_TOLERANCE_PERCENT)) {
    throw new Error(
      `the batch price rose to ${total} (16 decimals) from the quoted ${opts.quotedTotal}, more than ${QUOTE_TOLERANCE_PERCENT}%: nothing was sent`,
    );
  }

  const approveHash = await wallet.writeContract({
    account, chain, address: XBZZ, abi: erc20Abi, functionName: 'approve', args: [POSTAGE_STAMP, total],
  });
  opts.onApproveSent?.(approveHash);
  await pub.waitForTransactionReceipt({ hash: approveHash });

  // A fresh random nonce makes the batch id unique per call.
  const nonce = generatePrivateKey();
  const txHash = await wallet.writeContract({
    account, chain, address: POSTAGE_STAMP, abi: postageAbi, functionName: 'createBatch',
    args: [opts.owner, perChunk, depth, BUCKET_DEPTH, nonce, true],
  });
  opts.onSent?.(txHash);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error('createBatch reverted');
  const created = batchCreatedIn(receipt.logs);
  if (created) return { batchId: created.batchId, txHash };
  throw new Error('BatchCreated event not found');
}

/** The postage contract's BatchCreated event among a receipt's logs. */
function batchCreatedIn(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): { batchId: Hex; owner: Address; depth: number } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== POSTAGE_STAMP.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: postageAbi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
      if (ev.eventName === 'BatchCreated') {
        return { batchId: ev.args.batchId, owner: ev.args.owner, depth: Number(ev.args.depth) };
      }
    } catch {
      /* not our event */
    }
  }
  return null;
}

/** What a sent createBatch transaction did (see batchFromTx). */
export type SentBatch =
  | { status: 'created'; batchId: Hex; owner: Address; depth: number }
  | { status: 'none'; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * Settles a purchase from its createBatch hash (the `onSent` hash of buyBatch) after the wait for
 * its receipt failed: `created` with the batch, `none` when it was mined and created no batch
 * (reverted), `unknown` when the receipt could not be read within `timeoutMs` (still pending,
 * dropped, or the node did not answer). Only `none` means paying again is safe.
 */
export async function batchFromTx(
  pub: PublicClient,
  txHash: Hex,
  opts: { timeoutMs?: number } = {},
): Promise<SentBatch> {
  let receipt;
  try {
    receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: opts.timeoutMs ?? 30_000 });
  } catch (e) {
    return { status: 'unknown', reason: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  }
  if (receipt.status !== 'success') return { status: 'none', reason: 'the transaction reverted' };
  const created = batchCreatedIn(receipt.logs);
  return created ? { status: 'created', ...created } : { status: 'none', reason: 'the transaction created no batch' };
}

export type BatchInfo = {
  owner: Address;
  depth: number;
  bucketDepth: number;
  immutable: boolean;
  normalisedBalance: bigint;
};

/**
 * The batch as the postage contract stores it, or null when no batch has this id (never created,
 * or expired and removed). A record names its batch id freely, so anything that pays for a batch
 * reads it first.
 */
export async function readBatch(pub: PublicClient, batchId: Hex): Promise<BatchInfo | null> {
  const [owner, depth, bucketDepth, immutable, normalisedBalance] = await pub.readContract({
    address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batches', args: [batchId],
  });
  if (/^0x0+$/.test(owner)) return null;
  return { owner, depth, bucketDepth, immutable, normalisedBalance };
}

export class BatchNotFoundError extends Error {
  constructor(readonly batchId: Hex) {
    super(`batch ${batchId} was not found on the postage contract`);
    this.name = 'BatchNotFoundError';
  }
}

/** What topping a batch up by `days` costs: the batch's depth sets how many chunk slots are paid for. */
export async function topUpCost(
  pub: PublicClient,
  batchId: Hex,
  days: number,
): Promise<{ perChunk: bigint; depth: number; total: bigint }> {
  const batch = await readBatch(pub, batchId);
  if (!batch) throw new BatchNotFoundError(batchId);
  const perChunk = await perChunkFor(pub, days);
  return { perChunk, depth: batch.depth, total: perChunk * 2n ** BigInt(batch.depth) };
}

/** Why a top-up was stopped before it could cost more than the person was shown. */
export type BatchChange = 'gone' | 'depth' | 'price';

/**
 * The batch or its price is not what the person agreed to pay for: the batch is gone, its depth
 * is not the one that was priced, or the top-up would cost more than the quoted maximum (or more
 * than the xBZZ approved for it). Thrown before the top-up is sent; a caller re-quotes and asks again.
 */
export class BatchChangedError extends Error {
  constructor(
    readonly batchId: Hex,
    readonly reason: BatchChange,
    detail: string,
  ) {
    super(`batch ${batchId} changed: ${detail}`);
    this.name = 'BatchChangedError';
  }
}

/**
 * Permissionless: anyone may extend any batch. Approves the xBZZ first only when the wallet's
 * allowance for the postage contract is short, so a second top-up is one wallet prompt.
 *
 * The payment is tied to what the person was shown: `expectDepth` and `maxTotal` (xBZZ, 16
 * decimals) come from the preview. The batch is read before the approval, and again after the
 * approval is mined (a wallet prompt can sit for minutes), and the top-up is only sent when the
 * batch still exists at that depth and `perChunk * 2^depth` is within `maxTotal` and within the
 * wallet's allowance; otherwise it throws `BatchChangedError` and nothing more is spent. Without
 * them, the first reading is the limit. An existing allowance never raises the cap.
 *
 * `onApproved` fires once the approval is mined (before the top-up prompt), so a caller can tell
 * a rejection of the approval from a rejection of the top-up. `onSent` fires as soon as the
 * top-up transaction exists, before its receipt is awaited: if that wait fails, the hash is how
 * a retry finds out whether it landed.
 */
export async function topUp(
  wallet: WalletClient,
  batchId: Hex,
  days: number,
  opts: {
    expectDepth?: number;
    maxTotal?: bigint;
    onApproved?: (approveHash: Hex) => void;
    onSent?: (topUpHash: Hex) => void;
  } = {},
): Promise<Hex> {
  const { account, chain } = requireAccount(wallet);
  const pub = publicFrom(wallet);

  let depthLimit = opts.expectDepth;
  let totalLimit = opts.maxTotal;
  /** Reads the batch and the price now; throws BatchChangedError when it is no longer what was agreed. */
  const verify = async (): Promise<{ perChunk: bigint; total: bigint }> => {
    const batch = await readBatch(pub, batchId);
    if (!batch) throw new BatchChangedError(batchId, 'gone', 'no such batch');
    depthLimit ??= batch.depth;
    if (batch.depth !== depthLimit) {
      throw new BatchChangedError(batchId, 'depth', `depth is ${batch.depth}, was ${depthLimit}`);
    }
    const perChunk = await perChunkFor(pub, days);
    const total = perChunk * 2n ** BigInt(batch.depth);
    totalLimit ??= total;
    if (total > totalLimit) throw new BatchChangedError(batchId, 'price', `${total} is more than the agreed ${totalLimit}`);
    return { perChunk, total };
  };

  let { perChunk, total } = await verify();
  const allowance = () =>
    pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'allowance', args: [account.address, POSTAGE_STAMP] });
  if ((await allowance()) < total) {
    const approveHash = await wallet.writeContract({
      account, chain, address: XBZZ, abi: erc20Abi, functionName: 'approve', args: [POSTAGE_STAMP, total],
    });
    await pub.waitForTransactionReceipt({ hash: approveHash });
    opts.onApproved?.(approveHash);
    // Time has passed (a wallet prompt, a block or two): look again before the money moves.
    ({ perChunk, total } = await verify());
    const approved = await allowance();
    if (approved < total) {
      throw new BatchChangedError(batchId, 'price', `${total} is more than the ${approved} approved`);
    }
  }
  const hash = await wallet.writeContract({
    account, chain, address: POSTAGE_STAMP, abi: postageAbi, functionName: 'topUp', args: [batchId, perChunk],
  });
  opts.onSent?.(hash);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('topUp reverted');
  return hash;
}

/**
 * True only when the contract itself reverted (PostageStamp reverts `remainingBalance` for a
 * batch that does not exist or has expired). Transport and node trouble (HTTP 429, timeouts,
 * no network, an internal node error) is not a revert and says nothing about the batch. viem
 * also files a bare -32603 "internal error" under reverts, so a revert needs 0x-hex return data
 * of at least 4 bytes (an error selector) or its own word for it in the reason.
 */
export function isContractRevert(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  const hit = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!hit) return false;
  return /^0x[0-9a-fA-F]{8,}$/.test(hit.raw ?? '') || /revert/i.test(hit.reason ?? '');
}

/**
 * Remaining lifetime in seconds, or null when the batch is unknown or expired. Only a contract
 * revert means "expired": any other RPC error (rate limit, timeout, node fault) is thrown, so a
 * caller can tell a dead batch from a node that did not answer.
 */
export async function batchTtlSeconds(pub: PublicClient, batchId: Hex): Promise<bigint | null> {
  const owner = await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchOwner', args: [batchId] });
  if (/^0x0+$/.test(owner)) return null;
  const [remaining, price] = await Promise.all([
    pub
      .readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'remainingBalance', args: [batchId] })
      .catch((err: unknown) => {
        if (!isContractRevert(err)) throw err;
        return 0n;
      }),
    pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'lastPrice' }),
  ]);
  if (remaining === 0n || price === 0n) return null;
  return (remaining / BigInt(price)) * BLOCK_SECONDS;
}

// A wallet client has no read access of its own; reads go through its transport.
function publicFrom(wallet: WalletClient): PublicClient {
  return createPublicClient({ chain: wallet.chain, transport: custom(wallet.transport) }) as PublicClient;
}

/** Bee accepts stamps only this many blocks after batch creation (measured ~11 on bee 2.8.0). */
const USABLE_AFTER_BLOCKS = 12;

export type WaitUsableOptions = {
  /**
   * Gnosis, for nodes that do not share their chain view. Public gateways answer `/chainstate`
   * with 404 (and `/batches` with a bare list of every batch on the network, ~2 MB); there the
   * batch counts as usable USABLE_AFTER_BLOCKS after the block the postage contract recorded for
   * it, the rule the extension uses for the same gateways.
   */
  chain?: PublicClient;
  /** Delay between polls (default 1 s). */
  pollMs?: number;
};

/** Bee's view: the batch's start block from `/batches` (`{batches:[...]}` or a bare list). */
function startFromBatches(body: unknown, want: string): number | undefined {
  const list = Array.isArray(body) ? body : (body as { batches?: unknown } | null)?.batches;
  if (!Array.isArray(list)) return undefined;
  for (const b of list as { batchID?: unknown; start?: unknown }[]) {
    if (typeof b?.batchID === 'string' && b.batchID.replace(/^0x/i, '').toLowerCase() === want && typeof b.start === 'number') {
      return b.start;
    }
  }
  return undefined;
}

/**
 * Resolves once the Bee node at `beeUrl` accepts stamps for the batch. Batches
 * owned by another key never show up in the node's own `/stamps`, so the signal
 * is the node's chain view: `GET /chainstate` reports the node's synced block,
 * and once that answers, `GET /batches` lists the batch with its start block; the
 * batch is usable USABLE_AFTER_BLOCKS past it. Uploading before that makes
 * `POST /chunks` hang for minutes instead of failing. A node without `/chainstate`
 * (public gateways) is judged by the chain instead when `opts.chain` is given (see
 * WaitUsableOptions); `/batches` is then never downloaded.
 */
export async function waitBatchUsable(
  beeUrl: string,
  batchId: Hex,
  timeoutMs: number,
  opts: WaitUsableOptions = {},
): Promise<void> {
  const base = beeUrl.replace(/\/+$/, '');
  const want = batchId.replace(/^0x/i, '').toLowerCase();
  const deadline = Date.now() + timeoutMs;
  let chainStart: bigint | undefined;
  for (;;) {
    try {
      const chain = await fetch(`${base}/chainstate`, { cache: 'no-store' });
      if (chain.ok) {
        const { block } = (await chain.json()) as { block?: unknown };
        const batches = await fetch(`${base}/batches`, { cache: 'no-store' });
        if (batches.ok && typeof block === 'number') {
          const start = startFromBatches(await batches.json(), want);
          if (start !== undefined && block >= start + USABLE_AFTER_BLOCKS) return;
        } else {
          await batches.body?.cancel().catch(() => undefined);
        }
      } else {
        await chain.body?.cancel().catch(() => undefined);
        if (opts.chain) {
          if (chainStart === undefined) {
            const [owner, , , , , lastUpdated] = await opts.chain.readContract({
              address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batches', args: [batchId],
            });
            if (!/^0x0+$/.test(owner)) chainStart = lastUpdated;
          }
          if (chainStart !== undefined && (await opts.chain.getBlockNumber({ cacheTime: 0 })) >= chainStart + BigInt(USABLE_AFTER_BLOCKS)) {
            return;
          }
        }
      }
    } catch {
      /* node or RPC not reachable right now: poll again */
    }
    if (Date.now() > deadline) throw new Error(`batch ${batchId} not usable on ${beeUrl} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
  }
}
