// @vitest-environment jsdom
import { canonicalPageUrl, urlHash as hashUrl } from '@recall/evidence';
import type { ListedAttachment, ListedCapture } from '@recall/net';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupByPage } from '../src/library/model';
import type { CheckState, LibraryData } from '../src/library/useLibrary';

let current: LibraryData;
vi.mock('../src/library/useLibrary', () => ({ useLibrary: () => current }));

const { Library } = await import('../src/routes/Library');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = '0x1111111111111111111111111111111111111111' as Address;
const k = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const cap = (n: number, url: string): ListedCapture => ({
  entityKey: k(n),
  owner: A,
  creator: A,
  expiresAtBlock: 1n,
  urlHash: hashUrl(canonicalPageUrl(url)),
  bodySha256: k(200),
  serverName: new URL(url).host,
  witness: A,
  signedAt: BigInt(1_790_000_000 + n),
  httpStatus: 200,
  batchId: k(300),
  evidenceRef: k(400),
  canonicalUrl: url,
});
const git = (parent: Hex): ListedAttachment => ({
  entityKey: k(900),
  owner: A,
  creator: A,
  expiresAtBlock: 1n,
  parentCaptureKey: parent,
  urlHash: k(901),
  sha256: k(902),
  kind: 'git',
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  proofLevel: 1,
  evidenceRef: k(903),
  batchId: k(904),
  size: 1n,
  contentType: 'application/gzip',
});

function data(over: Partial<LibraryData> = {}, checks: [number, CheckState][] = []): LibraryData {
  const rows = [cap(1, 'https://gov.example/notice'), cap(2, 'https://api.github.com/repos/o/r/branches/main'), cap(3, 'https://news.example/a')];
  const entries = groupByPage(rows, [git(k(2))]);
  const hashOf = (n: number) => rows[n - 1]!.urlHash.toLowerCase() as Hex;
  return {
    status: 'ready',
    entries,
    captureCount: rows.length,
    truncated: false,
    check: new Map(checks.map(([n, s]) => [hashOf(n), s])),
    titles: new Map(),
    days: new Map([
      [hashOf(1), 30],
      [hashOf(2), 20],
      [hashOf(3), 10],
    ]),
    requestCheck: vi.fn(),
    retry: vi.fn(),
    refreshDays: vi.fn(async () => undefined),
    ...over,
  };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  window.location.hash = '#/library';
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (props: Parameters<typeof Library>[0] = {}) => act(() => root.render(<Library {...props} />));
const text = () => host.textContent ?? '';
const cards = () => [...host.querySelectorAll('[data-library-grid] > li')];

describe('Library page', () => {
  it('shows skeleton cards and a status line while Arkiv is read', () => {
    current = data({ status: 'loading', entries: [] });
    render();
    expect(host.querySelector('.lib-skel')).not.toBeNull();
    expect(text()).toContain('Reading the library from Arkiv');
    expect(host.querySelector('[data-status="verified"]')).toBeNull();
  });

  it('shows an honest error with Try again, which reads again', () => {
    current = data({ status: 'error', error: '429 Too Many Requests', entries: [] });
    render();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    expect(button).toBeDefined();
    act(() => button.click());
    expect(current.retry).toHaveBeenCalled();
    expect(host.querySelector('[data-status="verified"]')).toBeNull();
  });

  it('shows the duo and "Nothing forgotten yet" when nothing was captured', () => {
    current = data({ entries: [], captureCount: 0 });
    render();
    expect(text()).toContain('Nothing forgotten yet');
    expect(host.querySelector('a[href="#/"]')?.textContent).toBe('Capture the first page');
  });

  it('ranks by time left and asks for every shown card to be checked', () => {
    current = data();
    render();
    expect(cards()).toHaveLength(3);
    expect(text()).toContain('#1');
    expect(cards()[0]!.textContent).toContain('gov.example/notice');
    const asked = new Set(vi.mocked(current.requestCheck).mock.calls.map(([h]) => h));
    expect(asked).toEqual(new Set(current.entries.map((e) => e.urlHash)));
    expect(host.querySelector('[data-status="verified"]')).toBeNull(); // nothing was checked
    expect(host.querySelectorAll('[data-status="unchecked"]')).toHaveLength(3);
  });

  it('?type=repo hides the pages', () => {
    current = data();
    render({ type: 'repo' });
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.textContent).toContain('Repo');
  });

  it('sort=newest shows no ranks', () => {
    current = data();
    render({ sort: 'newest' });
    expect(cards()).toHaveLength(3);
    expect(text()).not.toMatch(/#\d/);
    expect(cards()[0]!.textContent).toContain('news.example/a');
  });

  it('keeps an unverified page behind "Show unverified (n)" until the switch is on', () => {
    current = data({}, [
      [1, 'verified'],
      [3, 'unverified'],
    ]);
    render();
    expect(cards()).toHaveLength(2);
    expect(text()).not.toContain('news.example/a');
    const toggle = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(toggle.textContent).toContain('Show unverified (1)');
    act(() => toggle.click());
    expect(text()).toContain('news.example/a');
    expect(text()).toContain('Unverified');
  });

  it('a search that matches nothing offers to clear it', async () => {
    current = data();
    render({ q: 'zzz' });
    expect(text()).toContain('No captures match this search.');
  });

  it('says when the list was cut at 1,000 captures', () => {
    current = data({ truncated: true });
    render();
    expect(text()).toContain('Showing the first 1,000 captures.');
  });
});
