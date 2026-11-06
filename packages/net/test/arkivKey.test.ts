import { rabdi } from '@arkiv-network/sdk/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL, RABDI_RPC_HOST, arkivPublic, arkivRpcUrl, liveConfig, redactKey, type NetConfig } from '../src/index';

// The Arkiv access key must reach READ requests (the SDK's rabdi({accessKey}) only puts it in the
// chain's own rpcUrls, which an explicit transport URL overrides), only on the Rabdi host, and
// must never survive in an error message. No network: fetch is replaced.

const KEY = 'sk-test-key_0123456789/with+odd=chars';
const ENC = encodeURIComponent(KEY);

const live = (over: Partial<NetConfig['arkiv']> = {}, key: string | null = KEY): NetConfig => {
  const cfg = liveConfig(key === null ? {} : { ARKIV_ACCESS_KEY: key });
  return { ...cfg, arkiv: { ...cfg.arkiv, ...over } };
};

describe('arkivRpcUrl', () => {
  it('uses the SDK host constant', () => {
    const sdk = new URL(rabdi({ accessKey: 'x' }).rpcUrls.default.http[0]!);
    expect(sdk.hostname).toBe(RABDI_RPC_HOST);
    expect(new URL(liveConfig({}).arkiv.rpcUrl).hostname).toBe(RABDI_RPC_HOST);
  });

  it("puts the key in the path of the Rabdi host, exactly like the SDK's own chain URL", () => {
    const url = arkivRpcUrl(live());
    expect(url).toBe(`https://${RABDI_RPC_HOST}/${ENC}`);
    expect(url).toBe(rabdi({ accessKey: KEY }).rpcUrls.default.http[0]);
  });

  it('adds nothing without a key (the public endpoint)', () => {
    expect(arkivRpcUrl(live({}, null))).toBe(liveConfig({}).arkiv.rpcUrl);
    expect(arkivRpcUrl(live({ accessKey: '' }))).toBe(liveConfig({}).arkiv.rpcUrl);
    expect(arkivRpcUrl(live({ accessKey: '   ' }))).toBe(liveConfig({}).arkiv.rpcUrl);
  });

  it('never appends the key to another host, however it looks like the Rabdi one', () => {
    for (const rpcUrl of [
      'https://rpc.example.org',
      'https://rpc.example.org/',
      `https://${RABDI_RPC_HOST}.evil.example`,
      `https://evil.example/${RABDI_RPC_HOST}`,
      `https://evil.example?h=${RABDI_RPC_HOST}`,
      `https://x.${RABDI_RPC_HOST}`,
      `https://user:pw@${RABDI_RPC_HOST}`,
      `http://${RABDI_RPC_HOST}`, // not https: the key must not travel in clear
      'http://localhost:8545',
    ]) {
      expect(arkivRpcUrl(live({ rpcUrl })), rpcUrl).toBe(rpcUrl);
    }
  });

  it('leaves a URL that already names a path (the person pasted their own key URL) alone', () => {
    const own = `https://${RABDI_RPC_HOST}/their-own-key`;
    expect(arkivRpcUrl(live({ rpcUrl: own }))).toBe(own);
    expect(arkivRpcUrl(live({ rpcUrl: `https://${RABDI_RPC_HOST}/?x=1` }))).toBe(`https://${RABDI_RPC_HOST}/?x=1`);
  });

  it('never adds a key on the local devnet', () => {
    expect(arkivRpcUrl({ ...LOCAL, arkiv: { ...LOCAL.arkiv, accessKey: KEY } })).toBe(LOCAL.arkiv.rpcUrl);
  });
});

describe('arkivPublic sends the key on reads', () => {
  const calls: { url: string; body: string; headers: string }[] = [];
  const real = globalThis.fetch;
  let mode: 'ok' | 'throw' | 'http500' = 'ok';

  beforeEach(() => {
    calls.length = 0;
    mode = 'ok';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: String(init?.body ?? ''), headers: JSON.stringify(init?.headers ?? {}) });
      if (mode === 'throw') throw new TypeError(`fetch failed for ${url}`);
      if (mode === 'http500') return new Response(`upstream said no at ${url}`, { status: 500 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x76e0af' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = real;
  });

  it('Rabdi: the request goes to host/<key>', async () => {
    await arkivPublic(live()).getChainId();
    expect(calls.map((c) => c.url)).toEqual([`https://${RABDI_RPC_HOST}/${ENC}`]);
  });

  it('Rabdi without a key: the plain public URL', async () => {
    await arkivPublic(live({}, null)).getChainId();
    expect(calls.map((c) => c.url)).toEqual([`https://${RABDI_RPC_HOST}/`]); // a request URL always has the root slash
  });

  it('a custom host gets the request on its own URL, and the key is nowhere in it', async () => {
    await arkivPublic(live({ rpcUrl: 'https://rpc.example.org/arkiv' })).getChainId();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://rpc.example.org/arkiv');
    for (const part of Object.values(calls[0]!)) {
      expect(part).not.toContain(KEY);
      expect(part).not.toContain(ENC);
    }
  });

  const every = (e: unknown): unknown[] => {
    const out: unknown[] = [];
    for (let x = e as { cause?: unknown } | undefined, i = 0; x && i < 10; i++, x = x.cause as typeof x) out.push(x);
    return out;
  };
  const leaks = (e: unknown): string[] =>
    every(e).flatMap((x) => {
      const o = x as { message?: string; shortMessage?: string; details?: string; metaMessages?: string[]; url?: string; stack?: string };
      return [o.message, o.shortMessage, o.details, ...(o.metaMessages ?? []), o.url, o.stack, String(x)].filter(
        (s): s is string => typeof s === 'string' && (s.includes(KEY) || s.includes(ENC)),
      );
    });

  it('a network error does not carry the key in any message, detail, URL or stack', async () => {
    mode = 'throw';
    const err = await arkivPublic(live()).getChainId().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(calls.length).toBeGreaterThan(0); // it did try (and retry) with the key...
    expect(calls.every((c) => c.url.includes(ENC))).toBe(true);
    expect(leaks(err)).toEqual([]); // ...and the error is clean
    expect((err as Error).message).toContain('[key]'); // the place of the key is visible, not blank
  });

  it('an HTTP error does not carry the key either', async () => {
    mode = 'http500';
    const err = await arkivPublic(live()).getChainId().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(leaks(err)).toEqual([]);
  });

  it('a wrapped error (contract-style action) is clean as well', async () => {
    mode = 'throw';
    const err = await arkivPublic(live())
      .getBlockNumber()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(leaks(err)).toEqual([]);
  });
});

describe('redactKey', () => {
  it('removes the key in its plain and URL-encoded form, everywhere it appears', () => {
    const text = `URL: https://h.example/${ENC}\nraw ${KEY} again ${KEY}`;
    const out = redactKey(text, KEY);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(ENC);
    expect(out).toContain('[key]');
  });

  it('removes a key pasted into a Rabdi URL, whoever typed it', () => {
    const out = redactKey(`failed: https://${RABDI_RPC_HOST}/their-own-key-123 (timeout)`);
    expect(out).not.toContain('their-own-key-123');
    expect(out).toContain(`https://${RABDI_RPC_HOST}/[key]`);
    expect(out).toContain('(timeout)');
  });

  it('is idempotent: an already redacted Rabdi URL stays [key], not [key]]', () => {
    const once = redactKey(`failed: https://${RABDI_RPC_HOST}/${ENC} (timeout)`, KEY);
    expect(once).toContain(`https://${RABDI_RPC_HOST}/[key] (timeout)`);
    expect(redactKey(once, KEY)).toBe(once);
    expect(redactKey(redactKey(once))).toBe(once);
  });

  it('keeps messages that have nothing secret, and ignores empty or missing keys', () => {
    const t = 'The record could not be read. https://rpc.example.org/arkiv';
    expect(redactKey(t, undefined, '', '  ')).toBe(t);
    expect(redactKey(t)).toBe(t);
  });

  it('does not garble a message for a key too short to be one', () => {
    expect(redactKey('an error in a place', 'a')).toBe('an error in a place');
  });

  it('handles several keys and is safe on odd input', () => {
    const out = redactKey('one-secret-aaaa and two-secret-bbbb', 'one-secret-aaaa', 'two-secret-bbbb');
    expect(out).toBe('[key] and [key]');
    expect(redactKey('', KEY)).toBe('');
  });
});
