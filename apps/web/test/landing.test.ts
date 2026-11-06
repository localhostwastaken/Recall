// @vitest-environment jsdom
import type { VerifiedFacts } from '@recall/evidence';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedCapture } from '../src/verify/useVerifiedCapture';
import { unavailableReport, type VerifiedReport } from '../src/verify/verify';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = '0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244';

let capture: VerifiedCapture;
let counts: { captures: number; sites: number; repos: number } | null = null;

vi.mock('../src/verify/useVerifiedCapture', () => ({
  useVerifiedCapture: () => capture,
  verifyRecordEvidence: vi.fn(),
}));
vi.mock('../src/landing/LibraryPreview', async () => {
  const { createElement: h } = await import('react');
  return {
    LibraryPreview: () =>
      h('section', { id: 'library-preview', className: 'lib-preview' }, h('h2', null, 'The public library')),
    useLibraryCounts: () => counts,
  };
});
vi.mock('../src/brand/Duo', async () => {
  const { createElement: h } = await import('react');
  return { Duo: ({ className }: { className?: string }) => h('svg', { className: `duo ${className ?? ''}` }) };
});
// The hero story is exercised in heroStory.test.ts; here the page renders its final state.
vi.mock('../src/landing/heroStory', () => ({
  playHeroStory: () => ({ kill() {}, playing: () => false }),
  followPointer: () => () => {},
  popPill: () => {},
  popReceiptCheck: () => {},
}));

const { Home } = await import('../src/routes/Home');

const record = {
  entityKey: KEY,
  urlHash: `0x${'1d'.repeat(32)}`,
  bodySha256: `0x${'99'.repeat(32)}`,
  witness: `0x${'ab'.repeat(20)}`,
  signedAt: 1793945366n,
  batchId: `0x${'de'.repeat(32)}`,
  evidenceRef: `0x${'4d'.repeat(32)}`,
  expiresAtBlock: 999_999n,
  creator: `0x${'cd'.repeat(20)}`,
} as VerifiedCapture['record'];

const facts: VerifiedFacts = {
  canonicalUrl: 'https://localhostwastaken.github.io/Recall/notice/?run=0tzgmo55',
  urlHash: record!.urlHash,
  serverName: 'localhostwastaken.github.io',
  httpStatus: 200,
  bodySha256: record!.bodySha256,
  body: new TextEncoder().encode('<html><head><title> Admissions\n  Notice </title></head></html>'),
  contentType: 'text/html',
  signedAt: 1793945366n,
  witness: record!.witness,
};

const passing: VerifiedReport = {
  A: { status: 'pass', detail: 'ok' },
  B: { status: 'pass', detail: 'ok' },
  C: { status: 'pass', detail: 'ok' },
  facts,
  signer: record!.witness,
};

const base = (over: Partial<VerifiedCapture> = {}): VerifiedCapture => ({
  phase: 'ready',
  record,
  report: null,
  facts: null,
  storage: { phase: 'pending' },
  evidenceBytes: null,
  retry: vi.fn(),
  refreshStorage: vi.fn(async () => {}),
  ...over,
});

let root: Root;
let host: HTMLElement;

const render = () => act(() => root.render(createElement(Home)));
const text = () => host.textContent ?? '';
const heroPill = () => host.querySelector('.hero-card .ccard-pill')!.textContent;
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name) as HTMLButtonElement | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  counts = null;
  capture = base();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('landing page', () => {
  it('has the five sections with their headings and anchors', () => {
    render();
    const h2s = [...host.querySelectorAll('h2')].map((h) => h.textContent);
    for (const h of [
      'See it work on a real capture',
      'The public library',
      'Built on open infrastructure',
      'Capture your own in two minutes',
    ]) {
      expect(h2s).toContain(h);
    }
    for (const id of ['how-it-works', 'library-preview', 'sponsors', 'install']) {
      expect(host.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(host.querySelector('h1')!.getAttribute('aria-label')).toBe("The web forgets. Recall doesn't.");
  });

  it('shows "Checking…" on the hero card until the real verdict arrives, then "Verified"', () => {
    render();
    expect(heroPill()).toBe('Checking…');
    expect(host.querySelector('.pill-pass')).toBeNull();
    // The duo's receipt check stays grey until the verdict passed.
    expect(host.querySelector('.hero')!.classList.contains('is-verified')).toBe(false);
    capture = base({ report: passing, facts });
    render();
    expect(heroPill()).toBe('Verified');
    expect(host.querySelector('.hero')!.classList.contains('is-verified')).toBe(true);
    expect(host.querySelector('.hero-card .ccard-link')!.textContent).toBe('Admissions Notice');
  });

  it('"Run the checks" reveals the four rows, then offers the full proof', () => {
    render();
    expect(text()).toContain('Not checked yet');
    act(() => button('Run the checks')!.click());
    act(() => vi.advanceTimersByTime(1000));
    // The report has not arrived: rows show "Checking…", nothing is green, no proof link yet.
    expect(host.querySelectorAll('.try-check.is-revealed')).toHaveLength(4);
    expect(host.querySelector('#how-it-works .badge-pass')).toBeNull();
    expect(text()).not.toContain('Open the full proof');

    capture = base({
      report: passing,
      facts,
      storage: { phase: 'done', check: { status: 'pass', detail: 'stored' }, info: null },
    });
    render();
    const rows = [...host.querySelectorAll('.try-check')];
    expect(rows.map((r) => r.getAttribute('data-try-check'))).toEqual(['A', 'B', 'C', 'E']);
    expect(host.querySelectorAll('#how-it-works .badge-pass')).toHaveLength(4);
    const proof = [...host.querySelectorAll('a')].find((a) => a.textContent === 'Open the full proof')!;
    expect(proof.getAttribute('href')).toBe(`#/c/${KEY}`);
    expect(text()).toContain('Checks passed.');
  });

  it('reveals the rows one by one, 150 ms apart', () => {
    capture = base({ report: passing, facts });
    render();
    act(() => button('Run the checks')!.click());
    act(() => vi.advanceTimersByTime(160));
    expect(host.querySelectorAll('.try-check.is-revealed')).toHaveLength(1);
    act(() => vi.advanceTimersByTime(300));
    expect(host.querySelectorAll('.try-check.is-revealed')).toHaveLength(3);
  });

  it('never shows "Verified" when the evidence is unavailable', () => {
    capture = base({ report: unavailableReport('No Swarm gateway could provide the evidence file.') });
    render();
    act(() => button('Run the checks')!.click());
    act(() => vi.advanceTimersByTime(1000));
    expect(text()).not.toContain('Verified');
    expect(heroPill()).toBe('Not checked');
    expect(host.querySelector('.pill-pass, .badge-pass')).toBeNull();
    expect(host.querySelector('.hero.is-verified')).toBeNull();
    expect(text()).toContain("Couldn't fully verify.");
  });

  it('says "Not checked" and offers "Try again" when Arkiv cannot be read', () => {
    capture = base({ phase: 'error', record: null, error: 'fetch failed' });
    render();
    expect(heroPill()).toBe('Not checked');
    act(() => button('Run the checks')!.click());
    act(() => vi.advanceTimersByTime(1000));
    expect(text()).not.toContain('Verified');
    act(() => button('Try again')!.click());
    expect(capture.retry).toHaveBeenCalledOnce();
  });

  it('keeps the old tools behind a closed "More ways to check"', () => {
    render();
    const more = [...host.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent === 'More ways to check')!;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain('Find captures of a page');
    expect(more.textContent).toContain('Verify an evidence file');
    expect(more.textContent).toContain('Compare a file with captures');
  });

  it('shows the hero numbers only from 10 captures up', () => {
    counts = { captures: 4, sites: 2, repos: 0 };
    render();
    expect(host.querySelector('.hero-stats')).toBeNull();
    counts = { captures: 12, sites: 7, repos: 2 };
    render();
    expect(host.querySelector('.hero-stats')!.textContent).toBe('12 captures · 7 sites · 2 repos on Arkiv');
  });

  it('links the install step to the release and the faucet', () => {
    render();
    const hrefs = [...host.querySelectorAll('#install a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://github.com/localhostwastaken/Recall/releases/tag/v0.1.0-mumbai');
    expect(hrefs).toContain('https://hub.arkiv.network/faucet');
  });

  it('shows a screenshot on each install step, sized up front and loaded lazily', () => {
    render();
    const steps = [...host.querySelectorAll('#install .inst-step')];
    expect(steps.map((s) => s.querySelector('h3')?.textContent)).toEqual(['Download', 'Load it', 'Capture']);
    steps.forEach((step, i) => {
      const img = step.querySelector('img')!;
      // Relative, because the app is served from a subfolder (GitHub Pages) and from Swarm.
      expect(img.getAttribute('src')).toBe(`./install/step-${i + 1}.webp`);
      expect(img.getAttribute('alt')!.length).toBeGreaterThan(20);
      expect(img.getAttribute('width')).toBe('760');
      expect(img.getAttribute('height')).toBe('475');
      expect(img.getAttribute('loading')).toBe('lazy');
    });
    expect(steps[1].querySelector('img')!.getAttribute('alt')).toContain('Load unpacked');
  });
});
