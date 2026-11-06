import type { Address } from 'viem';
import { LOCAL, liveConfig, type NetConfig } from '@recall/net/config';
import { ADDRESS_ERROR, URL_ERROR, checkAddress, checkUrl } from '@recall/net/validate';
import { BUILT_IN_ARKIV_KEY, RECALL_DEV } from './build';

export { ADDRESS_ERROR, URL_ERROR };

export type Net = 'local' | 'live';

/**
 * How a capture's evidence is uploaded:
 * - `stamped` (default): one batch from the pool, stamped in the extension (D11).
 * - `free`: the demo-day fallback. The evidence goes to the gateway's own free storage
 *   (POST /bytes), no batch is taken from the pool and the record carries the all-zero batch id.
 */
export type UploadMode = 'stamped' | 'free';

/** Extension settings, stored in chrome.storage.local under SETTINGS_KEY. */
export type Settings = {
  /** A witness URL to try after the one the first pinned witness announced on Arkiv. */
  witnessUrl?: string;
  /** The witnesses check C trusts. An empty list trusts nobody. The first one is looked up on Arkiv. */
  pinnedWitnesses: Address[];
  appUrl: string;
  net: Net;
  uploadMode: UploadMode;
  arkivRpcUrl: string;
  /** The person's own Arkiv key. Empty means "use the built-in key" (if the build has one). */
  arkivAccessKey: string;
  /** The Swarm upload gateway (stamped chunks, or free /bytes). */
  uploadUrl: string;
};

export const SETTINGS_KEY = 'recall.settings';

/** The devnet witness service (devnet/docker-compose.yml). */
export const LOCAL_WITNESS_URL = 'http://localhost:7047';

/**
 * The live Recall witness (public address; its key stays with the operator). Pinned by
 * default in live builds, so check C can pass and its announced URL can be found on Arkiv.
 * Dev builds pin nothing by default (tests pin the devnet witness when they need it).
 */
export const LIVE_WITNESS: Address = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';

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
    pinnedWitnesses: net === 'live' ? [LIVE_WITNESS, ...cfg.witness.pinned] : [...cfg.witness.pinned],
    appUrl: cfg.app.url,
    uploadMode: 'stamped',
    arkivRpcUrl: cfg.arkiv.rpcUrl,
    arkivAccessKey: '',
    uploadUrl: cfg.swarm.uploadUrl,
  };
}

/**
 * Endpoints (Arkiv, Swarm, Gnosis) for the settings: the network's defaults with the person's
 * Arkiv RPC and key and Swarm upload gateway on top. An empty access key keeps the default
 * (the key built into a release build, if any).
 */
export function netConfigFor(
  s: Pick<Settings, 'net'> & Partial<Pick<Settings, 'arkivRpcUrl' | 'arkivAccessKey' | 'uploadUrl'>>,
): NetConfig {
  const base = s.net === 'local' ? LOCAL : liveConfig(BUILT_IN_ARKIV_KEY ? { ARKIV_ACCESS_KEY: BUILT_IN_ARKIV_KEY } : {});
  const key = s.arkivAccessKey?.trim() || base.arkiv.accessKey;
  return {
    ...base,
    arkiv: { ...base.arkiv, rpcUrl: s.arkivRpcUrl || base.arkiv.rpcUrl, ...(key ? { accessKey: key } : {}) },
    swarm: { ...base.swarm, uploadUrl: s.uploadUrl || base.swarm.uploadUrl },
  };
}

/** A witness or endpoint URL: https, or http for localhost / 127.0.0.1; no credentials in it. */
export function isWitnessUrl(v: unknown): v is string {
  return checkUrl(v).ok;
}

/** A witness address in the form the settings keep: checksummed (lower-case input is accepted). */
export function validAddress(v: unknown): Address | undefined {
  const c = checkAddress(v);
  return c.ok ? c.value : undefined;
}

const isNet = (v: unknown): v is Net => v === 'local' || v === 'live';

export const KEY_ERROR = 'Paste only the key, without spaces and not as an address.';
/** The text under the Arkiv key field (the same wording as the web app's Settings). */
export function keyHelper(builtIn: boolean, own: boolean): string {
  if (builtIn) {
    return own
      ? 'Your own key is used instead of the built-in key. Clear this field, or use Reset endpoints to default, to go back to the built-in key.'
      : 'Built-in key (default) is in use. Paste your own key to replace it.';
  }
  return own ? 'Your key is used for the Arkiv RPC.' : 'Optional. A key can raise the limits of the Arkiv RPC.';
}

export const APP_URL_ERROR = URL_ERROR;
/** What free mode means, shown next to the choice. */
export const FREE_MODE_NOTE =
  "Demo fallback. The gateway's own storage is used, so no batch is taken from your pool. It has no known end date and can't be kept alive.";

/** The text fields the settings form validates (empty values are allowed only where noted). */
export type SettingsInput = {
  /** Empty means "use the default". */
  witnessUrl: string;
  appUrl: string;
  arkivRpcUrl: string;
  /** Empty means "use the default key". */
  arkivAccessKey: string;
  uploadUrl: string;
};

/** The error of each given field (a missing key is not checked). Same rules as the web app. */
export function settingsErrors(v: Partial<SettingsInput>): Partial<Record<keyof SettingsInput, string>> {
  const out: Partial<Record<keyof SettingsInput, string>> = {};
  if (v.witnessUrl !== undefined && v.witnessUrl.trim() !== '' && !checkUrl(v.witnessUrl).ok) out.witnessUrl = URL_ERROR;
  for (const k of ['appUrl', 'arkivRpcUrl', 'uploadUrl'] as const) {
    const value = v[k];
    if (value !== undefined && !checkUrl(value).ok) out[k] = URL_ERROR;
  }
  if (v.arkivAccessKey !== undefined) {
    const key = v.arkivAccessKey.trim();
    if (/\s/.test(key) || key.includes('://')) out.arkivAccessKey = KEY_ERROR;
  }
  return out;
}

/** Fills in defaults and drops malformed values (storage is never trusted blindly). */
export function mergeSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const net = isNet(s.net) ? s.net : defaultSettings().net;
  const d = defaultSettings(net);
  const url = (v: unknown, fallback: string): string => {
    const c = checkUrl(v);
    return c.ok ? c.value : fallback;
  };
  return {
    net,
    witnessUrl: isWitnessUrl(s.witnessUrl) ? s.witnessUrl : d.witnessUrl,
    pinnedWitnesses: Array.isArray(s.pinnedWitnesses) ? pinnedFrom(s.pinnedWitnesses) : d.pinnedWitnesses,
    appUrl: appUrlFrom(s.appUrl, d.appUrl),
    uploadMode: s.uploadMode === 'free' ? 'free' : 'stamped',
    arkivRpcUrl: url(s.arkivRpcUrl, d.arkivRpcUrl),
    arkivAccessKey: typeof s.arkivAccessKey === 'string' ? s.arkivAccessKey.trim() : '',
    uploadUrl: url(s.uploadUrl, d.uploadUrl),
  };
}

/**
 * The app's address. Unlike an RPC address it keeps (or gets) a trailing slash, because links
 * are built from it with `new URL('#/storage', appUrl)`: for https://host/Recall/app that would
 * resolve to https://host/Recall/#/storage and miss the app.
 */
function appUrlFrom(v: unknown, fallback: string): string {
  const c = checkUrl(v);
  if (!c.ok) return fallback;
  const u = new URL(c.value);
  return u.search || u.hash ? c.value : `${c.value.replace(/\/+$/, '')}/`;
}

export type AppChoice = 'pages' | 'swarm';

/**
 * The two public copies of the Recall web app, offered as one choice above the App URL field.
 * Both can publish with the release extension (its externally_connectable lists both hosts).
 * GitHub Pages is the live default; the Swarm copy is the ENS name recallapp.eth.
 */
export const APP_CHOICES: readonly { id: AppChoice; name: string; desc: string; url: string }[] = [
  {
    id: 'pages',
    name: 'GitHub Pages (default)',
    desc: 'localhostwastaken.github.io',
    url: liveConfig({}).app.url,
  },
  {
    id: 'swarm',
    name: 'Swarm (recallapp.eth.limo)',
    desc: 'The same app, served from Swarm by its ENS name.',
    url: 'https://recallapp.eth.limo/',
  },
];

/** Which choice an App URL is (trailing slash and letter case aside); undefined for any other address. */
export function appChoiceOf(appUrl: string): AppChoice | undefined {
  const normal = appUrlFrom(appUrl, '');
  if (!normal) return undefined;
  const href = new URL(normal).href;
  return APP_CHOICES.find((c) => c.url === href)?.id;
}

/** Valid addresses only (checksummed form), each once. A list with nothing valid trusts nobody. */
function pinnedFrom(list: unknown[]): Address[] {
  const out: Address[] = [];
  for (const v of list) {
    const a = validAddress(v);
    if (a && !out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out;
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
