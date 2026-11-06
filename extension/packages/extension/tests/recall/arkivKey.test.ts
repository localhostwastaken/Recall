// The Arkiv access key reaches the extension's reads (offscreen document) and never comes back
// in an error that is passed on or logged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveConfig } from '@recall/net/config';
import { readEntitySummary } from '../../src/recall/arkivRead';
import { readHistory, readWitnessUrl } from '../../src/recall/historyRead';
import { netConfigFor } from '../../src/recall/settings';

const KEY = 'sk-ext-key_0123456789';
const HOST = 'rpc.rabdi.db-chain.testnet.arkiv.network';
const real = globalThis.fetch;
const urls: string[] = [];

beforeEach(() => {
  urls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    throw new TypeError(`fetch failed for ${url}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = real;
});

const net = () => netConfigFor({ net: 'live', arkivAccessKey: KEY });

describe('netConfigFor with a key', () => {
  it('keeps the key in the config and the Rabdi host', () => {
    const cfg = net();
    expect(cfg.arkiv.accessKey).toBe(KEY);
    expect(cfg.arkiv.rpcUrl).toBe(liveConfig({}).arkiv.rpcUrl);
  });
});

describe('Arkiv reads of the extension', () => {
  it('send the key in the request path and return errors without it', async () => {
    const cfg = net();
    const a = await readEntitySummary(cfg, `0x${'11'.repeat(32)}`);
    const b = await readWitnessUrl({ type: 'recall.offscreen.witnessUrl', net: cfg, witness: `0x${'22'.repeat(20)}` });
    const c = await readHistory({ type: 'recall.offscreen.history', net: cfg, urlHash: `0x${'33'.repeat(32)}`, pinned: [], want: 'summary' } as never);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith(`https://${HOST}/${encodeURIComponent(KEY)}`))).toBe(true);
    for (const r of [a, b, c]) {
      expect(r).toHaveProperty('error');
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(JSON.stringify(r)).not.toContain(encodeURIComponent(KEY));
    }
  });
});
