// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The theme module against jsdom's localStorage, with matchMedia stubbed (jsdom has none). The
// module keeps this page view's own choice in a variable, so every test loads a fresh copy.

type ThemeModule = typeof import('../src/theme');
let theme: ThemeModule;

function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
  return {
    listeners,
    flip(next: boolean) {
      mq.matches = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

function chromeColors(): string[] {
  return [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content') ?? '');
}

function blockStorage() {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
}

beforeEach(async () => {
  vi.resetModules();
  theme = await import('../src/theme');
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML =
    '<meta name="theme-color" content="#f4f5f2" media="(prefers-color-scheme: light)">' +
    '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">';
  stubMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('theme', () => {
  it('setTheme stores the choice and sets data-theme on <html>', () => {
    theme.setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(theme.getStoredTheme()).toBe('dark');
    expect(theme.currentTheme()).toBe('dark');
    theme.setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(theme.getStoredTheme()).toBe('light');
  });

  it('setTheme tells listeners with a recall-theme event', () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener('recall-theme', on);
    theme.setTheme('dark');
    window.removeEventListener('recall-theme', on);
    expect(seen).toEqual(['dark']);
  });

  it('setTheme moves the browser chrome colour with the choice', () => {
    theme.setTheme('dark');
    expect(chromeColors()).toEqual(['#000000', '#000000']);
    theme.setTheme('light');
    expect(chromeColors()).toEqual(['#f4f5f2', '#f4f5f2']);
  });

  it('without a stored choice the system setting decides', () => {
    expect(theme.getStoredTheme()).toBeNull();
    expect(theme.systemTheme()).toBe('light');
    stubMatchMedia(true);
    expect(theme.systemTheme()).toBe('dark');
    expect(theme.currentTheme()).toBe('dark');
  });

  it('ignores a stored value that is not a theme', () => {
    localStorage.setItem('recall.theme', 'sepia');
    expect(theme.getStoredTheme()).toBeNull();
    expect(theme.currentTheme()).toBe(theme.systemTheme());
  });

  it('a throwing localStorage falls back to the system theme and never crashes setTheme', () => {
    stubMatchMedia(true);
    blockStorage();
    expect(theme.getStoredTheme()).toBeNull();
    expect(theme.currentTheme()).toBe(theme.systemTheme());
    expect(theme.currentTheme()).toBe('dark');
    expect(() => theme.setTheme('light')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('with storage blocked the choice still holds: currentTheme, a second toggle and system changes', () => {
    const media = stubMatchMedia(true);
    blockStorage();
    const stop = theme.initTheme();
    expect(theme.currentTheme()).toBe('dark');

    theme.setTheme('light');
    // The toggle reads currentTheme(): it must say light now, so the next click goes to dark.
    expect(theme.currentTheme()).toBe('light');
    theme.setTheme(theme.currentTheme() === 'light' ? 'dark' : 'light');
    expect(theme.currentTheme()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    theme.setTheme('light');

    // A system change must not override the explicit choice.
    media.flip(false);
    media.flip(true);
    expect(theme.currentTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(chromeColors()).toEqual(['#f4f5f2', '#f4f5f2']);
    stop();
  });

  it('a missing matchMedia means light', () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(theme.systemTheme()).toBe('light');
  });

  it('initTheme follows the system live until the person chooses', () => {
    const media = stubMatchMedia(false);
    const stop = theme.initTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    media.flip(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(chromeColors()).toEqual(['#000000', '#000000']);
    theme.setTheme('light');
    media.flip(false);
    media.flip(true);
    // An explicit choice wins over the system.
    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
  });

  it('initTheme picks up a choice made in another tab (storage event) and announces it', () => {
    stubMatchMedia(false);
    const stop = theme.initTheme();
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener('recall-theme', on);

    // Another tab wrote the choice; this tab only gets the event.
    localStorage.setItem('recall.theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'recall.theme', newValue: 'dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(seen).toEqual(['dark']);

    // Storage events about other keys are none of its business.
    localStorage.setItem('recall.theme', 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: 'something.else' }));
    expect(document.documentElement.dataset.theme).toBe('dark');

    // A cleared storage (key null) falls back to the system.
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(document.documentElement.dataset.theme).toBe('light');

    window.removeEventListener('recall-theme', on);
    stop();
  });

  it('the cleanup returned by initTheme removes both listeners', () => {
    const media = stubMatchMedia(false);
    const stop = theme.initTheme();
    expect(media.listeners.size).toBe(1);
    stop();
    expect(media.listeners.size).toBe(0);

    // After cleanup neither a system change nor a storage event touches the page.
    document.documentElement.dataset.theme = 'light';
    media.flip(true);
    expect(document.documentElement.dataset.theme).toBe('light');
    localStorage.setItem('recall.theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'recall.theme', newValue: 'dark' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
