import { useSyncExternalStore } from 'react';

// Dark and light themes. The site follows the visitor's system setting; an explicit choice
// (the header toggle) overrides it and is remembered in localStorage. That storage is a
// per-viewer convenience only: every access is wrapped, and without it the system theme is used.
// The theme is applied as [data-theme=dark|light] on <html> (index.html sets it before first
// paint, so a dark system never flashes light).

export type Theme = 'light' | 'dark';

const KEY = 'recall.theme';
const EVENT = 'recall-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
// The browser-chrome colour of each theme (the value of --bg); index.html uses the same two.
const CHROME: Record<Theme, string> = { light: '#f4f5f2', dark: '#000000' };

// The choice made in this page view. It backs up localStorage: when storage is blocked (private
// mode) the choice still holds for the whole page view, and a system change does not override it.
let session: Theme | null = null;

export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    // Blocked storage: fall through to this page view's own choice.
  }
  return session;
}

export function systemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function currentTheme(): Theme {
  return getStoredTheme() ?? systemTheme();
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  // Keep the browser chrome (address bar) in step with an explicit choice, whatever the media
  // attribute of each meta says.
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', CHROME[theme]);
}

/** Remember an explicit choice, apply it and tell every listener (the toggle, other hooks). */
export function setTheme(theme: Theme): void {
  session = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode or blocked storage: the choice still holds for this page view (see `session`).
  }
  apply(theme);
  window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: theme }));
}

/**
 * Apply the current theme and keep it right: while the person has made no explicit choice the
 * page follows the system setting live; a choice made in another tab is picked up too.
 * Call once at start-up. Returns the cleanup.
 */
export function initTheme(): () => void {
  apply(currentTheme());
  let mq: MediaQueryList | null = null;
  try {
    mq = window.matchMedia(DARK_QUERY);
  } catch {
    mq = null;
  }
  const sync = () => {
    apply(currentTheme());
    window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: currentTheme() }));
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) sync();
  };
  mq?.addEventListener?.('change', sync);
  window.addEventListener('storage', onStorage);
  return () => {
    mq?.removeEventListener?.('change', sync);
    window.removeEventListener('storage', onStorage);
  };
}

function subscribe(onChange: () => void): () => void {
  let mq: MediaQueryList | null = null;
  try {
    mq = window.matchMedia(DARK_QUERY);
  } catch {
    mq = null;
  }
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  mq?.addEventListener?.('change', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
    mq?.removeEventListener?.('change', onChange);
  };
}

/** The theme in effect and a setter, for the toggle. Re-renders on any change. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light' as Theme);
  return [theme, setTheme];
}
