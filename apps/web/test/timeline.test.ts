import type { CheckResult, VerifiedFacts } from '@recall/evidence';
import type { Listed } from '@recall/net';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildTimeline, classify, type Checked } from '../src/timeline/model';
import type { VerifiedReport } from '../src/verify/verify';

// The rules that decide what a timeline may show. A record is listed only when every check
// passed; everything else is hidden with a reason; and a confirmation counts only when it is
// consistent with the capture it names.

const WITNESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const URL_HASH = `0x${'11'.repeat(32)}` as Hex;
const BODY_1 = `0x${'a1'.repeat(32)}` as Hex;
const BODY_2 = `0x${'b2'.repeat(32)}` as Hex;
const key = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;

const facts = (over: Partial<VerifiedFacts> = {}): VerifiedFacts => ({
  canonicalUrl: 'https://notice.recall.test/notice',
  urlHash: URL_HASH,
  serverName: 'notice.recall.test',
  httpStatus: 200,
  bodySha256: BODY_1,
  body: new Uint8Array([1]),
  contentType: 'text/html',
  signedAt: 1_000n,
  witness: WITNESS,
  ...over,
});

const ok: CheckResult = { status: 'pass', detail: 'ok' };
const report = (over: Partial<VerifiedReport> = {}): VerifiedReport => ({ A: ok, B: ok, C: ok, facts: facts(), ...over });

describe('classify: only a full pass is verified', () => {
  it('lists a record whose A, B and C passed', () => {
    const c = classify(report(), URL_HASH);
    expect(c.state).toBe('verified');
  });

  it('never lists anything but A, B and C all passing (every other combination is hidden)', () => {
    const statuses = ['pass', 'warn', 'fail', 'unavailable'] as const;
    for (const a of statuses) {
      for (const b of statuses) {
        for (const c of statuses) {
          const r = report({ A: { status: a, detail: 'x' }, B: { status: b, detail: '200' }, C: { status: c, detail: 'x' } });
          const verdict = classify(r, URL_HASH);
          const allPass = a === 'pass' && b === 'pass' && c === 'pass';
          expect(verdict.state === 'verified', `A=${a} B=${b} C=${c}`).toBe(allPass);
        }
      }
    }
  });

  it('an unknown witness (C warns) is hidden, as a warning', () => {
    expect(classify(report({ C: { status: 'warn', detail: 'unknown witness' } }), URL_HASH)).toEqual({
      state: 'unverified',
      reason: 'Unknown witness',
      status: 'warn',
    });
  });

  it('gives the reason for each way a record fails', () => {
    const reason = (r: VerifiedReport) => {
      const c = classify(r, URL_HASH);
      return c.state === 'unverified' ? [c.reason, c.status] : ['verified'];
    };
    const bad = (detail = 'x'): CheckResult => ({ status: 'fail', detail });
    const na: CheckResult = { status: 'unavailable', detail: 'n/a' };
    expect(reason(report({ C: bad() }))).toEqual(['Signature invalid', 'fail']);
    expect(reason(report({ A: bad() }))).toEqual(["Bytes don't match", 'fail']);
    expect(reason(report({ A: bad(), malformed: 'not json' }))).toEqual(["Evidence file can't be read", 'fail']);
    expect(reason(report({ A: na, B: na, C: na }))).toEqual(["Evidence couldn't be downloaded", 'unavailable']);
    expect(reason(report({ B: bad() }))).toEqual(["Request or response isn't well-formed", 'fail']);
    expect(reason(report({ B: { status: 'warn', detail: '404' } }))).toEqual(['HTTP 404, not a normal page', 'warn']);
    expect(reason(report({ C: na }))).toEqual(["Signature couldn't be checked", 'unavailable']);
    expect(reason(report({ mismatch: ['content hash'] }))).toEqual(["Record doesn't match its evidence", 'fail']);
  });

  it('a record whose evidence is about another address is hidden', () => {
    const other = report({ facts: facts({ urlHash: `0x${'22'.repeat(32)}` as Hex }) });
    expect(classify(other, URL_HASH)).toMatchObject({ state: 'unverified', reason: 'Belongs to a different address' });
  });

  it('an impossible signed time is hidden even when every check passed', () => {
    const forever = report({ facts: facts({ signedAt: 2n ** 64n - 1n }) });
    expect(classify(forever, URL_HASH)).toMatchObject({ state: 'unverified', reason: 'Impossible capture time', status: 'fail' });
  });
});

const verified = (f: Partial<VerifiedFacts>): Checked => ({ state: 'verified', facts: facts(f) });
const capture = (n: number): Listed =>
  ({
    kind: 'capture',
    entityKey: key(n),
    owner: WITNESS,
    expiresAtBlock: 1n,
    urlHash: URL_HASH,
    bodySha256: BODY_1,
    serverName: 'notice.recall.test',
    witness: WITNESS,
    signedAt: 1n,
    httpStatus: 200,
    batchId: key(900),
    evidenceRef: key(901),
    canonicalUrl: 'https://notice.recall.test/notice',
  }) satisfies Listed;
const confirmation = (n: number, captureKey: Hex): Listed =>
  ({
    kind: 'confirmation',
    entityKey: key(n),
    owner: WITNESS,
    expiresAtBlock: 1n,
    captureKey,
    urlHash: URL_HASH,
    bodySha256: BODY_1,
    witness: WITNESS,
    signedAt: 1n,
    evidence: new Uint8Array(),
  }) satisfies Listed;

const results = (entries: [Hex, Checked][]) => new Map<Hex, Checked>(entries);

describe('buildTimeline: versions', () => {
  it('orders versions by their verified signed time, not by record key, and numbers them', () => {
    const t = buildTimeline(
      [capture(1), capture(2), capture(3)],
      results([
        [key(1), verified({ signedAt: 3_000n, bodySha256: BODY_2 })],
        [key(2), verified({ signedAt: 1_000n })],
        [key(3), verified({ signedAt: 2_000n, bodySha256: `0x${'c3'.repeat(32)}` as Hex })],
      ]),
    );
    expect(t.versions.map((v) => [v.n, v.entityKey, v.facts.signedAt])).toEqual([
      [1, key(2), 1_000n],
      [2, key(3), 2_000n],
      [3, key(1), 3_000n],
    ]);
  });

  it('collapses records that carry the same verified observation into one version', () => {
    const same = verified({ signedAt: 1_000n });
    const t = buildTimeline([capture(5), capture(4)], results([[key(5), same], [key(4), same]]));
    expect(t.versions).toHaveLength(1);
    expect(t.versions[0].entityKey).toBe(key(5)); // the first record in the listing
    expect(t.unverified).toEqual([]);
  });

  it('keeps two observations of the same bytes at different times as two versions', () => {
    const t = buildTimeline(
      [capture(1), capture(2)],
      results([[key(1), verified({ signedAt: 1_000n })], [key(2), verified({ signedAt: 2_000n })]]),
    );
    expect(t.versions).toHaveLength(2);
  });

  it('hides unverified records and lists their reason', () => {
    const t = buildTimeline(
      [capture(1), capture(2)],
      results([
        [key(1), verified({})],
        [key(2), { state: 'unverified', reason: 'Unknown witness', status: 'warn' }],
      ]),
    );
    expect(t.versions.map((v) => v.entityKey)).toEqual([key(1)]);
    expect(t.unverified).toEqual([{ entityKey: key(2), kind: 'capture', reason: 'Unknown witness', status: 'warn' }]);
  });

  it('a record with no result is pending, or not checked yet when it was not started, and is never a version', () => {
    const t = buildTimeline([capture(1), capture(2)], results([]), new Set([key(2)]));
    expect(t.versions).toEqual([]);
    expect(t.pending.map((p) => p.entityKey)).toEqual([key(1)]);
    expect(t.unchecked.map((p) => p.entityKey)).toEqual([key(2)]);
    expect(t.unverified).toEqual([]);
  });
});

describe('buildTimeline: confirmations', () => {
  const base = [capture(1)];
  const baseResults = (extra: [Hex, Checked][] = []): [Hex, Checked][] => [[key(1), verified({ signedAt: 1_000n })], ...extra];

  it('attaches a consistent confirmation under the capture it names', () => {
    const t = buildTimeline([...base, confirmation(2, key(1))], results(baseResults([[key(2), verified({ signedAt: 2_000n })]])));
    expect(t.versions[0].confirmations.map((c) => c.entityKey)).toEqual([key(2)]);
    expect(t.unverified).toEqual([]);
  });

  it('refuses a confirmation dated before (or at) the capture it confirms', () => {
    for (const at of [500n, 1_000n]) {
      const t = buildTimeline([...base, confirmation(2, key(1))], results(baseResults([[key(2), verified({ signedAt: at })]])));
      expect(t.versions[0].confirmations).toEqual([]);
      expect(t.unverified).toEqual([
        { entityKey: key(2), kind: 'confirmation', reason: 'Dated before the capture it confirms', status: 'fail' },
      ]);
    }
  });

  it('refuses a confirmation dated after a newer version: unchanged cannot hold across it', () => {
    const rows = [capture(1), capture(3), confirmation(2, key(1))];
    const t = buildTimeline(
      rows,
      results([
        [key(1), verified({ signedAt: 1_000n })],
        [key(3), verified({ signedAt: 2_000n, bodySha256: BODY_2 })], // the page changed
        [key(2), verified({ signedAt: 3_000n })], // ... and "still the first version" is claimed later
      ]),
    );
    expect(t.versions[0].confirmations).toEqual([]);
    expect(t.unverified).toEqual([
      { entityKey: key(2), kind: 'confirmation', reason: 'Dated after a newer version', status: 'fail' },
    ]);
  });

  it('accepts a confirmation signed between two versions', () => {
    const rows = [capture(1), capture(3), confirmation(2, key(1))];
    const t = buildTimeline(
      rows,
      results([
        [key(1), verified({ signedAt: 1_000n })],
        [key(3), verified({ signedAt: 3_000n, bodySha256: BODY_2 })],
        [key(2), verified({ signedAt: 2_000n })],
      ]),
    );
    expect(t.versions[0].confirmations.map((c) => c.entityKey)).toEqual([key(2)]);
  });

  it("refuses a confirmation of a capture that isn't shown", () => {
    // The named capture does not exist in the listing at all, or is itself unverified.
    const missing = buildTimeline([confirmation(2, key(77))], results([[key(2), verified({ signedAt: 2_000n })]]));
    expect(missing.unverified).toEqual([
      { entityKey: key(2), kind: 'confirmation', reason: "The capture it confirms isn't shown", status: 'unavailable' },
    ]);
    const hidden = buildTimeline(
      [capture(1), confirmation(2, key(1))],
      results([
        [key(1), { state: 'unverified', reason: 'Unknown witness', status: 'warn' }],
        [key(2), verified({ signedAt: 2_000n })],
      ]),
    );
    expect(hidden.versions).toEqual([]);
    expect(hidden.unverified.map((u) => [u.kind, u.reason])).toEqual([
      ['capture', 'Unknown witness'],
      ['confirmation', "The capture it confirms isn't shown"],
    ]);
  });

  it('refuses a confirmation of different bytes', () => {
    const t = buildTimeline([...base, confirmation(2, key(1))], results(baseResults([[key(2), verified({ signedAt: 2_000n, bodySha256: BODY_2 })]])));
    expect(t.versions[0].confirmations).toEqual([]);
    expect(t.unverified[0]).toMatchObject({ reason: "Doesn't match the capture it confirms" });
  });

  it('waits while the capture it names is being checked, and is not checked yet if that was not started', () => {
    const rows = [capture(1), confirmation(2, key(1))];
    const only = results([[key(2), verified({ signedAt: 2_000n })]]);
    const checking = buildTimeline(rows, only);
    expect(checking.pending.map((p) => p.entityKey)).toEqual([key(1), key(2)]);
    expect(checking.unverified).toEqual([]);
    const idle = buildTimeline(rows, only, new Set([key(1)]));
    expect(idle.unchecked.map((p) => p.entityKey)).toEqual([key(1), key(2)]);
    expect(idle.unverified).toEqual([]);
    expect(idle.versions).toEqual([]);
  });

  it('finds the capture even when the index wrote its key in another case', () => {
    const upper = `0x${'AB'.repeat(32)}` as Hex;
    const lowerKey = upper.toLowerCase() as Hex;
    const t = buildTimeline(
      [{ ...capture(1), entityKey: lowerKey }, confirmation(2, upper)],
      results([
        [lowerKey, verified({ signedAt: 1_000n })],
        [key(2), verified({ signedAt: 2_000n })],
      ]),
    );
    expect(t.pending).toEqual([]);
    expect(t.versions[0].confirmations.map((c) => c.entityKey)).toEqual([key(2)]);
  });

  it('shows the same confirmation published twice once', () => {
    const rows = [capture(1), confirmation(2, key(1)), confirmation(3, key(1))];
    const same = verified({ signedAt: 2_000n });
    const t = buildTimeline(rows, results([[key(1), verified({ signedAt: 1_000n })], [key(2), same], [key(3), same]]));
    expect(t.versions[0].confirmations).toHaveLength(1);
    expect(t.unverified).toEqual([]);
  });
});
