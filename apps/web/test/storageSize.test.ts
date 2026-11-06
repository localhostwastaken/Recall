// @vitest-environment jsdom
import type { PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_DEPTH, DEPTH } from '../src/storage/buy';
import {
  DEFAULT_SIZE,
  SIZE_OPTIONS,
  depthForSize,
  poolSummary,
  priceLine,
  quoteFor,
} from '../src/storage/size';

// The Storage page's size choice (R48): web pages (depth 17) or web pages and GitHub repos (18).

/** A Gnosis client that only answers the postage price (16-decimal xBZZ per chunk per block). */
const pubAt = (lastPrice: bigint) =>
  ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName !== 'lastPrice') throw new Error(`unexpected read ${functionName}`);
      return lastPrice;
    },
  }) as unknown as PublicClient;

describe('size choice', () => {
  it('maps web pages to depth 17 and repositories to depth 18, repositories by default', () => {
    expect(depthForSize('pages')).toBe(DEPTH);
    expect(depthForSize('repos')).toBe(ATTACHMENT_DEPTH);
    expect(DEFAULT_SIZE).toBe('repos');
    expect(SIZE_OPTIONS.map((o) => o.label)).toEqual(['Web pages', 'Web pages and GitHub repos']);
  });

  it('prices the chosen size: a repository batch costs twice a web page batch', async () => {
    const pub = pubAt(24_000n);
    const pages = await quoteFor(pub, 'pages', 7);
    const repos = await quoteFor(pub, 'repos', 7);
    expect(repos).toBe(pages * 2n);
    // 7 days of Gnosis blocks (5 s), plus the one extra per chunk createBatch needs.
    expect(pages).toBe((24_000n * 120_960n + 1n) * 2n ** 17n);
  });

  it('writes the price line so n x unit = total exactly, the unit rounded up', () => {
    const line = priceLine(2, 380_518_434_000_001n, 1_000_000_000n);
    expect(line).toBe('2 × 0.0381 xBZZ = 0.0762 xBZZ + network fees ~0.0012 xDAI');
  });
});

describe('pool status', () => {
  const NOW = Date.UTC(2026, 10, 7, 0, 0, 0);
  const days = (n: number) => BigInt(n * 86_400);

  it('says there is no storage when nothing usable is left', () => {
    expect(poolSummary([], NOW)).toBe('No storage yet.');
    expect(
      poolSummary(
        [
          { used: true, depth: 18, ttl: days(6) },
          { used: false, dead: true, depth: 18, ttl: days(6) },
          { used: false, depth: 18, ttl: null },
          { used: false, depth: 18, ttl: days(1) }, // under the extension's 2-day floor
        ],
        NOW,
      ),
    ).toBe('No storage yet.');
  });

  it('counts the usable batches and gives the first end date', () => {
    expect(poolSummary([{ used: false, depth: 18, ttl: days(7) }], NOW)).toBe('Your extension has storage: 1 batch, ends 14 Nov.');
    expect(
      poolSummary(
        [
          { used: false, depth: 18, ttl: days(30) },
          { used: false, depth: 18, ttl: days(7) },
          { used: true, depth: 18, ttl: days(3) },
        ],
        NOW,
      ),
    ).toBe('Your extension has storage: 2 batches, the first ends 14 Nov.');
  });

  it('says when the batches fit web pages only', () => {
    expect(poolSummary([{ used: false, depth: 17, ttl: days(7) }], NOW)).toBe(
      'Your extension has storage: 1 batch, ends 14 Nov. Web pages only.',
    );
    expect(
      poolSummary(
        [
          { used: false, depth: 17, ttl: days(7) },
          { used: false, depth: 18, ttl: days(7) },
        ],
        NOW,
      ),
    ).toBe('Your extension has storage: 2 batches, the first ends 14 Nov. 1 of them also fit a GitHub repo.');
  });
});
