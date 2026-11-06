import { ADDRESS_ERROR, URL_ERROR, checkAddress, checkUrl } from '@recall/net';
import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { DEFAULT_WITNESS_LABEL, EXTENSION_ID, baseNetConfig, defaultExtensionId, defaultWitnessAddress } from './defaults';

/** Kept for settings saved by older versions; the app itself is light only (see applyTheme). */
export type Theme = 'system' | 'light' | 'dark';
export type PinnedWitness = { address: Address; label: string };

/**
 * What the person chose, "Saved in this browser only". Every field has a default (the network's
 * own configuration, see defaults.ts), so a missing or damaged value is replaced by its default.
 */
export type Settings = {
  /** The witnesses check C trusts. An empty list trusts nobody. */
  pinnedWitnesses: PinnedWitness[];
  arkivRpcUrl: string;
  /** The person's own Arkiv key. Empty means "use the built-in key" (R30), if the build has one. */
  arkivAccessKey: string;
  /** Swarm download gateways, tried in order. */
  downloadUrls: string[];
  uploadUrl: string;
  gnosisRpcUrl: string;
  /** The extension to talk to. The default is the release extension's fixed ID (defaults.ts). */
  extensionId: string;
  theme: Theme;
};

const KEY = 'recall.web.settings.v1';
const CHANGED = 'recall:settings-changed';

export { EXTENSION_ID };
export const MAX_LABEL = 40;
export const DEFAULT_ADDED_LABEL = 'Added witness';

export const EXTENSION_ID_ERROR = 'Enter the 32-letter ID shown on chrome://extensions.';
export const DUPLICATE_WITNESS_ERROR = 'That witness is already in the list.';
export const LABEL_ERROR = 'Enter a label for this witness.';
export const DOWNLOAD_ERROR = 'Enter at least one gateway address.';
export const KEY_ERROR = 'Paste only the key, without spaces and not as an address.';
export const LABEL_DEFAULT_ERROR = 'That label can\'t include the word "default". It is kept for the built-in witness.';
export { ADDRESS_ERROR, URL_ERROR };

/** What the Arkiv key field says, by whether the build has a key built in and whether one is typed. */
export function keyHelper(builtIn: boolean, own: boolean): string {
  if (builtIn) {
    return own
      ? 'Your own key is used instead of the built-in key. Clear this field, or use Reset to default, to go back to the built-in key.'
      : 'Built-in key (default) is in use. Paste your own key to replace it.';
  }
  return own ? 'Your key is used for the Arkiv RPC.' : 'Optional. A key can raise the limits of the Arkiv RPC.';
}


/**
 * A witness label as it is stored and shown: Unicode-normalised (NFKC, so full-width and
 * mathematical lookalikes become plain letters), without invisible format characters (zero-width
 * and bidirectional controls, \p{Cf}) or control characters, spaces collapsed, at most MAX_LABEL
 * long. A label can then neither hide a word nor reorder the text around it.
 */
export function cleanLabel(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Cc}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LABEL)
    .trim();
}

/** Letters of other alphabets that look like Latin ones, for the "default" check only. */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w', һ: 'h', ɡ: 'g',
  // Greek
  α: 'a', ε: 'e', ο: 'o', ρ: 'p', ι: 'i', ν: 'v', υ: 'u', τ: 't', χ: 'x', κ: 'k', β: 'b', γ: 'y',
  // Latin look-alikes outside ASCII
  ı: 'i', ł: 'l', ɑ: 'a', ƒ: 'f', ꜰ: 'f', ᴅ: 'd', ᴇ: 'e', ᴜ: 'u', ʟ: 'l', ᴛ: 't', ᴀ: 'a',
};

/** The letters of a label as a person would read them: no accents, no look-alike letters, lower case. */
function skeleton(label: string): string {
  const base = cleanLabel(label)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  return Array.from(base, (c) => LOOKALIKES[c] ?? c).join('');
}

/** The word "default" on its own (not "undefaulted"): only the built-in witness may carry it. */
const IMITATES_DEFAULT = /\bdefault\b/;
const imitatesDefault = (label: string): boolean => IMITATES_DEFAULT.test(skeleton(label));

/** A label for a witness the person adds: needed, and never imitating the built-in "(default)". */
export function labelError(label: string): string | undefined {
  const t = cleanLabel(label);
  if (!t) return LABEL_ERROR;
  return imitatesDefault(t) ? LABEL_DEFAULT_ERROR : undefined;
}

/**
 * R38. On a shared gateway origin (`https://<gateway>/bzz/<ref>/`) every Swarm site shares one
 * origin and so one localStorage: another site could plant a witness or an endpoint here. There
 * the app ignores stored settings except the theme and uses its built-in defaults. A path with
 * `/bzz/` anywhere in it counts (a prefix before it too), compared case-insensitively and after
 * percent-decoding. The app's own addresses (bzz.link subdomains, GitHub Pages, localhost) are
 * not shared.
 */
export function isSharedOrigin(pathname?: string): boolean {
  let path = pathname;
  if (path === undefined) {
    try {
      path = window.location.pathname;
    } catch {
      return false;
    }
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* an undecodable path is tested as written */
  }
  return /(^|\/)bzz\//i.test(decoded.replace(/\/{2,}/g, '/'));
}


/** The text fields of the Settings page that are validated on blur. `downloadText` holds one gateway per line. */
export type FieldKey = 'arkivRpcUrl' | 'arkivAccessKey' | 'downloadText' | 'uploadUrl' | 'gnosisRpcUrl' | 'extensionId';

export const gatewayLines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

/** The error for one field (undefined when it is fine). The value checked is the trimmed text. */
export function fieldError(key: FieldKey, value: string): string | undefined {
  switch (key) {
    case 'arkivRpcUrl':
    case 'uploadUrl':
    case 'gnosisRpcUrl':
      return checkUrl(value).ok ? undefined : URL_ERROR;
    case 'downloadText': {
      const list = gatewayLines(value);
      if (list.length === 0) return DOWNLOAD_ERROR;
      return list.every((l) => checkUrl(l).ok) ? undefined : URL_ERROR;
    }
    case 'extensionId': {
      const id = value.trim();
      return id === '' || EXTENSION_ID.test(id) ? undefined : EXTENSION_ID_ERROR;
    }
    case 'arkivAccessKey': {
      const key = value.trim();
      return /\s/.test(key) || key.includes('://') ? KEY_ERROR : undefined;
    }
  }
}

export function defaultSettings(): Settings {
  const base = baseNetConfig();
  return {
    pinnedWitnesses: [{ address: defaultWitnessAddress(), label: DEFAULT_WITNESS_LABEL }],
    arkivRpcUrl: base.arkiv.rpcUrl,
    arkivAccessKey: '',
    downloadUrls: [...base.swarm.downloadUrls],
    uploadUrl: base.swarm.uploadUrl,
    gnosisRpcUrl: base.gnosis.rpcUrl,
    extensionId: defaultExtensionId(),
    theme: 'system',
  };
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Keeps only well-formed values of the stored JSON (storage is never trusted blindly). */
function sanitize(p: unknown): Partial<Settings> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return {};
  const o = p as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (Array.isArray(o.pinnedWitnesses)) {
    const list: PinnedWitness[] = [];
    for (const w of o.pinnedWitnesses as unknown[]) {
      const item = (w && typeof w === 'object' ? w : {}) as { address?: unknown; label?: unknown };
      const a = checkAddress(item.address);
      if (!a.ok || list.some((x) => sameAddress(x.address, a.value))) continue;
      const label = typeof item.label === 'string' ? cleanLabel(item.label) : '';
      // Only the built-in witness may be called "default": a stored label that says so is replaced.
      const isBuiltIn = sameAddress(a.value, defaultWitnessAddress());
      list.push({ address: a.value, label: !label || (!isBuiltIn && imitatesDefault(label)) ? DEFAULT_ADDED_LABEL : label });
    }
    // A list in which nothing survived stays empty: when in doubt, trust nobody.
    out.pinnedWitnesses = list;
  }
  for (const k of ['arkivRpcUrl', 'uploadUrl', 'gnosisRpcUrl'] as const) {
    const c = checkUrl(o[k]);
    if (c.ok) out[k] = c.value;
  }
  if (Array.isArray(o.downloadUrls)) {
    const urls = (o.downloadUrls as unknown[]).flatMap((u) => {
      const c = checkUrl(u);
      return c.ok ? [c.value] : [];
    });
    if (urls.length > 0) out.downloadUrls = urls;
  }
  if (typeof o.arkivAccessKey === 'string') out.arkivAccessKey = o.arkivAccessKey.trim();
  // An empty or malformed ID is no choice: the default applies (never "no extension" by accident).
  if (typeof o.extensionId === 'string' && EXTENSION_ID.test(o.extensionId)) out.extensionId = o.extensionId;
  if (o.theme === 'light' || o.theme === 'dark' || o.theme === 'system') out.theme = o.theme;
  return out;
}

/** The overrides kept when the browser will not store them (a blocked or full storage). */
let memory: Partial<Settings> = {};

/** On a shared gateway origin only the theme is taken from storage (R38). */
function trusted(stored: Partial<Settings>): Partial<Settings> {
  if (!isSharedOrigin()) return stored;
  return stored.theme ? { theme: stored.theme } : {};
}

function readStored(): Partial<Settings> {
  return trusted(readStoredRaw());
}

function readStoredRaw(): Partial<Settings> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return sanitize(memory); // storage is blocked: what was saved this session still applies
  }
  if (!raw) return {};
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return {}; // damaged JSON: the defaults
  }
}

/** The effective settings: the defaults with the person's saved choices on top. Never throws. */
export function getSettings(): Settings {
  return { ...defaultSettings(), ...readStored() };
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Saves `patch` on top of the saved choices. Only values that differ from the default are
 * stored, so a default follows the app when it changes; a value of `undefined` clears that
 * choice. Returns the effective settings and whether the browser really stored them (when it
 * did not, they still apply until the page is closed).
 */
export function saveSettingsChecked(patch: Partial<Settings>): { settings: Settings; saved: boolean } {
  const defaults = defaultSettings();
  // On a shared gateway origin only the theme is read, kept and changed: whatever else is in the
  // storage there was put by some other site, and a save writes it away.
  const next: Record<string, unknown> = { ...readStored() };
  const shared = isSharedOrigin();
  for (const [k, v] of Object.entries(patch)) {
    if (shared && k !== 'theme') continue;
    if (v === undefined || sameValue(v, defaults[k as keyof Settings])) delete next[k];
    else next[k] = v;
  }
  memory = sanitize(next);
  let saved = true;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    saved = false;
  }
  notify();
  return { settings: getSettings(), saved };
}

export const saveSettings = (patch: Partial<Settings>): Settings => saveSettingsChecked(patch).settings;

/** Forgets every saved choice (back to the defaults). */
export function resetSettings(): Settings {
  memory = {};
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing stored, nothing to remove */
  }
  notify();
  return getSettings();
}

function notify(): void {
  try {
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* no window: nobody is listening */
  }
}

/** The effective settings, kept current when they change in this tab or another. */
export function useSettings(): Settings {
  const [s, setS] = useState(getSettings);
  useEffect(() => {
    const on = () => setS(getSettings());
    window.addEventListener(CHANGED, on);
    window.addEventListener('storage', on);
    return () => {
      window.removeEventListener(CHANGED, on);
      window.removeEventListener('storage', on);
    };
  }, []);
  return s;
}

/**
 * The app is light only (the bright archive). A theme saved by an older version ("dark",
 * "system") is still read and kept, so stored settings stay compatible, but it no longer
 * changes the look: <html> always carries `data-theme="light"`.
 */
export function applyTheme(_theme?: Theme): void {
  document.documentElement.setAttribute('data-theme', 'light');
}
