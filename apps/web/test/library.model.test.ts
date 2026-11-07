import { canonicalPageUrl, urlHash as hashUrl } from '@recall/evidence';
import type { ListedAttachment, ListedCapture } from '@recall/net';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { daysLeft, filterSort, groupByPage, shortAddress, type PageEntry } from '../src/library/model';

const k = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const A = '0x1111111111111111111111111111111111111111' as Address;

const uh = (url: string): Hex => hashUrl(canonicalPageUrl(url));

function cap(n: number, over: Partial<ListedCapture> = {}): ListedCapture {
  const canonicalUrl = over.canonicalUrl ?? 'https://gov.example/notice';
  return {
    entityKey: k(n),
    owner: A,
    creator: A,
    expiresAtBlock: 1000n,
    urlHash: over.urlHash ?? uh(canonicalUrl),
    bodySha256: k(200),
    serverName: 'gov.example',
    witness: A,
    signedAt: 1_700_000_000n,
    httpStatus: 200,
    batchId: k(300),
    evidenceRef: k(400),
    canonicalUrl: 'https://gov.example/notice',
    ...over,
  };
}

const att = (parent: Hex, kind = 'git'): ListedAttachment => ({
  entityKey: k(900),
  owner: A,
  creator: A,
  expiresAtBlock: 1n,
  parentCaptureKey: parent,
  urlHash: k(901),
  sha256: k(902),
  kind,
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  proofLevel: 1,
  evidenceRef: k(903),
  batchId: k(904),
  size: 1n,
  contentType: 'application/gzip',
});

describe('groupByPage', () => {
  it('makes one entry per page, counting versions and picking the newest by signed time', () => {
    const entries = groupByPage([cap(1, { signedAt: 5n, expiresAtBlock: 10n }), cap(2, { signedAt: 9n, expiresAtBlock: 20n })], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.versions).toBe(2);
    expect(entries[0]!.newest.entityKey).toBe(k(2));
    expect(entries[0]!.signedAt).toBe(9n);
    expect(entries[0]!.address).toBe('gov.example/notice');
    expect(entries[0]!.kind).toBe('page');
  });

  it('breaks a signed-time tie with the larger record key', () => {
    const [e] = groupByPage([cap(7, { signedAt: 5n }), cap(3, { signedAt: 5n })], []);
    expect(e!.newest.entityKey).toBe(k(7));
  });

  it('breaks a signed-time tie with the record written first, so a later copy cannot take over the card', () => {
    const first = cap(3, { signedAt: 5n, createdAtBlock: 100n, batchId: k(301) });
    const copy = cap(7, { signedAt: 5n, createdAtBlock: 200n, batchId: k(302) });
    for (const rows of [[first, copy], [copy, first]]) {
      const [e] = groupByPage(rows, []);
      expect(e!.newest.entityKey).toBe(k(3));
      expect(e!.newest.batchId).toBe(k(301));
      expect(e!.older!.map((r) => r.entityKey)).toEqual([k(7)]);
    }
    const third = cap(5, { signedAt: 5n, createdAtBlock: 150n });
    const [e] = groupByPage([copy, third, first], []);
    expect([e!.newest, ...e!.older!].map((r) => r.entityKey)).toEqual([k(3), k(5), k(7)]);
  });

  it('falls back to the larger record key on a signed-time tie when either record has no creation block', () => {
    const [a] = groupByPage([cap(3, { signedAt: 5n, createdAtBlock: 100n }), cap(7, { signedAt: 5n })], []);
    expect(a!.newest.entityKey).toBe(k(7));
    const [b] = groupByPage([cap(3, { signedAt: 5n }), cap(7, { signedAt: 5n, createdAtBlock: 200n })], []);
    expect(b!.newest.entityKey).toBe(k(7));
    const [c] = groupByPage([cap(3, { signedAt: 5n, createdAtBlock: 100n }), cap(7, { signedAt: 5n, createdAtBlock: 100n })], []);
    expect(c!.newest.entityKey).toBe(k(7));
  });

  it('ignores the creation block when the signed times differ', () => {
    const [e] = groupByPage([cap(3, { signedAt: 5n, createdAtBlock: 100n }), cap(7, { signedAt: 9n, createdAtBlock: 200n })], []);
    expect(e!.newest.entityKey).toBe(k(7));
    expect(e!.older!.map((r) => r.entityKey)).toEqual([k(3)]);
  });

  it('groups urlHash case-insensitively and keeps pages apart', () => {
    const upper = uh('https://gov.example/notice').toUpperCase().replace('0X', '0x') as Hex;
    const entries = groupByPage([cap(1), cap(2, { urlHash: upper }), cap(3, { canonicalUrl: 'https://other.example/' })], []);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.address === 'gov.example/notice')!.versions).toBe(2);
  });

  it('marks a page as a repo when any of its captures has a git attachment', () => {
    const [e] = groupByPage([cap(1, { signedAt: 1n }), cap(2, { signedAt: 2n })], [att(k(1))]);
    expect(e!.kind).toBe('repo');
    const [p] = groupByPage([cap(1)], [att(k(1), 'other')]);
    expect(p!.kind).toBe('page');
  });

  it('shows host and path for hostile or broken addresses without throwing', () => {
    const [e] = groupByPage([cap(1, { canonicalUrl: 'not a url', urlHash: k(5), serverName: 'x.example' })], []);
    expect(e!.address).toBe('x.example');
    expect(e!.junk).toBe(true);
    const [long] = groupByPage([cap(2, { canonicalUrl: `https://a.example/${'p'.repeat(5000)}` })], []);
    expect(long!.junk).toBeUndefined();
    expect(long!.address.length).toBeLessThanOrEqual(200);
  });
});

describe('groupByPage: records whose address does not hash to their urlHash', () => {
  it('are their own unverified card: they never join, outnumber or replace a real page', () => {
    const real = cap(1, { signedAt: 5n });
    // Claims the real page's urlHash but names another address, and claims to be newer.
    const spoof = cap(2, { urlHash: real.urlHash, canonicalUrl: 'https://evil.example/fake', signedAt: 99n });
    const entries = groupByPage([real, spoof], []);
    expect(entries).toHaveLength(2);
    const page = entries.find((e) => !e.junk)!;
    expect(page.versions).toBe(1);
    expect(page.newest.entityKey).toBe(k(1));
    const junk = entries.find((e) => e.junk)!;
    expect(junk.urlHash).toBe(k(2)); // its own id: the record key, never the page's
    expect(junk.address).toBe('evil.example/fake');
  });
});

describe('shortAddress', () => {
  it('keeps short addresses and the host, and cuts the middle of the path so the end shows', () => {
    expect(shortAddress('gov.example/notice')).toBe('gov.example/notice');
    const a = shortAddress('localhostwastaken.github.io/Recall/notice/?run=0tzgmo55');
    const b = shortAddress('localhostwastaken.github.io/Recall/notice/?run=xbvmqf0p');
    expect(a).toContain('?run=0tzgmo55');
    expect(a.startsWith('localhostwastaken.')).toBe(true);
    expect(shortAddress('gov.example/a/very/long/path/to/the/notice?id=7')).toBe('gov.example/…path/to/the/notice?id=7');
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(36);
    const long = shortAddress(`${'h'.repeat(80)}.example/p`);
    expect(long.length).toBe(36);
    expect(long).toContain('…');
  });

  it('includes the query, so two pages that differ only by it get different addresses', () => {
    const entries = groupByPage([cap(1, { canonicalUrl: 'https://a.example/n/?run=1' }), cap(2, { canonicalUrl: 'https://a.example/n/?run=2' })], []);
    expect(entries.map((e) => e.address).sort()).toEqual(['a.example/n/?run=1', 'a.example/n/?run=2']);
  });
});

describe('daysLeft', () => {
  it('floors whole days and never goes below zero', () => {
    expect(daysLeft(1000n + 43_200n * 3n + 100n, 1000n, 2)).toBe(3);
    expect(daysLeft(1000n + 43_199n, 1000n, 2)).toBe(0);
    expect(daysLeft(10n, 1000n, 2)).toBe(0);
  });
});

describe('filterSort', () => {
  const page = (n: number, over: Partial<PageEntry> = {}): PageEntry => {
    const [e] = groupByPage([cap(n, { signedAt: BigInt(n), canonicalUrl: `https://site${n}.example/p` })], []);
    return { ...e!, ...over };
  };
  const a = page(1, { address: 'gov.example/notice' });
  const b = page(2, { kind: 'repo', repo: 'owner/tool' });
  const c = page(3);
  const days = new Map<Hex, number | null>([
    [a.urlHash, 10],
    [b.urlHash, null],
    [c.urlHash, 50],
  ]);
  const view = { q: '', type: 'all' as const, sort: 'time' as const };

  it('searches address, repo and title, ignoring case', () => {
    expect(filterSort([a, b, c], { ...view, q: 'GOV' }, new Map(), days)).toEqual([a]);
    expect(filterSort([a, b, c], { ...view, q: 'Owner/T' }, new Map(), days)).toEqual([b]);
    expect(filterSort([a, b, c], { ...view, q: 'terms' }, new Map([[c.urlHash, 'Terms of Service']]), days)).toEqual([c]);
  });

  it('filters by type', () => {
    expect(filterSort([a, b, c], { ...view, type: 'repo' }, new Map(), days)).toEqual([b]);
    expect(filterSort([a, b, c], { ...view, type: 'page' }, new Map(), days)).toEqual([c, a]);
  });

  it('sorts by time left, newest and ending soon (unknown days last)', () => {
    expect(filterSort([a, b, c], view, new Map(), days).map((e) => e.urlHash)).toEqual([c.urlHash, a.urlHash, b.urlHash]);
    expect(filterSort([a, b, c], { ...view, sort: 'newest' }, new Map(), days).map((e) => e.urlHash)).toEqual([c.urlHash, b.urlHash, a.urlHash]);
    expect(filterSort([a, b, c], { ...view, sort: 'ending' }, new Map(), days).map((e) => e.urlHash)).toEqual([a.urlHash, c.urlHash, b.urlHash]);
  });
});
