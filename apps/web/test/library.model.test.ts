import type { ListedAttachment, ListedCapture } from '@recall/net';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { daysLeft, filterSort, groupByPage, type PageEntry } from '../src/library/model';

const k = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const A = '0x1111111111111111111111111111111111111111' as Address;

function cap(n: number, over: Partial<ListedCapture> = {}): ListedCapture {
  return {
    entityKey: k(n),
    owner: A,
    creator: A,
    expiresAtBlock: 1000n,
    urlHash: k(100),
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

  it('groups urlHash case-insensitively and keeps pages apart', () => {
    const entries = groupByPage([cap(1), cap(2, { urlHash: k(100).toUpperCase().replace('0X', '0x') as Hex }), cap(3, { urlHash: k(101) })], []);
    expect(entries).toHaveLength(2);
  });

  it('marks a page as a repo when any of its captures has a git attachment', () => {
    const [e] = groupByPage([cap(1, { signedAt: 1n }), cap(2, { signedAt: 2n })], [att(k(1))]);
    expect(e!.kind).toBe('repo');
    const [p] = groupByPage([cap(1)], [att(k(1), 'other')]);
    expect(p!.kind).toBe('page');
  });

  it('shows host and path for hostile or broken addresses without throwing', () => {
    const [e] = groupByPage([cap(1, { canonicalUrl: 'not a url', serverName: 'x.example' })], []);
    expect(e!.address).toBe('x.example');
    const [long] = groupByPage([cap(2, { urlHash: k(5), canonicalUrl: `https://a.example/${'p'.repeat(5000)}` })], []);
    expect(long!.address.length).toBeLessThanOrEqual(200);
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
    const [e] = groupByPage([cap(n, { urlHash: k(n), signedAt: BigInt(n), canonicalUrl: `https://site${n}.example/p` })], []);
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
