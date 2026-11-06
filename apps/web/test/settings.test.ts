import { LOCAL } from '@recall/net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The settings module and what reads it (effective net config, trusted witnesses), against a
// fake localStorage on a fake `window` (the app's own tests that need a browser are in e2e/specs/p3-*).

type FakeStorage = {
  data: Map<string, string>;
  throwOnGet: boolean;
  throwOnSet: boolean;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

function fakeStorage(): FakeStorage {
  const s: FakeStorage = {
    data: new Map(),
    throwOnGet: false,
    throwOnSet: false,
    getItem(k) {
      if (s.throwOnGet) throw new Error('storage blocked');
      return s.data.get(k) ?? null;
    },
    setItem(k, v) {
      if (s.throwOnSet) throw new Error('quota');
      s.data.set(k, v);
    },
    removeItem(k) {
      s.data.delete(k);
    },
  };
  return s;
}

const KEY = 'recall.web.settings.v1';
let storage: FakeStorage;
let events = 0;

beforeEach(() => {
  vi.resetModules(); // each test starts with a fresh settings module (its in-memory fallback is empty)
  storage = fakeStorage();
  events = 0;
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storage,
    location: { search: '' },
    dispatchEvent: () => {
      events++;
      return true;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const settings = () => import('../src/settings');
const net = () => import('../src/net');
const witness = () => import('../src/witness');

const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const THIRD = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

describe('settings defaults', () => {
  it('come from the local network config in dev, with the devnet witness pinned', async () => {
    const { getSettings } = await settings();
    const s = getSettings();
    expect(s.arkivRpcUrl).toBe(LOCAL.arkiv.rpcUrl);
    expect(s.uploadUrl).toBe(LOCAL.swarm.uploadUrl);
    expect(s.downloadUrls).toEqual(LOCAL.swarm.downloadUrls);
    expect(s.gnosisRpcUrl).toBe(LOCAL.gnosis.rpcUrl);
    expect(s.arkivAccessKey).toBe('');
    expect(s.theme).toBe('system');
    expect(s.pinnedWitnesses).toEqual([{ address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', label: 'Recall Witness' }]);
  });
});

describe('saving', () => {
  it('stores only what differs from the default, and reads it back', async () => {
    const { getSettings, saveSettings } = await settings();
    saveSettings({ gnosisRpcUrl: 'https://rpc.example.org', uploadUrl: LOCAL.swarm.uploadUrl });
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({ gnosisRpcUrl: 'https://rpc.example.org' });
    expect(getSettings().gnosisRpcUrl).toBe('https://rpc.example.org');
    expect(getSettings().uploadUrl).toBe(LOCAL.swarm.uploadUrl);
    expect(events).toBe(1);
  });

  it('clears a choice with undefined and forgets everything on reset', async () => {
    const { getSettings, saveSettings, resetSettings } = await settings();
    saveSettings({ gnosisRpcUrl: 'https://rpc.example.org', theme: 'dark' });
    saveSettings({ gnosisRpcUrl: undefined });
    expect(getSettings().gnosisRpcUrl).toBe(LOCAL.gnosis.rpcUrl);
    expect(getSettings().theme).toBe('dark');
    resetSettings();
    expect(storage.data.has(KEY)).toBe(false);
    expect(getSettings().theme).toBe('system');
  });

  it('keeps the pinned list the person chose, including an empty one', async () => {
    const { getSettings, saveSettings } = await settings();
    saveSettings({ pinnedWitnesses: [{ address: OTHER, label: 'Someone' }] });
    expect(getSettings().pinnedWitnesses).toEqual([{ address: OTHER, label: 'Someone' }]);
    saveSettings({ pinnedWitnesses: [] });
    expect(getSettings().pinnedWitnesses).toEqual([]);
  });

  it('a list equal to the default is not stored, so the default keeps following the app', async () => {
    const { defaultSettings, saveSettings } = await settings();
    saveSettings({ pinnedWitnesses: [{ address: OTHER, label: 'Someone' }] });
    saveSettings({ pinnedWitnesses: defaultSettings().pinnedWitnesses });
    expect(JSON.parse(storage.data.get(KEY)!)).toEqual({});
  });

  it('reports whether the browser stored it, and still applies it in this session', async () => {
    const { getSettings, saveSettingsChecked } = await settings();
    storage.throwOnSet = true;
    storage.throwOnGet = true;
    const r = saveSettingsChecked({ gnosisRpcUrl: 'https://rpc.example.org' });
    expect(r.saved).toBe(false);
    expect(getSettings().gnosisRpcUrl).toBe('https://rpc.example.org');
  });
});

describe('storage that throws or holds junk', () => {
  it('renders the defaults when localStorage throws on every access', async () => {
    const { getSettings, defaultSettings } = await settings();
    storage.throwOnGet = true;
    storage.throwOnSet = true;
    expect(getSettings()).toEqual(defaultSettings());
  });

  it('renders the defaults when there is no window at all', async () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    const { getSettings } = await settings();
    // getNetName() needs window.location only in the dev server's ?net= override: fake just that
    (globalThis as unknown as { window: unknown }).window = { location: { search: '' } };
    expect(getSettings().gnosisRpcUrl).toBe(LOCAL.gnosis.rpcUrl);
  });

  it('ignores unparseable JSON and non-objects', async () => {
    const { getSettings, defaultSettings } = await settings();
    for (const junk of ['{nope', 'null', '42', '"x"', '[]']) {
      storage.data.set(KEY, junk);
      expect(getSettings(), junk).toEqual(defaultSettings());
    }
  });

  it('drops hostile or malformed values one by one and keeps the good ones', async () => {
    const { getSettings } = await settings();
    storage.data.set(
      KEY,
      JSON.stringify({
        arkivRpcUrl: 'javascript:alert(1)',
        uploadUrl: 'data:text/html,hi',
        gnosisRpcUrl: 'https://rpc.example.org',
        downloadUrls: ['javascript:1', 'http://evil.example', 'https://gw.example.org'],
        extensionId: 'not-an-id',
        theme: 'neon',
        arkivAccessKey: 42,
      }),
    );
    const s = getSettings();
    expect(s.arkivRpcUrl).toBe(LOCAL.arkiv.rpcUrl);
    expect(s.uploadUrl).toBe(LOCAL.swarm.uploadUrl);
    expect(s.gnosisRpcUrl).toBe('https://rpc.example.org');
    expect(s.downloadUrls).toEqual(['https://gw.example.org']);
    expect(s.extensionId).toBe('');
    expect(s.theme).toBe('system');
    expect(s.arkivAccessKey).toBe('');
  });

  it('a pinned list with nothing valid in it trusts nobody (never falls back to trusting)', async () => {
    const { getSettings } = await settings();
    storage.data.set(KEY, JSON.stringify({ pinnedWitnesses: [{ address: '0x1234', label: 'x' }, 'nope', null] }));
    expect(getSettings().pinnedWitnesses).toEqual([]);
  });

  it('normalises pinned addresses, drops duplicates and gives a blank label a name', async () => {
    const { getSettings } = await settings();
    storage.data.set(
      KEY,
      JSON.stringify({
        pinnedWitnesses: [
          { address: OTHER.toLowerCase(), label: '  Neighbour  ' },
          { address: OTHER, label: 'Again' },
          { address: THIRD, label: '   ' },
        ],
      }),
    );
    expect(getSettings().pinnedWitnesses).toEqual([
      { address: OTHER, label: 'Neighbour' },
      { address: THIRD, label: 'Added witness' },
    ]);
  });

  it('keeps old settings that only had an extension ID and a theme', async () => {
    const { getSettings } = await settings();
    storage.data.set(KEY, JSON.stringify({ extensionId: 'a'.repeat(32), theme: 'dark' }));
    const s = getSettings();
    expect(s.extensionId).toBe('a'.repeat(32));
    expect(s.theme).toBe('dark');
    expect(s.gnosisRpcUrl).toBe(LOCAL.gnosis.rpcUrl);
  });
});

describe('what the rest of the app reads', () => {
  it('getNetConfig layers the saved choices on the network defaults', async () => {
    const { saveSettings } = await settings();
    const { getNetConfig } = await net();
    expect(getNetConfig().swarm.downloadUrls).toEqual(LOCAL.swarm.downloadUrls);
    saveSettings({
      arkivRpcUrl: 'https://arkiv.example.org',
      arkivAccessKey: 'my-own-key',
      downloadUrls: ['https://one.example.org', 'https://two.example.org'],
      uploadUrl: 'https://up.example.org',
      gnosisRpcUrl: 'https://gnosis.example.org',
    });
    const cfg = getNetConfig();
    expect(cfg.arkiv.rpcUrl).toBe('https://arkiv.example.org');
    expect(cfg.arkiv.accessKey).toBe('my-own-key');
    expect(cfg.arkiv.chain).toBe('local');
    expect(cfg.swarm).toEqual({ uploadUrl: 'https://up.example.org', downloadUrls: ['https://one.example.org', 'https://two.example.org'] });
    expect(cfg.gnosis.rpcUrl).toBe('https://gnosis.example.org');
  });

  it('an empty access key override means "use the default" (none locally)', async () => {
    const { saveSettings } = await settings();
    const { getNetConfig } = await net();
    saveSettings({ arkivAccessKey: '' });
    expect(getNetConfig().arkiv.accessKey).toBeUndefined();
  });

  it('removing a pinned witness takes effect on the very next read', async () => {
    const { saveSettings } = await settings();
    const { trustedWitnesses, witnessLabel, DEVNET_WITNESS } = await witness();
    expect(witnessLabel(DEVNET_WITNESS)).toBe('Recall Witness');
    saveSettings({ pinnedWitnesses: [] });
    expect(trustedWitnesses()).toEqual([]);
    expect(witnessLabel(DEVNET_WITNESS)).toBeUndefined();
    saveSettings({ pinnedWitnesses: [{ address: OTHER, label: 'Neighbour' }] });
    expect(witnessLabel(OTHER.toLowerCase() as `0x${string}`)).toBe('Neighbour');
    expect(witnessLabel(DEVNET_WITNESS)).toBeUndefined();
  });
});

describe('the built-in Arkiv access key (R30)', () => {
  const BAKED = 'baked-in-key-for-tests-0001';
  beforeEach(() => {
    vi.stubEnv('VITE_RECALL_NET', 'live');
    vi.stubEnv('VITE_ARKIV_ACCESS_KEY', BAKED);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is the default of a live build, and never appears in the settings the page shows or stores', async () => {
    const { getSettings, saveSettings } = await settings();
    const { hasBuiltInArkivKey } = await import('../src/defaults');
    const { getNetConfig } = await net();
    expect(hasBuiltInArkivKey()).toBe(true);
    expect(getNetConfig().arkiv.chain).toBe('rabdi');
    expect(getNetConfig().arkiv.accessKey).toBe(BAKED);
    // The Settings field starts empty ("Built-in key (default)" is shown instead of the value).
    expect(getSettings().arkivAccessKey).toBe('');
    saveSettings({ theme: 'dark', gnosisRpcUrl: 'https://rpc.example.org' });
    expect(JSON.stringify(getSettings())).not.toContain(BAKED);
    expect(storage.data.get(KEY)).not.toContain(BAKED);
  });

  it('the person\'s own key replaces it, and an empty override goes back to it', async () => {
    const { saveSettings } = await settings();
    const { getNetConfig } = await net();
    saveSettings({ arkivAccessKey: 'my-own-key' });
    expect(getNetConfig().arkiv.accessKey).toBe('my-own-key');
    saveSettings({ arkivAccessKey: '' });
    expect(getNetConfig().arkiv.accessKey).toBe(BAKED);
    saveSettings({ arkivAccessKey: '   ' });
    expect(getNetConfig().arkiv.accessKey).toBe(BAKED);
  });

  it('a build without the key has none, and a local build ignores it', async () => {
    vi.stubEnv('VITE_ARKIV_ACCESS_KEY', '');
    const { hasBuiltInArkivKey } = await import('../src/defaults');
    const { getNetConfig } = await net();
    expect(hasBuiltInArkivKey()).toBe(false);
    expect(getNetConfig().arkiv.accessKey).toBeUndefined();
  });

  it('is not used on the local devnet', async () => {
    vi.stubEnv('VITE_RECALL_NET', 'local');
    const { hasBuiltInArkivKey } = await import('../src/defaults');
    expect(hasBuiltInArkivKey()).toBe(false);
  });
});

describe('field validation (the copy of the design brief)', () => {
  it('rejects urls that are not https (or local http), with the brief copy', async () => {
    const { fieldError, URL_ERROR } = await settings();
    for (const key of ['arkivRpcUrl', 'uploadUrl', 'gnosisRpcUrl'] as const) {
      expect(fieldError(key, 'https://ok.example.org')).toBeUndefined();
      expect(fieldError(key, 'http://localhost:8545')).toBeUndefined();
      expect(fieldError(key, 'http://127.0.0.1:1633')).toBeUndefined();
      for (const bad of ['javascript:alert(1)', 'data:text/plain,x', 'http://example.org', 'example.org', '', 'https://u:p@example.org']) {
        expect(fieldError(key, bad), `${key} ${bad}`).toBe(URL_ERROR);
      }
    }
  });

  it('checks every download gateway line', async () => {
    const { fieldError, URL_ERROR, DOWNLOAD_ERROR } = await settings();
    expect(fieldError('downloadText', 'https://a.example.org\nhttps://b.example.org')).toBeUndefined();
    expect(fieldError('downloadText', 'https://a.example.org\n\n  \nhttp://localhost:1643')).toBeUndefined();
    expect(fieldError('downloadText', 'https://a.example.org\njavascript:alert(1)')).toBe(URL_ERROR);
    expect(fieldError('downloadText', ' \n ')).toBe(DOWNLOAD_ERROR);
  });

  it('checks the extension ID and the access key', async () => {
    const { fieldError, EXTENSION_ID_ERROR, KEY_ERROR } = await settings();
    expect(fieldError('extensionId', '')).toBeUndefined();
    expect(fieldError('extensionId', 'a'.repeat(32))).toBeUndefined();
    expect(fieldError('extensionId', 'a'.repeat(31))).toBe(EXTENSION_ID_ERROR);
    expect(fieldError('extensionId', 'z'.repeat(32))).toBe(EXTENSION_ID_ERROR);
    expect(fieldError('arkivAccessKey', '')).toBeUndefined();
    expect(fieldError('arkivAccessKey', 'abc123DEF')).toBeUndefined();
    expect(fieldError('arkivAccessKey', 'two words')).toBe(KEY_ERROR);
    expect(fieldError('arkivAccessKey', 'https://rpc.example.org/?key=secret')).toBe(KEY_ERROR);
  });
});
