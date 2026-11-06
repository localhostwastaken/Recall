// PostageStamp reads on Gnosis (viem only), shared by the service worker (adding batches)
// and the offscreen document (re-checking a batch right before it takes an upload).
import { parseAbi, type Hex, type PublicClient } from 'viem';
import { POSTAGE_STAMP } from '@recall/net/postage';

/** Gnosis block time in seconds (17280 blocks a day). */
const BLOCK_SECONDS = 5n;

export const postageAbi = parseAbi([
  'function batches(bytes32) view returns (address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag, uint256 normalisedBalance, uint256 lastUpdatedBlockNumber)',
  'function remainingBalance(bytes32) view returns (uint256)',
  'function lastPrice() view returns (uint64)',
]);

/** The current storage price per chunk per block. Read once per request, not per batch. */
export async function lastPrice(pub: PublicClient): Promise<bigint> {
  return BigInt(
    await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'lastPrice' }),
  );
}

/** Seconds of storage the batch has left at `price`; null when expired, unknown or unpaid. */
export async function ttlSeconds(
  pub: PublicClient,
  batchId: Hex,
  price: bigint,
): Promise<bigint | null> {
  // remainingBalance reverts for unknown and expired batches.
  const remaining = await pub
    .readContract({
      address: POSTAGE_STAMP,
      abi: postageAbi,
      functionName: 'remainingBalance',
      args: [batchId],
    })
    .catch(() => 0n);
  if (remaining <= 0n || price <= 0n) return null;
  const ttl = (remaining / price) * BLOCK_SECONDS;
  return ttl > 0n ? ttl : null;
}

/** "1 d 4 h" / "3 h" for a refusal reason. */
export function formatTtl(seconds: bigint): string {
  const h = Number(seconds / 3600n);
  return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h`;
}
