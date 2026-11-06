// The Storage page's size choice, its price line and the pool status line. Pure, so they are
// unit-tested without a browser (test/storageSize.test.ts).
import { costFor } from '@recall/net';
import type { PublicClient } from 'viem';
import { ceilSig, formatBzz, formatXdaiCeil } from '../format';
import { GAS_PER_BATCH } from '../gas';
import { ATTACHMENT_DEPTH, DEPTH, type Depth } from './buy';

/** What the storage is for: web pages fit depth 17; a GitHub repo capture needs depth 18. */
export type Size = 'pages' | 'repos';
export const SIZE_OPTIONS: { value: Size; label: string }[] = [
  { value: 'pages', label: 'Web pages' },
  { value: 'repos', label: 'Web pages and GitHub repos' },
];
/** Most captures (and the demo) are repositories, so a batch that fits one is the default. */
export const DEFAULT_SIZE: Size = 'repos';
export const depthForSize = (size: Size): Depth => (size === 'repos' ? ATTACHMENT_DEPTH : DEPTH);

/** The xBZZ price of one batch of this size for `days`, read from Gnosis. */
export const quoteFor = (pub: PublicClient, size: Size, days: number): Promise<bigint> =>
  costFor(pub, depthForSize(size), days);

/** "n × a xBZZ = b xBZZ + network fees ~c xDAI": a is rounded up once, so n × a = b exactly. */
export function priceLine(count: number, perBatch: bigint, gasPrice: bigint): string {
  const unit = ceilSig(perBatch);
  return `${count} × ${formatBzz(unit)} xBZZ = ${formatBzz(unit * BigInt(count))} xBZZ + network fees ~${formatXdaiCeil(
    gasPrice * GAS_PER_BATCH * BigInt(count),
  )} xDAI`;
}

/** The extension skips a batch with less than this left (its pool rule), so it does not count. */
export const MIN_TTL_SECONDS = 2n * 86_400n;

/** One pool batch as the chain reports it: `ttl` null when unknown or expired. */
export type PoolBatchInfo = { used: boolean; dead?: boolean; depth: number | null; ttl: bigint | null };

const batches = (n: number) => `${n} ${n === 1 ? 'batch' : 'batches'}`;
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * "Your extension has storage: 2 batches, the first ends 14 Nov." or "No storage yet." Only
 * batches a capture can still use count: unused, alive, with two days or more left.
 */
export function poolSummary(list: PoolBatchInfo[], now: number): string {
  const usable = list.filter((b) => !b.used && !b.dead && b.ttl !== null && b.ttl >= MIN_TTL_SECONDS);
  if (usable.length === 0) return 'No storage yet.';
  const firstEnd = Math.min(...usable.map((b) => now + Number(b.ttl) * 1000));
  const repos = usable.filter((b) => (b.depth ?? 0) >= ATTACHMENT_DEPTH).length;
  const ends = `${usable.length === 1 ? 'ends' : 'the first ends'} ${day(firstEnd)}`;
  const kind =
    repos === usable.length ? '' : repos === 0 ? ' Web pages only.' : ` ${repos} of them also fit a GitHub repo.`;
  return `Your extension has storage: ${batches(usable.length)}, ${ends}.${kind}`;
}
