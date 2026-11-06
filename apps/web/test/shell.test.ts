// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '../src/components/SiteFooter';
import { SiteHeader } from '../src/components/SiteHeader';
import { parseHash, type Route } from '../src/router';
import { flushPendingSection } from '../src/sectionNav';

const theme = vi.hoisted(() => ({ current: 'light' as 'light' | 'dark', set: vi.fn() }));
vi.mock('../src/theme', () => ({
  useTheme: () => [theme.current, theme.set],
  setTheme: theme.set,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LIBRARY = { name: 'library', q: '', type: 'all', sort: 'time' } as unknown as Route;

let host: HTMLElement;
let root: Root;

function render(el: ReturnType<typeof createElement>) {
  act(() => root.render(el));
}

const header = () => host.querySelector('header')!;
const toggle = () => header().querySelector<HTMLButtonElement>('button[aria-label^="Switch to"]')!;
const menuButton = () => header().querySelector<HTMLButtonElement>('button[aria-label="Menu"]')!;

beforeEach(() => {
  theme.current = 'light';
  theme.set.mockClear();
  window.location.hash = '#/settings';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.replaceChildren();
});

describe('SiteHeader', () => {
  it('has the logo link home, a Library link, the theme toggle and the wallet chip', () => {
    render(createElement(SiteHeader, { route: parseHash('#/settings') }));
    const brand = header().querySelector<HTMLAnchorElement>('a.brand')!;
    expect(brand.getAttribute('href')).toBe('#/');
    expect(brand.getAttribute('aria-label')).toMatch(/home/i);
    expect(brand.textContent).toContain('Recall');
    const library = [...header().querySelectorAll('a')].find((a) => a.textContent === 'Library')!;
    expect(library.getAttribute('href')).toBe('#/library');
    expect(library.getAttribute('aria-current')).toBeNull();
    expect(toggle().getAttribute('aria-label')).toBe('Switch to dark theme');
    expect(header().querySelector('.wallet-chip')).not.toBeNull();
    expect(header().textContent).toContain('Not connected');
  });

  it('marks Library as the current page on the library route', () => {
    render(createElement(SiteHeader, { route: LIBRARY }));
    const library = [...header().querySelectorAll('a')].find((a) => a.textContent === 'Library')!;
    expect(library.getAttribute('aria-current')).toBe('page');
  });

  it('the toggle switches to the other theme, and says so', () => {
    render(createElement(SiteHeader, { route: parseHash('#/settings') }));
    act(() => toggle().click());
    expect(theme.set).toHaveBeenCalledWith('dark');

    theme.current = 'dark';
    render(createElement(SiteHeader, { route: parseHash('#/settings') }));
    expect(toggle().getAttribute('aria-label')).toBe('Switch to light theme');
    act(() => toggle().click());
    expect(theme.set).toHaveBeenLastCalledWith('light');
  });

  it('the phone menu opens, shows the rest, and closes on Escape and on an outside click', () => {
    render(createElement(SiteHeader, { route: parseHash('#/settings') }));
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(header().querySelector('.header-menu')).toBeNull();

    act(() => menuButton().click());
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    const panel = header().querySelector<HTMLElement>('.header-menu')!;
    expect(menuButton().getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.textContent).toContain('How it works');
    expect(panel.textContent).toContain('Sponsors');
    expect(panel.textContent).toContain('Get the extension');
    expect(panel.querySelector('.wallet-chip')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menuButton());

    act(() => menuButton().click());
    expect(header().querySelector('.header-menu')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(header().querySelector('.header-menu')).toBeNull();
  });

  it('section links scroll on the landing page and go there first from any other page', () => {
    const target = document.createElement('section');
    target.id = 'sponsors';
    document.body.append(target);

    window.location.hash = '#/';
    render(createElement(SiteHeader, { route: parseHash('#/') }));
    const link = [...header().querySelectorAll('a')].find((a) => a.textContent === 'Sponsors')!;
    act(() => link.click());
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);

    window.location.hash = '#/settings';
    render(createElement(SiteHeader, { route: parseHash('#/settings') }));
    const again = [...header().querySelectorAll('a')].find((a) => a.textContent === 'Sponsors')!;
    act(() => again.click());
    expect(window.location.hash).toBe('#/');
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    flushPendingSection();
    expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
  });
});

describe('SiteFooter', () => {
  it('keeps the sentence and the Advanced settings link, and adds the judges\' links', () => {
    render(createElement(SiteFooter, { route: parseHash('#/settings') }));
    const footer = host.querySelector('footer')!;
    expect(footer.textContent).toContain('No trackers. Verification runs in your browser.');
    const settings = [...footer.querySelectorAll('a')].find((a) => a.textContent === 'Advanced settings')!;
    expect(settings.getAttribute('href')).toBe('#/settings');
    expect(settings.getAttribute('aria-current')).toBe('page');
    expect(footer.textContent).toContain('For judges:');

    const hrefs = Object.fromEntries(
      [...footer.querySelectorAll<HTMLAnchorElement>('ul a')].map((a) => [a.textContent!.replace(/ \(opens in a new tab\)$/, ''), a]),
    );
    expect(Object.keys(hrefs)).toEqual(['GitHub repo', 'Demo video', 'Arkiv notes', 'Run one query yourself']);
    expect(hrefs['GitHub repo'].href).toBe('https://github.com/localhostwastaken/Recall');
    expect(hrefs['Demo video'].href).toBe('https://github.com/localhostwastaken/Recall#demo');
    expect(hrefs['Arkiv notes'].href).toBe('https://github.com/localhostwastaken/Recall/tree/main/arkiv');
    expect(hrefs['Run one query yourself'].href).toBe('https://github.com/localhostwastaken/Recall#writer-wallets');
    for (const a of Object.values(hrefs)) {
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
    }
  });
});
