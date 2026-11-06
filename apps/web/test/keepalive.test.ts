import type { CheckResult, VerifiedFacts } from '@recall/evidence';
import type { BatchInfo } from '@recall/net';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { classifyBatch } from '../src/keepalive/batch';
import { clearSentTopUp, loadSentTopUp, saveSentTopUp } from '../src/keepalive/sent';
import { datePassed, recordMoved, settle, type SettleIo } from '../src/keepalive/settle';
import { MAX_LIFETIME_BLOCKS, blocksForDays } from '@recall/net';
import { isVerifiedReport, type VerifiedReport } from '../src/verify/verify';

// The two gates in front of a keep-alive: only a capture whose checks all passed is offered one,
// and only a batch that really exists (with a size Recall creates) is ever priced or paid.

const facts: VerifiedFacts = {
  canonicalUrl: 'https://notice.recall.test/notice',
  urlHash: `0x${'11'.repeat(32)}` as Hex,
  serverName: 'notice.recall.test',
  httpStatus: 200,
  bodySha256: `0x${'a1'.repeat(32)}` as Hex,
  body: new Uint8Array([1]),
  contentType: 'text/html',
  signedAt: 1_000n,
  witness: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address,
};
const ok: CheckResult = { status: 'pass', detail: 'ok' };
const report = (over: Partial<VerifiedReport> = {}): VerifiedReport => ({ A: ok, B: ok, C: ok, facts, ...over });

describe('isVerifiedReport', () => {
  it('is true only when A, B and C all passed, for every combination of statuses', () => {
    const statuses = ['pass', 'warn', 'fail', 'unavailable'] as const;
    for (const a of statuses)
      for (const b of statuses)
        for (const c of statuses) {
          const r = report({ A: { status: a, detail: 'x' }, B: { status: b, detail: '200' }, C: { status: c, detail: 'x' } });
          expect(isVerifiedReport(r), `A=${a} B=${b} C=${c}`).toBe(a === 'pass' && b === 'pass' && c === 'pass');
        }
  });

  it('is false while checking, without facts, on a record that disagrees with its evidence, and for an impossible time', () => {
    expect(isVerifiedReport(null)).toBe(false);
    expect(isVerifiedReport(report({ facts: undefined }))).toBe(false);
    expect(isVerifiedReport(report({ mismatch: ['witness'] }))).toBe(false);
    expect(isVerifiedReport(report({ facts: { ...facts, signedAt: 2n ** 64n - 1n } }))).toBe(false);
  });
});

describe('classifyBatch', () => {
  const batch = (depth: number): BatchInfo => ({
    owner: '0x1111111111111111111111111111111111111111',
    depth,
    bucketDepth: 16,
    immutable: true,
    normalisedBalance: 1n,
  });

  it('a batch that does not exist is missing', () => {
    expect(classifyBatch(null)).toEqual({ kind: 'missing' });
  });

  it('depth 17 and 18 (what Recall creates) are fine, priced at their own depth', () => {
    expect(classifyBatch(batch(17))).toEqual({ kind: 'ok', depth: 17 });
    expect(classifyBatch(batch(18))).toEqual({ kind: 'ok', depth: 18 });
  });

  it('any other size is refused, so a crafted record cannot aim the payment at a huge batch', () => {
    expect(classifyBatch(batch(16))).toEqual({ kind: 'unsupported', depth: 16, why: 'depth' });
    expect(classifyBatch(batch(24))).toEqual({ kind: 'unsupported', depth: 24, why: 'depth' });
  });

  it('a mutable batch is refused: its owner could double its size between the preview and the payment', () => {
    expect(classifyBatch({ ...batch(17), immutable: false })).toEqual({ kind: 'unsupported', depth: 17, why: 'mutable' });
  });

  it('a bucket depth other than 16 is refused (buyBatch always makes 16)', () => {
    expect(classifyBatch({ ...batch(17), bucketDepth: 20 })).toEqual({ kind: 'unsupported', depth: 17, why: 'bucket' });
  });
});

describe('settle: did an earlier, unreported try go through?', () => {
  const hash = `0x${'ab'.repeat(32)}` as Hex;
  const io = (over: Partial<SettleIo> = {}): SettleIo & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      hash,
      waitMs: 1,
      receipt: async () => (calls.push('receipt'), 'absent'),
      wait: async () => (calls.push('wait'), 'timeout'),
      moved: async () => (calls.push('moved'), false),
      ...over,
    };
  };

  it('a mined receipt decides at once: success landed, reverted not landed', async () => {
    const a = io({ receipt: async () => 'success' });
    expect(await settle(a)).toBe('landed');
    expect(a.calls).toEqual([]); // nothing else was asked
    expect(await settle(io({ receipt: async () => 'reverted' }))).toBe('not-landed');
  });

  it('a hash the node cannot show is waited for, and a late receipt decides', async () => {
    expect(await settle(io({ wait: async () => 'success' }))).toBe('landed');
    expect(await settle(io({ wait: async () => 'reverted' }))).toBe('not-landed');
  });

  it('a sent step that cannot be seen and has not moved the chain is UNKNOWN, never "not sent"', async () => {
    expect(await settle(io())).toBe('unknown');
    // An unreadable node is the same: the answer is not "no".
    expect(
      await settle(io({ receipt: async () => Promise.reject(new Error('429')), wait: async () => Promise.reject(new Error('429')) })),
    ).toBe('unknown');
  });

  it('the chain showing the effect settles it as landed even when the hash is not visible', async () => {
    expect(await settle(io({ moved: async () => true }))).toBe('landed');
  });

  it('without a hash the chain decides: moved is landed, not moved is not landed, unreadable is unknown', async () => {
    expect(await settle(io({ hash: undefined, moved: async () => true }))).toBe('landed');
    expect(await settle(io({ hash: undefined, moved: async () => false }))).toBe('not-landed');
    expect(await settle(io({ hash: undefined, moved: async () => Promise.reject(new Error('down')) }))).toBe('unknown');
  });

  it('never calls the receipt reads when there is no hash', async () => {
    const a = io({ hash: undefined });
    await settle(a);
    expect(a.calls).toEqual(['moved']);
  });
});

describe('datePassed', () => {
  const at = (ms: number) => new Date(1_000_000_000_000 + ms);
  it('is true only for a date later by more than an hour, and null when either is unknown', () => {
    expect(datePassed(at(0), at(2 * 3_600_000))).toBe(true);
    expect(datePassed(at(0), at(1_000))).toBe(false);
    expect(datePassed(at(5_000), at(0))).toBe(false);
    expect(datePassed(null, at(0))).toBeNull();
    expect(datePassed(at(0), null)).toBeNull();
  });
});

describe('recordMoved: the viewed record, judged by its exact expiry block', () => {
  const rec = (expiresAtBlock: bigint) => ({
    entityKey: `0x${'11'.repeat(32)}` as Hex,
    expiresAtBlock,
    currentBlock: 1_000n,
    blockSeconds: 2,
  });
  it('any rise in the expiry block counts, however small', () => {
    const before = [rec(1_000n + blocksForDays(3))];
    expect(recordMoved(before, before[0]!.expiresAtBlock + blocksForDays(7), 7)).toBe(true);
    expect(recordMoved(before, before[0]!.expiresAtBlock + 1n, 7)).toBe(true);
    expect(recordMoved(before, before[0]!.expiresAtBlock, 7)).toBe(false);
    expect(recordMoved(before, before[0]!.expiresAtBlock - 1n, 7)).toBe(false);
  });
  it('a small gain next to the chain maximum is still moved', () => {
    const before = [rec(1_000n + MAX_LIFETIME_BLOCKS - blocksForDays(2))];
    expect(recordMoved(before, 1_000n + MAX_LIFETIME_BLOCKS, 7)).toBe(true);
    expect(recordMoved(before, before[0]!.expiresAtBlock, 7)).toBe(false);
  });
  it('a record already within a day of the maximum is left as it is: nothing was expected to move', () => {
    const before = [rec(1_000n + MAX_LIFETIME_BLOCKS - 60n)];
    expect(recordMoved(before, before[0]!.expiresAtBlock, 7)).toBe(true);
  });
  it('is null when the block (or the reading before) is missing', () => {
    expect(recordMoved([rec(5_000n)], null, 7)).toBeNull();
    expect(recordMoved([rec(5_000n)], undefined, 7)).toBeNull();
    expect(recordMoved([], 5_000n, 7)).toBeNull();
  });
});

describe('a step-1 top-up kept across a reload', () => {
  const batchId = `0x${'ab'.repeat(32)}` as Hex;
  const hash = `0x${'cd'.repeat(32)}` as Hex;
  const memory = () => {
    const m = new Map<string, string>();
    return {
      m,
      store: {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      },
    };
  };

  it('is read back as it was saved, keyed by the batch id', () => {
    const { m, store } = memory();
    saveSentTopUp({ batchId, hash, baseNormalised: 12_345_678_901_234_567_890n, baseEndsAt: 1_800_000_000_000 }, store);
    expect([...m.keys()]).toEqual([`recall.keepalive.topup.${batchId}`]);
    expect(loadSentTopUp(batchId, store)).toEqual({ batchId, hash, baseNormalised: 12_345_678_901_234_567_890n, baseEndsAt: 1_800_000_000_000 });
    // Another batch has nothing; the id is compared without case.
    expect(loadSentTopUp(`0x${'01'.repeat(32)}` as Hex, store)).toBeNull();
    expect(loadSentTopUp(batchId.toUpperCase().replace('0X', '0x') as Hex, store)).not.toBeNull();
  });

  it('keeps a step that has no hash yet (the wallet had not sent it)', () => {
    const { store } = memory();
    saveSentTopUp({ batchId, baseNormalised: 5n, baseEndsAt: null }, store);
    expect(loadSentTopUp(batchId, store)).toEqual({ batchId, baseNormalised: 5n, baseEndsAt: null });
  });

  it('is forgotten on a definite outcome', () => {
    const { store } = memory();
    saveSentTopUp({ batchId, hash, baseNormalised: 5n, baseEndsAt: null }, store);
    clearSentTopUp(batchId, store);
    expect(loadSentTopUp(batchId, store)).toBeNull();
  });

  it('ignores anything that is not a record this code wrote', () => {
    const { m, store } = memory();
    const key = `recall.keepalive.topup.${batchId}`;
    for (const bad of ['not json', '{}', JSON.stringify({ batchId, baseNormalised: '-1', baseEndsAt: null }), JSON.stringify({ batchId, baseNormalised: '5', hash: '0x12', baseEndsAt: null }), JSON.stringify({ batchId: `0x${'01'.repeat(32)}`, baseNormalised: '5', baseEndsAt: null }), JSON.stringify({ batchId, baseNormalised: '5', baseEndsAt: 'soon' })]) {
      m.set(key, bad);
      expect(loadSentTopUp(batchId, store)).toBeNull();
    }
  });

  it('survives a browser that refuses sessionStorage (nothing kept, nothing thrown)', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveSentTopUp({ batchId, baseNormalised: 1n, baseEndsAt: null }, broken)).not.toThrow();
    expect(loadSentTopUp(batchId, broken)).toBeNull();
    expect(() => clearSentTopUp(batchId, broken)).not.toThrow();
    expect(loadSentTopUp(batchId, null)).toBeNull();
    expect(() => saveSentTopUp({ batchId, baseNormalised: 1n, baseEndsAt: null }, null)).not.toThrow();
  });
});
