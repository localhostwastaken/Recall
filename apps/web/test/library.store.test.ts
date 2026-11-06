// @vitest-environment jsdom
import type { ListedCapture } from '@recall/net';
import type { VerifiedFacts } from '@recall/evidence';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { Checked } from '../src/timeline/model';
import { createLibraryStore, type LibraryDeps } from '../src/library/useLibrary';

const k = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const A = '0x1111111111111111111111111111111111111111' as Address;
const flush = () => new Promise((r) => setTimeout(r, 0));

const cap = (n: number): ListedCapture => ({
  entityKey: k(n),
  owner: A,
  creator: A,
  expiresAtBlock: 43_200n * 10n,
  urlHash: k(100 + n),
  bodySha256: k(200),
  serverName: `site${n}.example`,
  witness: A,
  signedAt: BigInt(n),
  httpStatus: 200,
  batchId: k(300),
  evidenceRef: k(400),
  canonicalUrl: `https://site${n}.example/p`,
});

const verified = (title: string): Checked => ({
  state: 'verified',
  facts: { body: new TextEncoder().encode(`<title>${title}</title>`), contentType: 'text/html' } as unknown as VerifiedFacts,
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
    expect(s.days.get(k(101))).toBe(10);
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
    for (const n of [1, 2, 3, 4, 5, 1, 2]) store.requestCheck(k(100 + n));
    await flush();
    expect(peak).toBe(3);
    expect(store.getSnapshot().check.get(k(105))).toBe('checking');
    while (release.length) {
      release.shift()!();
      await flush();
      await flush();
    }
    expect(check).toHaveBeenCalledTimes(5);
    expect(peak).toBe(3);
    expect(store.getSnapshot().check.get(k(101))).toBe('verified');
    expect(store.getSnapshot().titles.get(k(101))).toBe('Title site1.example');
  });

  it('a failed check is unverified, never verified', async () => {
    const store = createLibraryStore(deps({ check: async () => ({ state: 'unverified', reason: 'x', status: 'fail' }) }));
    store.subscribe(() => undefined);
    await flush();
    store.requestCheck(k(101));
    await flush();
    await flush();
    expect(store.getSnapshot().check.get(k(101))).toBe('unverified');
    const crash = createLibraryStore(deps({ check: async () => Promise.reject(new Error('boom')) }));
    crash.subscribe(() => undefined);
    await flush();
    crash.requestCheck(k(101));
    await flush();
    await flush();
    expect(crash.getSnapshot().check.get(k(101))).toBe('unverified');
  });

  it('refreshDays re-reads the newest record and updates its days', async () => {
    const store = createLibraryStore(deps());
    store.subscribe(() => undefined);
    await flush();
    await store.refreshDays(k(101));
    expect(store.getSnapshot().days.get(k(101))).toBe(40);
  });
});
