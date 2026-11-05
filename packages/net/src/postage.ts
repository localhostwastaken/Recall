import {
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

const postageAbi = parseAbi([
  'function createBatch(address _owner, uint256 _initialBalancePerChunk, uint8 _depth, uint8 _bucketDepth, bytes32 _nonce, bool _immutable) returns (bytes32)',
  'function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk)',
  'function lastPrice() view returns (uint64)',
  'function remainingBalance(bytes32 _batchId) view returns (uint256)',
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

/** Permissionless: anyone may extend any batch. */
export async function topUp(wallet: WalletClient, batchId: Hex, days: number): Promise<Hex> {
  const { account, chain } = requireAccount(wallet);
  const pub = publicFrom(wallet);
  const perChunk = await perChunkFor(pub, days);
  const depth = await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchDepth', args: [batchId] });
  const total = perChunk * 2n ** BigInt(depth);
  const approveHash = await wallet.writeContract({
    account, chain, address: XBZZ, abi: erc20Abi, functionName: 'approve', args: [POSTAGE_STAMP, total],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });
  const hash = await wallet.writeContract({
    account, chain, address: POSTAGE_STAMP, abi: postageAbi, functionName: 'topUp', args: [batchId, perChunk],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('topUp reverted');
  return hash;
}

/** Remaining lifetime in seconds, or null when the batch is unknown or expired. */
export async function batchTtlSeconds(pub: PublicClient, batchId: Hex): Promise<bigint | null> {
  const owner = await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchOwner', args: [batchId] });
  if (/^0x0+$/.test(owner)) return null;
  const [remaining, price] = await Promise.all([
    pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'remainingBalance', args: [batchId] }).catch(() => 0n),
    pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'lastPrice' }),
  ]);
  if (remaining === 0n || price === 0n) return null;
  return (remaining / BigInt(price)) * BLOCK_SECONDS;
}

// A wallet client has no read access of its own; reads go through its transport.
function publicFrom(wallet: WalletClient): PublicClient {
  return createPublicClient({ chain: wallet.chain, transport: custom(wallet.transport) }) as PublicClient;
}

/** Bee accepts stamps only this many blocks after batch creation (measured ~11 on bee 2.8.1). */
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
