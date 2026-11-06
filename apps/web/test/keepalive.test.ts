import type { CheckResult, VerifiedFacts } from '@recall/evidence';
import type { BatchInfo } from '@recall/net';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { classifyBatch } from '../src/keepalive/batch';
import { datePassed, settle, type SettleIo } from '../src/keepalive/settle';
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
