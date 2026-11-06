import type { Address } from 'viem';
import { LOCAL, liveConfig } from '@recall/net/config';
import { RECALL_DEV } from './build';

export type Net = 'local' | 'live';

/** Extension settings, stored in chrome.storage.local under SETTINGS_KEY. */
export type Settings = {
  witnessUrl?: string;
  pinnedWitnesses: Address[];
  appUrl: string;
  net: Net;
};

export const SETTINGS_KEY = 'recall.settings';

/** The devnet witness service (devnet/docker-compose.yml). */
export const LOCAL_WITNESS_URL = 'http://localhost:7047';

/** The subset of chrome.storage.StorageArea that settings use (injectable for tests). */
export type SettingsArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

const defaultArea = (): SettingsArea => chrome.storage.local as unknown as SettingsArea;

export function defaultSettings(net: Net = RECALL_DEV ? 'local' : 'live'): Settings {
  const cfg = net === 'local' ? LOCAL : liveConfig({});
  return {
    net,
    witnessUrl: net === 'local' ? LOCAL_WITNESS_URL : undefined,
    pinnedWitnesses: [...cfg.witness.pinned],
    appUrl: cfg.app.url,
  };
}

const isAddress = (v: unknown): v is Address =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/** A witness address must be an http(s) URL without credentials (anything else is dropped). */
export function isWitnessUrl(v: unknown): v is string {
  if (typeof v !== 'string' || !v) return false;
  try {
    const u = new URL(v);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      !u.username &&
      !u.password &&
      !!u.hostname
    );
  } catch {
    return false;
  }
}
const isNet = (v: unknown): v is Net => v === 'local' || v === 'live';

/** Fills in defaults and drops malformed values (storage is never trusted blindly). */
export function mergeSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const net = isNet(s.net) ? s.net : defaultSettings().net;
  const d = defaultSettings(net);
  return {
    net,
    witnessUrl: isWitnessUrl(s.witnessUrl) ? s.witnessUrl : d.witnessUrl,
    pinnedWitnesses: Array.isArray(s.pinnedWitnesses)
      ? s.pinnedWitnesses.filter(isAddress)
      : d.pinnedWitnesses,
    appUrl: typeof s.appUrl === 'string' && s.appUrl ? s.appUrl : d.appUrl,
  };
}

export async function loadSettings(area: SettingsArea = defaultArea()): Promise<Settings> {
  return mergeSettings((await area.get(SETTINGS_KEY))[SETTINGS_KEY]);
}

/** Applies `patch` on top of the stored settings and saves the full result. */
export async function saveSettings(
  patch: Partial<Settings>,
  area: SettingsArea = defaultArea(),
): Promise<Settings> {
  const next = mergeSettings({ ...(await loadSettings(area)), ...patch });
  await area.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Writes the defaults once, so other parts of the extension and tests can read them. */
export async function ensureSettings(area: SettingsArea = defaultArea()): Promise<Settings> {
  const stored = (await area.get(SETTINGS_KEY))[SETTINGS_KEY];
  const s = mergeSettings(stored);
  if (stored === undefined) await area.set({ [SETTINGS_KEY]: s });
  return s;
}
