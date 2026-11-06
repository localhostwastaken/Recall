// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentTheme, getStoredTheme, initTheme, setTheme, systemTheme } from '../src/theme';

// The theme module against jsdom's localStorage, with matchMedia stubbed (jsdom has none).

function stubMatchMedia(dark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', () => mq);
  window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
  return {
    flip(next: boolean) {
      mq.matches = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  stubMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('theme', () => {
  it('setTheme stores the choice and sets data-theme on <html>', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(getStoredTheme()).toBe('dark');
    expect(currentTheme()).toBe('dark');
    setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(getStoredTheme()).toBe('light');
  });

  it('setTheme tells listeners with a recall-theme event', () => {
    const seen: string[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent<string>).detail);
    window.addEventListener('recall-theme', on);
    setTheme('dark');
    window.removeEventListener('recall-theme', on);
    expect(seen).toEqual(['dark']);
  });

  it('without a stored choice the system setting decides', () => {
    expect(getStoredTheme()).toBeNull();
    expect(systemTheme()).toBe('light');
    stubMatchMedia(true);
    expect(systemTheme()).toBe('dark');
    expect(currentTheme()).toBe('dark');
  });

  it('ignores a stored value that is not a theme', () => {
    localStorage.setItem('recall.theme', 'sepia');
    expect(getStoredTheme()).toBeNull();
    expect(currentTheme()).toBe(systemTheme());
  });

  it('a throwing localStorage falls back to the system theme and never crashes setTheme', () => {
    stubMatchMedia(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(getStoredTheme()).toBeNull();
    expect(currentTheme()).toBe(systemTheme());
    expect(currentTheme()).toBe('dark');
    expect(() => setTheme('light')).not.toThrow();
    // The choice still applies to this page view.
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('a missing matchMedia means light', () => {
    vi.unstubAllGlobals();
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(systemTheme()).toBe('light');
  });

  it('initTheme follows the system live until the person chooses', () => {
    const media = stubMatchMedia(false);
    const stop = initTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    media.flip(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    setTheme('light');
    media.flip(false);
    media.flip(true);
    // An explicit choice wins over the system.
    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
  });
});
