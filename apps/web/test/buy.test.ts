import type { Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The purchase shared by the Storage page and the publish page: never twice (storage/buy.ts).
const net = vi.hoisted(() => ({ buyBatch: vi.fn(), batchFromTx: vi.fn(), batchTtlSeconds: vi.fn() }));
vi.mock('@recall/net', () => net);
vi.mock('../src/settings', () => ({
  getSettings: () => ({ extensionId: 'a'.repeat(32) }),
  defaultSettings: () => ({ extensionId: '' }),
  isSharedOrigin: () => false,
}));
vi.mock('../src/wallet', () => ({ isUserRejection: (e: unknown) => (e as { code?: number })?.code === 4001 }));

const { buyOneBatch, linkNeedsConfirm, recallSent, forgetSent, priceRose } = await import('../src/storage/buy');

const OWNER = '0x1111111111111111111111111111111111111111';
const TX = `0x${'ab'.repeat(32)}` as Hex;
const BATCH = `0x${'cd'.repeat(32)}` as Hex;
const KEY = 'test.sent';
const wallet = {} as never;
const pub = {} as never;

beforeEach(() => {
  vi.resetAllMocks();
  forgetSent(KEY);
  net.batchTtlSeconds.mockResolvedValue(86_400n * 7n);
});

describe('buyOneBatch', () => {
  it('buys, and keeps the sent hash for the caller to forget', async () => {
    net.buyBatch.mockImplementation(async (_w, o: { onSent: (h: Hex) => void }) => {
      o.onSent(TX);
      return { batchId: BATCH, txHash: TX };
    });
    expect(await buyOneBatch(wallet, pub, { owner: OWNER, days: 7, quotedTotal: 5n, sentKey: KEY })).toEqual({
      kind: 'bought',
      batchId: BATCH,
      ttl: 86_400n * 7n,
    });
    expect(net.buyBatch.mock.calls[0]![1]).toMatchObject({ owner: OWNER, depth: 17, days: 7, quotedTotal: 5n });
    expect(recallSent(KEY)).toBe(TX);
  });

  it('a lost receipt after sending is settled from the hash, never bought again', async () => {
    net.buyBatch.mockImplementation(async (_w, o: { onSent: (h: Hex) => void }) => {
      o.onSent(TX);
      throw new Error('receipt timeout');
    });
    net.batchFromTx.mockResolvedValueOnce({ status: 'created', batchId: BATCH, owner: OWNER, depth: 17 });
    expect(await buyOneBatch(wallet, pub, { owner: OWNER, days: 7, sentKey: KEY })).toMatchObject({ kind: 'bought', batchId: BATCH });
    net.batchFromTx.mockResolvedValueOnce({ status: 'unknown', reason: 'timeout' });
    expect(await buyOneBatch(wallet, pub, { owner: OWNER, days: 7, sentKey: KEY })).toEqual({ kind: 'unknown', txHash: TX });
    expect(net.buyBatch).toHaveBeenCalledTimes(2);
  });

  it('a rejection before sending is "cancelled"; a price rise names both prices', async () => {
    net.buyBatch.mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }));
    expect(await buyOneBatch(wallet, pub, { owner: OWNER, days: 7, sentKey: KEY })).toEqual({ kind: 'cancelled' });
    net.buyBatch.mockRejectedValueOnce(new Error('the batch price rose to 200 (16 decimals) from the quoted 100'));
    expect(await buyOneBatch(wallet, pub, { owner: OWNER, days: 7, sentKey: KEY })).toMatchObject({
      kind: 'failed',
      rose: { total: 200n, quoted: 100n },
    });
    expect(recallSent(KEY)).toBeUndefined();
    expect(priceRose(new Error('other'))).toBeNull();
  });
});

describe('linkNeedsConfirm (the ?ext= rule)', () => {
  it('asks only for an extension that neither Settings nor the build default names', () => {
    expect(linkNeedsConfirm(undefined)).toBe(false);
    expect(linkNeedsConfirm('a'.repeat(32))).toBe(false);
    expect(linkNeedsConfirm('b'.repeat(32))).toBe(true);
  });
});
