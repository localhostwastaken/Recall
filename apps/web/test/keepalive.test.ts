import type { CheckResult, VerifiedFacts } from '@recall/evidence';
import type { BatchInfo } from '@recall/net';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { classifyBatch } from '../src/keepalive/batch';
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
    expect(classifyBatch(batch(16))).toEqual({ kind: 'unsupported', depth: 16 });
    expect(classifyBatch(batch(24))).toEqual({ kind: 'unsupported', depth: 24 });
  });
});
