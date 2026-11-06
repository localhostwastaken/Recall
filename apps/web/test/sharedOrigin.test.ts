import { LOCAL } from '@recall/net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// R38: on a shared gateway origin (https://<gateway>/bzz/<ref>/, where every Swarm site shares
// one origin and so one localStorage) another site could plant settings. There the stored
// settings are ignored, except the theme.

const KEY = 'recall.web.settings.v1';
const ATTACKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

let data: Map<string, string>;
let pathname = '/';

beforeEach(() => {
  vi.resetModules();
  data = new Map();
  pathname = '/';
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
    location: {
      search: '',
      get pathname() {
        return pathname;
      },
    },
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

const settings = () => import('../src/settings');
const witness = () => import('../src/witness');
const net = () => import('../src/net');

const PLANTED = {
  pinnedWitnesses: [{ address: ATTACKER, label: 'Recall Witness (default)' }],
  arkivRpcUrl: 'https://evil.example/arkiv',
  arkivAccessKey: 'planted-key',
  downloadUrls: ['https://evil.example/dl'],
  uploadUrl: 'https://evil.example/up',
  gnosisRpcUrl: 'https://evil.example/gnosis',
  extensionId: 'z'.repeat(32).replace(/z/g, 'a'),
  theme: 'dark',
};

describe('isSharedOrigin', () => {
  it('is true for a gateway path (/bzz/<ref>/), also behind a prefix', async () => {
    const { isSharedOrigin } = await settings();
    for (const p of [
      '/bzz/abc123/',
      '/bzz/abc123/index.html',
      '/bzz/abc123/app/',
      '/bzz/',
      '/gateway/bzz/abc/',
      '/BZZ/abc/',
      '/%62zz/abc/',
      '//bzz//abc/',
    ]) {
      expect(isSharedOrigin(p), p).toBe(true);
    }
  });

  it('is false for the app on its own origin or path', async () => {
    const { isSharedOrigin } = await settings();
    for (const p of ['/', '', '/Recall/app/', '/app/', '/index.html', '/bzzz/abc/', '/xbzz/abc/', '/bzz', '/notbzz/', '/a/bzzfoo/']) {
      expect(isSharedOrigin(p), p).toBe(false);
    }
  });

  it('reads the current page by default', async () => {
    const { isSharedOrigin } = await settings();
    expect(isSharedOrigin()).toBe(false);
    pathname = '/bzz/deadbeef/';
    expect(isSharedOrigin()).toBe(true);
  });

  it('is false when there is no window (never throws)', async () => {
    const { isSharedOrigin } = await settings();
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(isSharedOrigin()).toBe(false);
  });
});

describe('settings on a shared gateway origin', () => {
  it('ignores every stored trust-critical value and uses the built-in defaults', async () => {
    data.set(KEY, JSON.stringify(PLANTED));
    pathname = '/bzz/abc123/';
    const { getSettings, defaultSettings } = await settings();
    const s = getSettings();
    expect({ ...s, theme: 'x' }).toEqual({ ...defaultSettings(), theme: 'x' });
    expect(s.pinnedWitnesses.map((w) => w.address)).toEqual(['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC']);
    expect(s.arkivRpcUrl).toBe(LOCAL.arkiv.rpcUrl);
    expect(s.downloadUrls).toEqual(LOCAL.swarm.downloadUrls);
    expect(s.arkivAccessKey).toBe('');
    expect(s.extensionId).toBe('');
  });

  it('still honours the stored theme', async () => {
    data.set(KEY, JSON.stringify(PLANTED));
    pathname = '/bzz/abc123/';
    const { getSettings } = await settings();
    expect(getSettings().theme).toBe('dark');
  });

  it('what every reader gets: trusted witnesses and the net config are the defaults', async () => {
    data.set(KEY, JSON.stringify(PLANTED));
    pathname = '/bzz/abc123/';
    const { trustedWitnesses, witnessLabel } = await witness();
    const { getNetConfig } = await net();
    expect(trustedWitnesses().map((w) => w.address.toLowerCase())).toEqual(['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc']);
    expect(witnessLabel(ATTACKER as `0x${string}`)).toBeUndefined();
    const cfg = getNetConfig();
    expect(cfg.arkiv.rpcUrl).toBe(LOCAL.arkiv.rpcUrl);
    expect(cfg.arkiv.accessKey).toBeUndefined();
    expect(cfg.swarm).toEqual(LOCAL.swarm);
    expect(cfg.gnosis).toEqual(LOCAL.gnosis);
  });

  it('the same stored values apply on the app\'s own origin', async () => {
    data.set(KEY, JSON.stringify(PLANTED));
    pathname = '/Recall/app/';
    const { trustedWitnesses } = await witness();
    expect(trustedWitnesses().map((w) => w.address)).toEqual([ATTACKER]);
  });

  it('a save stores only the theme there', async () => {
    pathname = '/bzz/abc123/';
    const { saveSettingsChecked, getSettings } = await settings();
    const r = saveSettingsChecked({ theme: 'light', gnosisRpcUrl: 'https://rpc.example.org', pinnedWitnesses: [] });
    expect(JSON.parse(data.get(KEY)!)).toEqual({ theme: 'light' });
    expect(getSettings().theme).toBe('light');
    expect(getSettings().gnosisRpcUrl).toBe(LOCAL.gnosis.rpcUrl);
    expect(r.settings.pinnedWitnesses).toHaveLength(1);
  });

  it('a reset keeps working there (it only clears the theme)', async () => {
    pathname = '/bzz/abc123/';
    const { saveSettings, resetSettings, getSettings } = await settings();
    saveSettings({ theme: 'dark' });
    resetSettings();
    expect(getSettings().theme).toBe('system');
  });
});

describe('witness labels (R38)', () => {
  it('the default witness is named by code, whatever label is stored', async () => {
    data.set(KEY, JSON.stringify({ pinnedWitnesses: [{ address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', label: 'Totally Someone Else' }] }));
    const { witnessLabel, DEVNET_WITNESS } = await witness();
    expect(witnessLabel(DEVNET_WITNESS)).toBe('Recall Witness (default)');
  });

  it('an added witness always carries "(added in this browser)"', async () => {
    data.set(KEY, JSON.stringify({ pinnedWitnesses: [{ address: ATTACKER, label: 'Neighbour' }] }));
    const { witnessLabel, isDefaultWitness } = await witness();
    expect(witnessLabel(ATTACKER as `0x${string}`)).toBe('Neighbour (added in this browser)');
    expect(isDefaultWitness(ATTACKER as `0x${string}`)).toBe(false);
  });

  it('a stored label that imitates the default is replaced', async () => {
    data.set(
      KEY,
      JSON.stringify({
        pinnedWitnesses: [
          { address: ATTACKER, label: 'Recall Witness (default)' },
          { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', label: 'The DEFAULT one' },
        ],
      }),
    );
    const { getSettings } = await settings();
    expect(getSettings().pinnedWitnesses.map((w) => w.label)).toEqual(['Added witness', 'Added witness']);
  });

  it('a label with the word default is refused when adding', async () => {
    const { labelError, LABEL_DEFAULT_ERROR, LABEL_ERROR } = await settings();
    for (const l of ['default', 'Default', 'Recall Witness (default)', 'my DEFAULT witness', ' default ', 'The-Default']) {
      expect(labelError(l), l).toBe(LABEL_DEFAULT_ERROR);
    }
    expect(labelError('')).toBe(LABEL_ERROR);
    expect(labelError('   ')).toBe(LABEL_ERROR);
    for (const l of ['Neighbour', 'Defaulted? no', 'undefaulted', 'Alice (ops)']) {
      // only the whole word is refused
      expect(labelError(l) === LABEL_DEFAULT_ERROR, l).toBe(/\bdefault\b/i.test(l));
    }
  });

  it('sees through invisible characters, full-width letters and look-alike letters (the label check is on what a person reads)', async () => {
    const { labelError, LABEL_DEFAULT_ERROR } = await settings();
    for (const l of [
      'defaul\u200bt', // zero-width space inside
      'de\u00adfault', // soft hyphen
      'D\u202eEFAULT', // right-to-left override
      '\u2066default\u2069', // isolates
      '\uff44\uff45\uff46\uff41\uff55\uff4c\uff54', // full-width
      '\u{1d41d}\u{1d41e}fault', // mathematical bold d e
      'd\u0435fault', // Cyrillic e
      '\u0501efault', // Cyrillic d
      'def\u0430ult', // Cyrillic a
      'd\u03b5fault', // Greek epsilon
      'd\u00e9fault', // accented e
      'dEfAuLt',
      'Recall Witness (d\u0435fault)',
    ]) {
      expect(labelError(l), JSON.stringify(l)).toBe(LABEL_DEFAULT_ERROR);
    }
  });

  it('a stored label is cleaned: no invisible or control characters, one space between words', async () => {
    const { cleanLabel, getSettings } = await settings();
    expect(cleanLabel('Op\u200berator\u202e  X\u0007')).toBe('Operator X');
    expect(cleanLabel('  Neighbour   witness ')).toBe('Neighbour witness');
    expect(cleanLabel('x'.repeat(100))).toHaveLength(40);
    data.set(
      KEY,
      JSON.stringify({
        pinnedWitnesses: [
          { address: ATTACKER, label: 'Neigh\u202ebour' },
          { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', label: 'd\u0435fault' },
        ],
      }),
    );
    expect(getSettings().pinnedWitnesses.map((w) => w.label)).toEqual(['Neighbour', 'Added witness']);
  });

  it('ordinary labels in other alphabets are fine', async () => {
    const { labelError } = await settings();
    for (const l of ['Operator \u00dcnal', '\u4e2d\u6587\u89c1\u8bc1\u8005', '\u041e\u043f\u0435\u0440\u0430\u0442\u043e\u0440', 'Neighbour (ops)']) {
      expect(labelError(l), l).toBeUndefined();
    }
  });
});

