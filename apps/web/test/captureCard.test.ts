// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CaptureCard, favLetter, lifeWidth, type CaptureCardProps } from '../src/components/CaptureCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(props: Partial<CaptureCardProps> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const base: CaptureCardProps = {
    title: 'Public notice',
    address: 'gov.example/notice',
    href: '#/c/0xabc',
    status: 'unchecked',
    kind: 'page',
    versions: 2,
    daysLeft: 21,
  };
  act(() => root!.render(createElement(CaptureCard, { ...base, ...props })));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('CaptureCard', () => {
  it('shows "Verified" with a check icon only for a verified capture', () => {
    const el = render({ status: 'verified' });
    const pill = el.querySelector('.ccard-pill')!;
    expect(pill.textContent).toBe('Verified');
    expect(pill.classList.contains('pill-pass')).toBe(true);
    expect(pill.querySelector('svg')).not.toBeNull();
  });

  it('shows "Checking…" in grey, never green, while checking', () => {
    const el = render({ status: 'checking' });
    expect(el.textContent).toContain('Checking…');
    expect(el.querySelector('.pill-pass')).toBeNull();
  });

  it('marks fewer than 7 days left as ending soon', () => {
    const el = render({ daysLeft: 4 });
    expect(el.querySelector('.ccard-life')!.classList.contains('is-soon')).toBe(true);
    expect(el.textContent).toContain('4 days left');
  });

  it('says "Time left unknown" when the expiry could not be read', () => {
    const el = render({ daysLeft: null });
    expect(el.querySelector('.ccard-life')!.classList.contains('is-unknown')).toBe(true);
    expect(el.textContent).toContain('Time left unknown');
  });

  it('shows the rank only when given', () => {
    expect(render({ rank: 1 }).textContent).toContain('#1');
    act(() => root?.unmount());
    expect(render().textContent).not.toContain('#');
  });

  it('opens the capture page from a link, with the keep-alive slot outside it', () => {
    const el = render({ keepAlive: createElement('button', { type: 'button' }, 'Keep alive') });
    const link = el.querySelector('a[href]')!;
    expect(link.getAttribute('href')).toBe('#/c/0xabc');
    expect(link.textContent).toBe('Public notice');
    const button = el.querySelector('button')!;
    expect(link.contains(button)).toBe(false);
    expect(button.closest('a')).toBeNull();
  });

  it('caps the life bar at 240 days and uses the site letter', () => {
    expect(lifeWidth(480)).toBe(100);
    expect(lifeWidth(24)).toBe(10);
    expect(lifeWidth(-3)).toBe(0);
    expect(favLetter('www.github.com/a/b')).toBe('G');
    expect(favLetter('https://notice.recall.test/x')).toBe('N');
  });
});
