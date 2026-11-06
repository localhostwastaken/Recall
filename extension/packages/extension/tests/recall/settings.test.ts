import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_CHOICES,
  appChoiceOf,
  defaultSettings,
  isWitnessUrl,
  loadSettings,
  mergeSettings,
  saveSettings,
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

describe('settings', () => {
  let area: ReturnType<typeof memoryArea>;
  beforeEach(() => {
    area = memoryArea();
  });

  it('local defaults point at the devnet witness and the local app', () => {
    expect(defaultSettings('local')).toEqual({
      net: 'local',
      witnessUrl: 'http://localhost:7047',
      pinnedWitnesses: [],
      appUrl: 'http://localhost:5173',
      uploadMode: 'stamped',
      arkivRpcUrl: 'http://localhost:8545',
      arkivAccessKey: '',
      uploadUrl: 'http://localhost:1633',
    });
  });

  it('live defaults use the published app and no witness URL yet', () => {
    const s = defaultSettings('live');
    expect(s.net).toBe('live');
    expect(s.appUrl).toBe('https://localhostwastaken.github.io/Recall/app/');
    expect(s.witnessUrl).toBeUndefined();
    // The live witness is pinned, so its announced URL can be found on Arkiv.
    expect(s.pinnedWitnesses).toEqual(['0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D']);
  });

  it('loads defaults when nothing is stored', async () => {
    expect(await loadSettings(area)).toEqual(defaultSettings());
  });

  it('saves a patch and reads it back', async () => {
    const pinned = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    await saveSettings(
      { net: 'local', pinnedWitnesses: [pinned], witnessUrl: 'http://127.0.0.1:7047' },
      area,
    );
    const s = await loadSettings(area);
    expect(s).toMatchObject({
      net: 'local',
      pinnedWitnesses: [pinned],
      witnessUrl: 'http://127.0.0.1:7047',
    });
    expect(area.data[SETTINGS_KEY]).toEqual(s);
  });

  it('drops malformed stored values instead of trusting them', () => {
    const s = mergeSettings({
      net: 'mainnet',
      appUrl: 42,
      witnessUrl: ['x'],
      pinnedWitnesses: ['0x1234', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
    });
    expect(s.net).toBe(defaultSettings().net);
    expect(s.appUrl).toBe(defaultSettings(s.net).appUrl);
    expect(s.witnessUrl).toBe(defaultSettings(s.net).witnessUrl);
    expect(s.pinnedWitnesses).toEqual(['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC']);
  });

  it('accepts only http(s) witness URLs', () => {
    expect(isWitnessUrl('http://localhost:7047')).toBe(true);
    expect(isWitnessUrl('https://witness.example.org/')).toBe(true);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://witness.example.org', // plain http is for localhost and 127.0.0.1 only
      'ws://localhost:7047',
      'file:///etc/passwd',
      'localhost:7047',
      'https://u:p@w.example',
      '',
    ]) {
      expect(isWitnessUrl(bad), bad).toBe(false);
    }
    const d = defaultSettings('local').witnessUrl;
    expect(mergeSettings({ net: 'local', witnessUrl: 'javascript:alert(1)' }).witnessUrl).toBe(d);
    expect(mergeSettings({ net: 'local', witnessUrl: 'https://w.example' }).witnessUrl).toBe(
      'https://w.example',
    );
  });

  it('offers the app on GitHub Pages (the live default) and on Swarm under its ENS name', () => {
    expect(APP_CHOICES.map((c) => [c.id, c.name, c.url])).toEqual([
      ['pages', 'GitHub Pages (default)', 'https://localhostwastaken.github.io/Recall/app/'],
      ['swarm', 'Swarm (recallapp.eth.limo)', 'https://recallapp.eth.limo/'],
    ]);
    expect(APP_CHOICES[0].url).toBe(defaultSettings('live').appUrl);
  });

  it('tells which app choice an address is, whatever its trailing slash or letter case', () => {
    expect(appChoiceOf('https://localhostwastaken.github.io/Recall/app/')).toBe('pages');
    expect(appChoiceOf('https://localhostwastaken.github.io/Recall/app')).toBe('pages');
    expect(appChoiceOf(' https://recallapp.eth.limo ')).toBe('swarm');
    expect(appChoiceOf('https://RecallApp.eth.limo/')).toBe('swarm');
    // Anything else is a custom address: neither choice is selected.
    expect(appChoiceOf('https://recallapp.bzz.link/')).toBeUndefined();
    expect(appChoiceOf('http://localhost:5173')).toBeUndefined();
    expect(appChoiceOf('https://recallapp.eth.limo/other/')).toBeUndefined();
    expect(appChoiceOf('')).toBeUndefined();
    expect(appChoiceOf('javascript:alert(1)')).toBeUndefined();
  });

  it('keeps an app address at the root of its host with one trailing slash', () => {
    expect(mergeSettings({ net: 'live', appUrl: 'https://recallapp.eth.limo' }).appUrl).toBe(
      'https://recallapp.eth.limo/',
    );
    expect(mergeSettings({ net: 'live', appUrl: 'https://recallapp.eth.limo/' }).appUrl).toBe(
      'https://recallapp.eth.limo/',
    );
  });
});
