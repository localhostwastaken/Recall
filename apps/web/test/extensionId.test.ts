import { createHash, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The release extension's fixed ID: it is recomputed from the public key in the release manifest,
// and it is the app's default extension on the live network (defaults.ts), under the user's own
// Settings value and the ?ext= rule (storage/buy.ts linkNeedsConfirm).

const { RELEASE_KEY } = createRequire(import.meta.url)('../../../extension/packages/extension/utils/recallManifest.js') as {
  RELEASE_KEY: string;
};

/** Chrome's way: SHA-256 of the DER SubjectPublicKeyInfo, the first 16 bytes as hex, 0-9a-f mapped to a-p. */
const chromeId = (keyB64: string) =>
  createHash('sha256')
    .update(Buffer.from(keyB64, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'['0123456789abcdef'.indexOf(c)]);

const KEY = 'recall.web.settings.v1';
const MINE = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);

let data: Map<string, string>;
let pathname = '/';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_RECALL_NET', 'live');
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
  vi.unstubAllEnvs();
  delete (globalThis as unknown as { window?: unknown }).window;
});

const settings = () => import('../src/settings');
const defaults = () => import('../src/defaults');

describe('the release extension ID', () => {
  it('is the Chrome ID of the public key the release manifest carries', async () => {
    const { RELEASE_EXTENSION_ID } = await defaults();
    expect(chromeId(RELEASE_KEY)).toBe(RELEASE_EXTENSION_ID);
    expect(RELEASE_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it('the committed key is a public RSA-2048 key (no private part)', () => {
    const k = createPublicKey({ key: Buffer.from(RELEASE_KEY, 'base64'), format: 'der', type: 'spki' });
    expect(k.asymmetricKeyType).toBe('rsa');
    expect(k.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(RELEASE_KEY).not.toMatch(/PRIVATE|BEGIN/);
  });
});

describe('the extension ID default', () => {
  it('is the release extension on the live network, with no ID typed into Settings', async () => {
    const { RELEASE_EXTENSION_ID, defaultExtensionId } = await defaults();
    const { getSettings, defaultSettings } = await settings();
    expect(defaultExtensionId()).toBe(RELEASE_EXTENSION_ID);
    expect(defaultSettings().extensionId).toBe(RELEASE_EXTENSION_ID);
    expect(getSettings().extensionId).toBe(RELEASE_EXTENSION_ID);
  });

  it('is empty on the local devnet (its extension is a dev build with a random ID)', async () => {
    vi.stubEnv('VITE_RECALL_NET', 'local');
    const { getSettings } = await settings();
    expect(getSettings().extensionId).toBe('');
  });

  it('a build-time VITE_RECALL_EXTENSION_ID replaces it, a malformed one does not', async () => {
    vi.stubEnv('VITE_RECALL_EXTENSION_ID', MINE);
    expect((await settings()).getSettings().extensionId).toBe(MINE);
    vi.stubEnv('VITE_RECALL_EXTENSION_ID', 'not-an-id');
    vi.resetModules();
    const { RELEASE_EXTENSION_ID } = await defaults();
    expect((await settings()).getSettings().extensionId).toBe(RELEASE_EXTENSION_ID);
  });

  it('the person\'s own Settings value wins, and is stored only while it differs from the default', async () => {
    const { RELEASE_EXTENSION_ID } = await defaults();
    const { getSettings, saveSettings } = await settings();
    saveSettings({ extensionId: MINE });
    expect(getSettings().extensionId).toBe(MINE);
    expect(JSON.parse(data.get(KEY)!)).toEqual({ extensionId: MINE });
    saveSettings({ extensionId: RELEASE_EXTENSION_ID });
    expect(getSettings().extensionId).toBe(RELEASE_EXTENSION_ID);
    expect(JSON.parse(data.get(KEY)!)).toEqual({});
  });

  it('an empty or malformed saved ID means the default, never "no extension"', async () => {
    const { RELEASE_EXTENSION_ID } = await defaults();
    const { getSettings, saveSettings } = await settings();
    for (const junk of ['', 'a'.repeat(31), 'z'.repeat(32), 42]) {
      data.set(KEY, JSON.stringify({ extensionId: junk }));
      expect(getSettings().extensionId, String(junk)).toBe(RELEASE_EXTENSION_ID);
    }
    saveSettings({ extensionId: MINE });
    saveSettings({ extensionId: '' });
    expect(getSettings().extensionId).toBe(RELEASE_EXTENSION_ID);
  });

  it('R38: on a shared /bzz/ origin only the default applies, which is the release extension', async () => {
    data.set(KEY, JSON.stringify({ extensionId: OTHER }));
    pathname = '/bzz/abc123/';
    const { RELEASE_EXTENSION_ID } = await defaults();
    const { getSettings, saveSettings } = await settings();
    expect(getSettings().extensionId).toBe(RELEASE_EXTENSION_ID);
    saveSettings({ extensionId: MINE });
    expect(getSettings().extensionId).toBe(RELEASE_EXTENSION_ID);
  });
});

describe('linkNeedsConfirm with the fixed default (the ?ext= rule)', () => {
  const load = async () => {
    vi.doMock('../src/wallet', () => ({ isUserRejection: () => false }));
    const { linkNeedsConfirm } = await import('../src/storage/buy');
    return { linkNeedsConfirm, ...(await defaults()), ...(await settings()) };
  };

  it('a link naming the release extension is settled directly, any other one asks', async () => {
    const { linkNeedsConfirm, RELEASE_EXTENSION_ID } = await load();
    expect(linkNeedsConfirm(undefined)).toBe(false);
    expect(linkNeedsConfirm(RELEASE_EXTENSION_ID)).toBe(false);
    expect(linkNeedsConfirm(OTHER)).toBe(true);
  });

  it('with an own ID in Settings, that ID and the build default are settled, a third one asks', async () => {
    const { linkNeedsConfirm, RELEASE_EXTENSION_ID, saveSettings } = await load();
    saveSettings({ extensionId: MINE });
    expect(linkNeedsConfirm(MINE)).toBe(false);
    expect(linkNeedsConfirm(RELEASE_EXTENSION_ID)).toBe(false);
    expect(linkNeedsConfirm(OTHER)).toBe(true);
  });
});
