import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Stylesheets go through the build's PostCSS pipeline, which a unit test does not need.
vi.mock('../../src/entries/Popup/onboarding.css', () => ({}));
vi.mock('../../src/entries/Popup/settingsAdvanced.css', () => ({}));
vi.mock('../../src/recall/ui/settings.css', () => ({}));
vi.mock('../../src/recall/ui/popupExtras.css', () => ({}));
// lucide-react is hoisted next to another React copy (webpack aliases it; the test runner does
// not), so the icons are plain aria-hidden <svg>s here.
vi.mock('lucide-react', async () => {
  const { createElement } = await import('react');
  const icon = (props: Record<string, unknown>) =>
    createElement('svg', { 'aria-hidden': props['aria-hidden'], className: props.className as string });
  const isIcon = (k: string | symbol) => typeof k === 'string' && /^[A-Z]/.test(k);
  return new Proxy({} as Record<string, unknown>, {
    get: (t, k) => (isIcon(k) ? icon : t[k as string]),
    has: (t, k) => isIcon(k) || k in t,
  });
});

import { Popup } from '../../src/entries/Popup/Popup';
import { Details } from '../../src/recall/ui/Details';
import { SuccessArt } from '../../src/recall/ui/SuccessArt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAGE = 'https://notice.recall.test/notice';
const WITNESS = '0x7a3E5fC2d4B1a9e8C6D0F2b3A4c5D6e7F8091a2B';
const SENT = '0x' + 'ab'.repeat(32);
const RECV = '0x' + 'cd'.repeat(32);
const BODY = '0x' + 'ef'.repeat(32);

const pass = (detail: string) => ({ status: 'pass' as const, detail });
const checks = {
  A: pass('hashes match'),
  B: pass('parsed'),
  C: pass('signature recovers the witness'),
  facts: {
    canonicalUrl: PAGE,
    serverName: 'notice.recall.test',
    httpStatus: 200,
    signedAt: '1793990000',
    witness: WITNESS,
    bodySha256: BODY,
    bodySize: 4321,
  },
};
const done = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  url: PAGE,
  startedAt: 1,
  status: 'done',
  finishedAt: 2,
  evidence: { signer: WITNESS, statement: { sentSha256: SENT, recvSha256: RECV } },
  checks,
  upload: { status: 'pending', captureId: 'c1' },
  ...over,
});

const listeners = () => ({ addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() });

function stubChrome(state: unknown) {
  const local: Record<string, unknown> = { 'recall.onboarded': true };
  globalThis.chrome = {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (p: string) => `/${p}`,
      onMessage: listeners(),
      sendMessage: vi.fn(async (msg: { type: string }) =>
        msg.type === 'recall.witnessStatus'
          ? { online: true }
          : msg.type === 'recall.earlierCaptures'
            ? { error: 'not in this test' }
            : undefined,
      ),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: PAGE }]),
      get: vi.fn(async () => ({ id: 1, url: PAGE })),
    },
    storage: {
      session: { get: vi.fn(async () => ({ 'recall.capture': state })), onChanged: listeners() },
      local: {
        get: vi.fn(async (k: string) => (k in local ? { [k]: local[k] } : {})),
        set: vi.fn(async () => undefined),
        onChanged: listeners(),
      },
    },
  } as unknown as typeof chrome;
}

let root: Root | undefined;
let host: HTMLElement | undefined;

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  host.id = 'root';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  // Let the popup's chrome.* promises settle.
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
const headings = (el: HTMLElement) => [...el.querySelectorAll('h1,h2,h3')].map((h) => h.textContent?.trim());

/** True when `node` sits in a closed <details> (or a hidden list), i.e. not on screen at first. */
function folded(node: Node): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.tagName === 'DETAILS' && !(el as HTMLDetailsElement).open) return true;
    if (el.hidden) return true;
  }
  return false;
}

/** Every text node containing `needle`. */
function textNodes(el: HTMLElement, needle: string): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent?.includes(needle)) out.push(n as Text);
  return out;
}

describe('popup: verified capture', () => {
  it('shows the success art on the "Continue in the Recall tab" notice, every label kept', async () => {
    stubChrome(done());
    const el = await render(<Popup />);

    const art = el.querySelector('[data-testid="popup-success-art"]');
    expect(art).not.toBeNull();
    expect(art!.getAttribute('aria-hidden')).toBe('true');
    // On the success notice itself, not a new state of the popup.
    const notice = art!.closest('.notice');
    expect(notice?.classList.contains('notice-success')).toBe(true);
    expect(notice?.querySelector('.notice-title')?.textContent).toBe('Continue in the Recall tab');

    // Every label the e2e specs and people rely on is still there.
    expect(headings(el)).toEqual(
      expect.arrayContaining(['Recall', 'This page', 'Capture result', 'Continue in the Recall tab', 'Checks passed']),
    );
    expect(buttons(el)).toEqual(
      expect.arrayContaining(['Settings', 'Open Recall tab', 'Show details', 'Capture this page']),
    );
    expect(el.textContent).toContain('The witness saw these exact bytes from notice.recall.test');
    expect(el.textContent).toContain(PAGE);
  });

  it('keeps hashes and the witness address folded away until asked for', async () => {
    stubChrome(done());
    const el = await render(<Popup />);
    for (const value of [SENT, RECV, BODY, WITNESS]) {
      const nodes = textNodes(el, value);
      expect(nodes.length, value).toBeGreaterThan(0);
      for (const n of nodes) expect(folded(n), value).toBe(true);
    }
    // The technical lines sit in the shared Details disclosure, closed by default.
    const how = el.querySelectorAll<HTMLDetailsElement>('details.rc-details');
    expect(how.length).toBe(3);
    for (const d of how) {
      expect(d.open).toBe(false);
      expect(d.querySelector('summary')?.textContent).toBe('How this was checked');
    }
  });

  it('has no success art when the witness is not trusted (the notice is not green)', async () => {
    stubChrome(done({ checks: { ...checks, C: { status: 'warn', detail: 'unknown signer' } } }));
    const el = await render(<Popup />);
    expect(el.querySelector('[data-testid="popup-success-art"]')).toBeNull();
    expect(headings(el)).toContain('Continue in the Recall tab');
  });
});

describe('popup: header and idle', () => {
  it('shows the logo before "Recall" without changing the heading name', async () => {
    stubChrome(undefined);
    const el = await render(<Popup />);
    const h1 = el.querySelector('h1.popup-title')!;
    expect(h1.textContent).toBe('Recall');
    const logo = h1.querySelector('svg.logo');
    expect(logo).not.toBeNull();
    expect(logo!.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('[data-testid="popup-success-art"]')).toBeNull();
    expect(buttons(el)).toContain('Capture this page');
  });
});

describe('Details', () => {
  it('is a closed native disclosure labelled "Details" by default', async () => {
    const el = await render(
      <Details>
        <span className="mono">0xabc</span>
      </Details>,
    );
    const d = el.querySelector('details')!;
    expect(d.classList.contains('rc-details')).toBe(true);
    expect(d.open).toBe(false);
    const summary = d.querySelector('summary')!;
    expect(summary.textContent).toBe('Details');
    // The chevron is decoration; the summary text is the accessible name.
    expect(summary.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(d.querySelector('.rc-details-body')?.textContent).toBe('0xabc');
  });

  it('takes a custom summary and keeps extra classes', async () => {
    const el = await render(
      <Details summary="How this was checked" className="check-how">
        x
      </Details>,
    );
    const d = el.querySelector('details')!;
    expect(d.className).toBe('rc-details check-how');
    expect(d.querySelector('summary')?.textContent).toBe('How this was checked');
  });
});

describe('SuccessArt', () => {
  it('is decorative and carries the test hook', async () => {
    const el = await render(<SuccessArt />);
    const svg = el.querySelector('svg')!;
    expect(svg.getAttribute('data-testid')).toBe('popup-success-art');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('popup-success-art')).toBe(true);
  });
});
