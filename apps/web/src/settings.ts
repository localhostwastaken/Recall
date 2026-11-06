export type Theme = 'light';
export type Settings = { extensionId: string; theme: Theme };

// "Saved in this browser only." Reads and writes never throw: storage can be blocked.
const KEY = 'recall.web.settings.v1';

const DEFAULTS: Settings = {
  extensionId: import.meta.env.VITE_RECALL_EXTENSION_ID ?? '',
  theme: 'light',
};

export function getSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Settings>;
      return {
        extensionId: typeof p.extensionId === 'string' ? p.extensionId : DEFAULTS.extensionId,
        // Legacy dark/system preferences must not override the light-only product.
        theme: 'light',
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

/** Keep native controls and old persisted preferences on the product's light theme. */
export function applyTheme(): void {
  document.documentElement.setAttribute('data-theme', 'light');
}
