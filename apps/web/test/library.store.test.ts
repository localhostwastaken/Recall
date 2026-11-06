// @vitest-environment jsdom
import { canonicalPageUrl, urlHash as hashUrl } from '@recall/evidence';
import type { ListedCapture } from '@recall/net';
import type { VerifiedFacts } from '@recall/evidence';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { Checked } from '../src/timeline/model';
import { createLibraryStore, type LibraryDeps } from '../src/library/useLibrary';

const k = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const A = '0x1111111111111111111111111111111111111111' as Address;
const uh = (n: number): Hex => hashUrl(canonicalPageUrl(`https://site${n}.example/p`));
const flush = () => new Promise((r) => setTimeout(r, 0));

const cap = (n: number): ListedCapture => ({
  entityKey: k(n),
  owner: A,
  creator: A,
  expiresAtBlock: 43_200n * 10n,
  urlHash: uh(n),
  bodySha256: k(200),
  serverName: `site${n}.example`,
  witness: A,
  signedAt: BigInt(n),
  httpStatus: 200,
  batchId: k(300),
  evidenceRef: k(400),
  canonicalUrl: `https://site${n}.example/p`,
});

const verified = (title: string, canonicalUrl = 'https://proven.example/page'): Checked => ({
  state: 'verified',
  facts: {
    body: new TextEncoder().encode(`<title>${title}</title>`),
    contentType: 'text/html',
    canonicalUrl,
    serverName: new URL(canonicalUrl).host,
  } as unknown as VerifiedFacts,
});

function deps(over: Partial<LibraryDeps> = {}): LibraryDeps {
  return {
    load: async () => ({ captures: [1, 2, 3, 4, 5].map(cap), attachments: [], truncated: false, timing: { currentBlock: 0n, blockSeconds: 2 } }),
    check: async (row) => verified(row.serverName),
    readExpiry: async () => ({ expiresAtBlock: 43_200n * 40n, currentBlock: 0n, blockSeconds: 2 }),
    ...over,
  };
}

describe('library store', () => {
  it('reads the rows once someone looks, with days left from the chain time', async () => {
    const store = createLibraryStore(deps());
    expect(store.getSnapshot().status).toBe('loading');
    const off = store.subscribe(() => undefined);
    await flush();
    const s = store.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.entries).toHaveLength(5);
    expect(s.captureCount).toBe(5);
    expect(s.days.get(uh(1))).toBe(10);
    expect(s.check.size).toBe(0); // nothing is "verified" before a check ran
    off();
  });

  it('shows an error when Arkiv cannot be read, and Try again reads again', async () => {
    let fail = true;
    const d = deps();
    const store = createLibraryStore({ ...d, load: () => (fail ? Promise.reject(new Error('429 Too Many Requests')) : d.load()) });
    store.subscribe(() => undefined);
    await flush();
    expect(store.getSnapshot().status).toBe('error');
    expect(store.getSnapshot().error).toBeTruthy();
    fail = false;
    store.retry();
    expect(store.getSnapshot().status).toBe('loading');
    await flush();
    expect(store.getSnapshot().status).toBe('ready');
  });

  it('checks at most three pages at a time, once each, and takes the title from the verified evidence', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const check = vi.fn(async (row: ListedCapture) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return verified(`Title ${row.serverName}`);
    });
    const store = createLibraryStore(deps({ check }));
    store.subscribe(() => undefined);
    await flush();
    for (const n of [1, 2, 3, 4, 5, 1, 2]) store.requestCheck(uh(n));
    await flush();
    expect(peak).toBe(3);
    expect(store.getSnapshot().check.get(uh(5))).toBe('checking');
    while (release.length) {
      release.shift()!();
      await flush();
      await flush();
    }
    expect(check).toHaveBeenCalledTimes(5);
    expect(peak).toBe(3);
    expect(store.getSnapshot().check.get(uh(1))).toBe('verified');
    expect(store.getSnapshot().titles.get(uh(1))).toBe('Title site1.example');
  });

  it('a failed check is unverified, never verified', async () => {
    const store = createLibraryStore(deps({ check: async () => ({ state: 'unverified', reason: 'x', status: 'fail' }) }));
    store.subscribe(() => undefined);
    await flush();
    store.requestCheck(uh(1));
    await flush();
    await flush();
    expect(store.getSnapshot().check.get(uh(1))).toBe('unverified');
    const crash = createLibraryStore(deps({ check: async () => Promise.reject(new Error('boom')) }));
    crash.subscribe(() => undefined);
    await flush();
    crash.requestCheck(uh(1));
    await flush();
    await flush();
    expect(crash.getSnapshot().check.get(uh(1))).toBe('unverified');
  });

  it('shows the address from the verified evidence once verified, never the row', async () => {
    const store = createLibraryStore(deps({ check: async () => verified('T', 'https://site1.example/p') }));
    store.subscribe(() => undefined);
    await flush();
    expect(store.getSnapshot().entries.find((e) => e.urlHash === uh(1))!.address).toBe('site1.example/p');
    const proven = createLibraryStore(deps({ check: async () => verified('T', 'https://proven.example/x') }));
    proven.subscribe(() => undefined);
    await flush();
    proven.requestCheck(uh(1));
    await flush();
    await flush();
    expect(proven.getSnapshot().entries.find((e) => e.urlHash === uh(1))!.address).toBe('proven.example/x');
  });

  it('marks junk rows (address not matching urlHash) unverified without checking them', async () => {
    const check = vi.fn(async () => verified('T'));
    const junk = { ...cap(9), urlHash: uh(1) , canonicalUrl: 'https://evil.example/' };
    const store = createLibraryStore(deps({ check, load: async () => ({ captures: [cap(1), junk], attachments: [], truncated: false, timing: null }) }));
    store.subscribe(() => undefined);
    await flush();
    const s = store.getSnapshot();
    expect(s.entries).toHaveLength(2);
    expect(s.check.get(k(9))).toBe('unverified');
    store.requestCheck(k(9));
    await flush();
    expect(check).not.toHaveBeenCalled();
  });

  it('a reloaded row with a changed field under the same key loses its verified result', async () => {
    let rows = [cap(1)];
    const store = createLibraryStore(deps({ load: async () => ({ captures: rows, attachments: [], truncated: false, timing: null }) }));
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    let off = store.subscribe(() => undefined);
    await flush();
    store.requestCheck(uh(1));
    await flush();
    await flush();
    expect(store.getSnapshot().check.get(uh(1))).toBe('verified');

    // Same row on a later read: the result is kept.
    off();
    now.mockReturnValue(2_000_000);
    off = store.subscribe(() => undefined);
    await flush();
    expect(store.getSnapshot().check.get(uh(1))).toBe('verified');

    // Same key, other evidence: checked again, not verified until then.
    off();
    rows = [{ ...cap(1), evidenceRef: k(999) }];
    now.mockReturnValue(3_000_000);
    store.subscribe(() => undefined);
    await flush();
    expect(store.getSnapshot().check.get(uh(1))).toBeUndefined();
    expect(store.getSnapshot().titles.get(uh(1))).toBeUndefined();
    now.mockRestore();
  });

  it('a newer record with bad evidence cannot hide a page: the next newest is checked instead', async () => {
    const real = { ...cap(1), expiresAtBlock: 43_200n * 20n };
    const bogus = { ...cap(1), entityKey: k(77), signedAt: 999n, evidenceRef: k(778) };
    const check = vi.fn(async (row: ListedCapture): Promise<Checked> =>
      row.entityKey === k(77) ? { state: 'unverified', reason: 'x', status: 'fail' } : verified('Real', 'https://site1.example/p'),
    );
    const store = createLibraryStore(deps({ check, load: async () => ({ captures: [real, bogus], attachments: [], truncated: false, timing: { currentBlock: 0n, blockSeconds: 2 } }) }));
    store.subscribe(() => undefined);
    await flush();
    expect(store.getSnapshot().entries[0]!.newest.entityKey).toBe(k(77));
    store.requestCheck(uh(1));
    for (let i = 0; i < 6; i++) await flush();
    const s = store.getSnapshot();
    expect(check).toHaveBeenCalledTimes(2);
    expect(s.check.get(uh(1))).toBe('verified');
    expect(s.entries[0]!.newest.entityKey).toBe(k(1));
    expect(s.entries[0]!.versions).toBe(2);
    expect(s.days.get(uh(1))).toBe(20);
  });

  it('gives up after three failed records of one page', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ ...cap(1), entityKey: k(n), signedAt: BigInt(n) }));
    const check = vi.fn(async (): Promise<Checked> => ({ state: 'unverified', reason: 'x', status: 'fail' }));
    const store = createLibraryStore(deps({ check, load: async () => ({ captures: rows, attachments: [], truncated: false, timing: null }) }));
    store.subscribe(() => undefined);
    await flush();
    store.requestCheck(uh(1));
    for (let i = 0; i < 10; i++) await flush();
    expect(check).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().check.get(uh(1))).toBe('unverified');
  });

  it('refreshDays re-reads the newest record and updates its days', async () => {
    const store = createLibraryStore(deps());
    store.subscribe(() => undefined);
    await flush();
    await store.refreshDays(uh(1));
    expect(store.getSnapshot().days.get(uh(1))).toBe(40);
  });
});
