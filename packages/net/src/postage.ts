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

/**
 * Pays for and creates an immutable batch whose stamps are signed by `owner`
 * (the stamp key), paid by the wallet's account. Depth 17 is the capture
 * default; 18 is for the app-hosting batch.
 */
export async function buyBatch(
  wallet: WalletClient,
  opts: { owner: Address; depth?: 17 | 18; days: number },
): Promise<{ batchId: Hex; txHash: Hex }> {
  const { account, chain } = requireAccount(wallet);
  const depth = opts.depth ?? 17;
  const pub = publicFrom(wallet);
  const perChunk = (await perChunkFor(pub, opts.days)) + 1n;
  const total = perChunk * 2n ** BigInt(depth);

  const approveHash = await wallet.writeContract({
    account, chain, address: XBZZ, abi: erc20Abi, functionName: 'approve', args: [POSTAGE_STAMP, total],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });

  // A fresh random nonce makes the batch id unique per call.
  const nonce = generatePrivateKey();
  const txHash = await wallet.writeContract({
    account, chain, address: POSTAGE_STAMP, abi: postageAbi, functionName: 'createBatch',
    args: [opts.owner, perChunk, depth, BUCKET_DEPTH, nonce, true],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error('createBatch reverted');
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POSTAGE_STAMP.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: postageAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'BatchCreated') return { batchId: ev.args.batchId, txHash };
    } catch {
      /* not our event */
    }
  }
  throw new Error('BatchCreated event not found');
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

/**
 * Resolves once the Bee node at `beeUrl` accepts stamps for the batch. Batches
 * owned by another key never show up in the node's own `/stamps`, so the signal
 * is the node's chain view: `GET /batches` lists the batch (with its start
 * block) and `GET /chainstate` reports the node's synced block at least
 * USABLE_AFTER_BLOCKS past it. Uploading before that makes `POST /chunks` hang
 * for minutes instead of failing.
 */
export async function waitBatchUsable(beeUrl: string, batchId: Hex, timeoutMs: number): Promise<void> {
  const want = batchId.replace(/^0x/, '').toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [batches, chain] = await Promise.all([fetch(`${beeUrl}/batches`), fetch(`${beeUrl}/chainstate`)]);
      if (batches.ok && chain.ok) {
        const list = ((await batches.json()) as { batches?: { batchID: string; start: number }[] }).batches ?? [];
        const { block } = (await chain.json()) as { block: number };
        const found = list.find((b) => b.batchID.toLowerCase() === want);
        if (found && block >= found.start + USABLE_AFTER_BLOCKS) return;
      }
    } catch {
      /* node not reachable yet */
    }
    if (Date.now() > deadline) throw new Error(`batch ${batchId} not usable on ${beeUrl} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
