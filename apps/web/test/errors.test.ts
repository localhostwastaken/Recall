import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'sk-own-key-0123456789';
const BAKED = 'baked-in-key-for-tests-0001';
const HOST = 'rpc.rabdi.db-chain.testnet.arkiv.network';

let data: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  data = new Map();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    },
    location: { search: '', pathname: '/' },
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  vi.stubEnv('VITE_RECALL_NET', 'live');
  vi.stubEnv('VITE_ARKIV_ACCESS_KEY', BAKED);
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe('errorText', () => {
  it('removes the built-in key and the person\'s own key from what is shown', async () => {
    const { saveSettings } = await import('../src/settings');
    const { errorText, shortErrorText } = await import('../src/errors');
    saveSettings({ arkivAccessKey: KEY });
    const err = Object.assign(new Error(`HTTP request failed.\nURL: https://${HOST}/${KEY}\nalso https://${HOST}/${BAKED}`), {
      shortMessage: `HTTP request failed at https://${HOST}/${KEY}`,
    });
    for (const text of [errorText(err), shortErrorText(err), errorText(`plain string ${KEY}`)]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(BAKED);
    }
    expect(errorText(err)).toContain('HTTP request failed.');
    expect(errorText(err)).toContain('[key]');
  }, 20_000);

  it('leaves an ordinary error alone and never throws on odd input', async () => {
    const { errorText } = await import('../src/errors');
    expect(errorText(new Error('The record could not be read.'))).toBe('The record could not be read.');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText({ toString: () => { throw new Error('boom'); } })).toBe('unknown error');
  });

  it('the keep-alive failure notice (problemOf) carries no key either', async () => {
    const { saveSettings } = await import('../src/settings');
    const { problemOf } = await import('../src/keepalive/flow');
    saveSettings({ arkivAccessKey: KEY });
    const err = Object.assign(new Error(`HTTP request failed.\nURL: https://${HOST}/${KEY}`), {
      shortMessage: `HTTP request failed at https://${HOST}/${BAKED}`,
    });
    const p = problemOf(err, { approved: false, sent: false });
    expect(p.kind).toBe('failed');
    const text = JSON.stringify(p);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(BAKED);
    expect(text).toContain('[key]');
    // After the approval went through, a changed price says so too (so the dialog can reassure).
    const { BatchChangedError } = await import('@recall/net');
    expect(problemOf(new BatchChangedError(`0x${'ab'.repeat(32)}`, 'price', 'dearer'), { approved: true, sent: false })).toMatchObject({ kind: 'changed', reason: 'price', approved: true });
    expect(problemOf(new BatchChangedError(`0x${'ab'.repeat(32)}`, 'price', 'dearer'), { approved: false, sent: false })).toMatchObject({ approved: false });
    // A plain provider error object keeps its message.
    expect(problemOf({ message: 'insufficient funds' }, { approved: false, sent: false })).toMatchObject({ message: 'insufficient funds' });
  }, 20_000);
});
