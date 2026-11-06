export type Theme = 'system' | 'light' | 'dark';
export type Settings = { extensionId: string; theme: Theme };

// "Saved in this browser only." Reads and writes never throw: storage can be blocked.
const KEY = 'recall.web.settings.v1';

const DEFAULTS: Settings = {
  extensionId: import.meta.env.VITE_RECALL_EXTENSION_ID ?? '',
  theme: 'system',
};

export function getSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>;
      return {
        extensionId: typeof p.extensionId === 'string' ? p.extensionId : DEFAULTS.extensionId,
        theme: p.theme === 'light' || p.theme === 'dark' ? p.theme : 'system',
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULTS };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* not persisted; the page keeps working */
  }
  return next;
}

/** `data-theme` on <html>; "system" removes it so the media query decides. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
