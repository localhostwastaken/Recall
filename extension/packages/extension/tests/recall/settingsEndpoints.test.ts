// The extension's settings for witnesses, endpoints and the upload mode (task 17).
import { describe, expect, it } from 'vitest';
import { LOCAL } from '@recall/net/config';
import {
  defaultSettings,
  keyHelper,
  loadSettings,
  mergeSettings,
  netConfigFor,
  saveSettings,
  settingsErrors,
  SETTINGS_KEY,
} from '../../src/recall/settings';

function memoryArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key: string) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
    },
  };
}

const PINNED = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

describe('defaults', () => {
  it('upload mode is stamped, endpoints are the network defaults and the access key is empty', () => {
    const s = defaultSettings('local');
    expect(s.uploadMode).toBe('stamped');
    expect(s.arkivRpcUrl).toBe(LOCAL.arkiv.rpcUrl);
    expect(s.uploadUrl).toBe(LOCAL.swarm.uploadUrl);
    expect(s.arkivAccessKey).toBe('');
    const live = defaultSettings('live');
    expect(live.arkivRpcUrl).toBe('https://rpc.rabdi.db-chain.testnet.arkiv.network');
    expect(live.uploadUrl).toBe('https://api.gateway.ethswarm.org');
  });
});

describe('uploadMode', () => {
  it('persists, and anything but "free" is read back as "stamped"', async () => {
    const area = memoryArea();
    await saveSettings({ uploadMode: 'free' }, area);
    expect((await loadSettings(area)).uploadMode).toBe('free');
    expect((area.data[SETTINGS_KEY] as { uploadMode: string }).uploadMode).toBe('free');
    await saveSettings({ uploadMode: 'stamped' }, area);
    expect((await loadSettings(area)).uploadMode).toBe('stamped');
    for (const junk of ['FREE', 'both', 1, null, undefined, {}]) {
      expect(mergeSettings({ net: 'local', uploadMode: junk }).uploadMode, String(junk)).toBe('stamped');
    }
  });
});

describe('endpoints', () => {
  it('keeps safe URLs and drops hostile or malformed ones for their default', () => {
    const d = defaultSettings('local');
    const m = mergeSettings({
      net: 'local',
      arkivRpcUrl: 'javascript:alert(1)',
      uploadUrl: 'data:text/plain,x',
      witnessUrl: 'http://example.org',
      appUrl: 42,
    });
    expect(m.arkivRpcUrl).toBe(d.arkivRpcUrl);
    expect(m.uploadUrl).toBe(d.uploadUrl);
    expect(m.witnessUrl).toBe(d.witnessUrl);
    const ok = mergeSettings({ net: 'local', arkivRpcUrl: 'https://arkiv.example.org', uploadUrl: 'http://127.0.0.1:1633' });
    expect(ok.arkivRpcUrl).toBe('https://arkiv.example.org');
    expect(ok.uploadUrl).toBe('http://127.0.0.1:1633');
  });

  it('the access key is a plain string; an empty one means "use the default"', () => {
    expect(mergeSettings({ net: 'local', arkivAccessKey: 'my-key' }).arkivAccessKey).toBe('my-key');
    expect(mergeSettings({ net: 'local', arkivAccessKey: 42 }).arkivAccessKey).toBe('');
    expect(mergeSettings({ net: 'local' }).arkivAccessKey).toBe('');
  });

  it('netConfigFor layers the endpoints on the network defaults', () => {
    const base = netConfigFor({ net: 'local' });
    expect(base.arkiv.rpcUrl).toBe(LOCAL.arkiv.rpcUrl);
    const s = { ...defaultSettings('local'), arkivRpcUrl: 'https://arkiv.example.org', arkivAccessKey: 'k1', uploadUrl: 'https://up.example.org' };
    const cfg = netConfigFor(s);
    expect(cfg.arkiv).toMatchObject({ chain: 'local', rpcUrl: 'https://arkiv.example.org', accessKey: 'k1' });
    expect(cfg.swarm.uploadUrl).toBe('https://up.example.org');
    expect(cfg.swarm.downloadUrls).toEqual(LOCAL.swarm.downloadUrls);
    expect(cfg.gnosis).toEqual(LOCAL.gnosis);
    // An empty access key keeps the network's own (none locally).
    expect(netConfigFor({ ...s, arkivAccessKey: '' }).arkiv.accessKey).toBeUndefined();
  });
});

describe('appUrl', () => {
  it('keeps a trailing slash, so links built with new URL(hash, appUrl) stay inside the app path', () => {
    for (const given of ['https://host.example/Recall/app', 'https://host.example/Recall/app/', 'https://host.example/Recall/app///']) {
      const app = mergeSettings({ net: 'live', appUrl: given }).appUrl;
      expect(app, given).toBe('https://host.example/Recall/app/');
      expect(new URL('#/storage', app).href).toBe('https://host.example/Recall/app/#/storage');
    }
    expect(mergeSettings({ net: 'local', appUrl: 'http://localhost:5173' }).appUrl).toBe('http://localhost:5173/');
  });

  it('a hostile or malformed app address falls back to the default', () => {
    for (const bad of ['javascript:alert(1)', 'http://example.org/app/', 'data:text/html,x', 42, '']) {
      expect(mergeSettings({ net: 'live', appUrl: bad }).appUrl, String(bad)).toBe(defaultSettings('live').appUrl);
    }
  });
});

describe('pinned witnesses', () => {
  it('keeps checksummed and lower-case addresses, drops a mixed-case typo, and an empty list trusts nobody', () => {
    const m = mergeSettings({
      net: 'local',
      pinnedWitnesses: [PINNED.toLowerCase(), PINNED.replace('3C44', '3c44'), '0x1234', 42],
    });
    expect(m.pinnedWitnesses).toEqual([PINNED]);
    expect(mergeSettings({ net: 'local', pinnedWitnesses: [] }).pinnedWitnesses).toEqual([]);
    expect(mergeSettings({ net: 'live', pinnedWitnesses: ['nope'] }).pinnedWitnesses).toEqual([]);
  });

  it('drops duplicates (any case)', () => {
    const m = mergeSettings({ net: 'local', pinnedWitnesses: [PINNED, PINNED.toLowerCase()] });
    expect(m.pinnedWitnesses).toEqual([PINNED]);
  });
});

describe('settingsErrors (what the popup form shows)', () => {
  const good = {
    witnessUrl: 'https://witness.example.org',
    appUrl: 'https://app.example.org/',
    arkivRpcUrl: 'https://arkiv.example.org',
    arkivAccessKey: 'abc123',
    uploadUrl: 'https://up.example.org',
  };

  it('is empty for good values (an empty witness URL, app URL aside, is allowed: none set)', () => {
    expect(settingsErrors(good)).toEqual({});
    expect(settingsErrors({ ...good, witnessUrl: '' })).toEqual({});
  });

  it('uses the design brief copy for URLs and addresses', () => {
    const e = settingsErrors({
      witnessUrl: 'javascript:alert(1)',
      appUrl: 'data:text/html,x',
      arkivRpcUrl: 'http://example.org',
      arkivAccessKey: 'two words',
      uploadUrl: 'example.org',
    });
    expect(e.witnessUrl).toBe('Enter a full address starting with https://');
    expect(e.appUrl).toBe('Enter a full address starting with https://');
    expect(e.arkivRpcUrl).toBe('Enter a full address starting with https://');
    expect(e.uploadUrl).toBe('Enter a full address starting with https://');
    expect(e.arkivAccessKey).toBe('Paste only the key, without spaces and not as an address.');
  });
});

describe('keyHelper (the text under the Arkiv key field)', () => {
  it('depends on the build having a key and on whether one is typed', () => {
    expect(keyHelper(true, false)).toBe('Built-in key (default) is in use. Paste your own key to replace it.');
    expect(keyHelper(true, true)).toMatch(/^Your own key is used instead of the built-in key\./);
    expect(keyHelper(false, false)).toBe('Optional. A key can raise the limits of the Arkiv RPC.');
    expect(keyHelper(false, true)).toBe('Your key is used for the Arkiv RPC.');
  });
});
