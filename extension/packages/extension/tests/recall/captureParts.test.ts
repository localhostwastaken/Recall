import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_REQUEST_HEADERS, CAPTURE_REQUEST_HEADERS } from '@recall/evidence';
import {
  CAPTURE_HANDLERS,
  CAPTURE_USER_AGENT,
  captureTarget,
  classifyFailure,
  formatSize,
  precheckSize,
  proxyUrlFor,
  randomNonce,
  requestHeaders,
  revealPlan,
  tooLarge,
  withTimeout,
  witnessMessageIn,
} from '../../src/recall/captureParts';

describe('capture request', () => {
  it('sends only the allowlisted headers (R20), identity encoding, Connection: close', () => {
    const h = requestHeaders(new URL('https://notice.recall.test/notice?a=1'));
    expect(Object.keys(h).sort()).toEqual([...ALLOWED_REQUEST_HEADERS].sort());
    expect(h.Host).toBe('notice.recall.test');
    expect(h['Accept-Encoding']).toBe('identity');
    expect(h.Connection).toBe('close');
    expect(h['Accept-Language']).toBe('en-US,en;q=0.9');
    // Exactly the values check B pins (one source for both, in @recall/evidence).
    const { Host: _host, ...fixed } = h;
    expect(fixed).toEqual(CAPTURE_REQUEST_HEADERS);
  });

  it('sends the fixed User-Agent, never the browser one (R26: evidence is public)', () => {
    expect(CAPTURE_USER_AGENT).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    );
    const h = requestHeaders(new URL('https://notice.recall.test/'));
    expect(h['User-Agent']).toBe(CAPTURE_USER_AGENT);
    expect(h['User-Agent']).not.toBe(navigator.userAgent);
  });

  it('dev overrides can add headers or change Host', () => {
    const u = new URL('https://notice.recall.test/');
    expect(requestHeaders(u, { extraHeaders: { Cookie: 'a=1' } }).Cookie).toBe('a=1');
    expect(requestHeaders(u, { hostHeader: 'evil.example' }).Host).toBe('evil.example');
  });

  it('accepts https on port 443 only and drops the fragment', () => {
    expect((captureTarget('https://a.example/x#frag') as URL).href).toBe('https://a.example/x');
    expect((captureTarget('https://a.example:443/') as URL).href).toBe('https://a.example/');
    expect(captureTarget('http://a.example/')).toMatchObject({ code: 'failed' });
    expect(captureTarget('https://a.example:8443/')).toMatchObject({ code: 'failed' });
    expect(captureTarget('not a url')).toMatchObject({ code: 'failed' });
    expect(captureTarget('https://u:p@a.example/')).toMatchObject({ code: 'failed' });
    expect(captureTarget('http://a.example/')).toEqual({
      error: 'only https:// pages can be captured',
      code: 'failed',
    });
  });

  it('drops a bare trailing "?" (the prover sends the path without it)', () => {
    expect((captureTarget('https://a.example/p?') as URL).href).toBe('https://a.example/p');
    expect((captureTarget('https://a.example/p?#x') as URL).href).toBe('https://a.example/p');
    expect((captureTarget('https://a.example/p?q=1') as URL).href).toBe('https://a.example/p?q=1');
  });

  it('drops a trailing dot in the host (the witness signs the name without it)', () => {
    const t = captureTarget('https://Notice.Recall.Test./notice') as URL;
    expect(t.hostname).toBe('notice.recall.test');
    expect(t.href).toBe('https://notice.recall.test/notice');
    expect(requestHeaders(t).Host).toBe('notice.recall.test');
  });

  it('builds the witness proxy URL with the session id', () => {
    expect(proxyUrlFor('http://localhost:7047', 'notice.recall.test', 's-1')).toBe(
      'ws://localhost:7047/proxy?token=notice.recall.test&sessionId=s-1',
    );
    expect(proxyUrlFor('https://w.example/base/', 'a.example', 'id 2')).toBe(
      'wss://w.example/base/proxy?token=a.example&sessionId=id+2',
    );
  });

  it('makes a fresh 32-byte nonce', () => {
    const a = randomNonce();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomNonce()).not.toBe(a);
  });

  it('reveals everything by default; overrides make it partial or add a commitment', () => {
    const handler = CAPTURE_HANDLERS[1];
    const computed = {
      sentRanges: [{ start: 0, end: 50 }],
      recvRanges: [{ start: 0, end: 900 }],
      sentRangesWithHandlers: [{ start: 0, end: 50, handler: CAPTURE_HANDLERS[0] }],
      recvRangesWithHandlers: [{ start: 0, end: 900, handler }],
    };
    expect(revealPlan(computed, 900)).toEqual({
      sent: computed.sentRanges,
      recv: computed.recvRanges,
      sentWithHandlers: computed.sentRangesWithHandlers,
      recvWithHandlers: computed.recvRangesWithHandlers,
    });
    const partial = revealPlan(computed, 900, { recvRevealEnd: 100 });
    expect(partial.recv).toEqual([{ start: 0, end: 100 }]);
    expect(partial.recvWithHandlers).toEqual([{ start: 0, end: 100, handler }]);
    expect(revealPlan(computed, 900, { commit: true }).commit).toEqual({
      sent: [],
      recv: [{ start: 0, end: 32, algorithm: 'SHA256' }],
    });
  });
});

describe('size pre-check', () => {
  it('fetches without cookies, redirects or referrer', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok', { status: 200 }));
    await precheckSize('https://a.example/page', 65536, fetchSpy as unknown as typeof fetch);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://a.example/page');
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toBeUndefined();
  });

  const respond = (body: Uint8Array, headers: Record<string, string>) =>
    (async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch;

  it('flags a body over the cap, with its size when known', async () => {
    const r = await precheckSize(
      'https://a.example/',
      65536,
      respond(new Uint8Array(100_000), { 'content-length': '100000' }),
    );
    expect(r).toEqual({ ok: false, size: 100_000 });
  });

  it('counts decoded bytes when the length is not declared', async () => {
    const r = await precheckSize('https://a.example/', 65536, respond(new Uint8Array(70_000), {}));
    expect(r).toEqual({ ok: false, size: null });
  });

  it('passes a small page, and passes on network errors (the prover still enforces the cap)', async () => {
    expect(
      await precheckSize('https://a.example/', 65536, respond(new Uint8Array(2_000), {})),
    ).toEqual({ ok: true });
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await precheckSize('https://a.example/', 65536, failing)).toEqual({ ok: true });
  });

  it('formats the size message', () => {
    expect(formatSize(100_574)).toBe('98.2 KB');
    expect(tooLarge(100_574).error).toBe('page too large (98.2 KB > 64 KB)');
    expect(tooLarge(null).error).toBe('page too large (over 64 KB)');
  });
});

describe('failure classification', () => {
  it('maps the witness busy messages to a retryable busy code', () => {
    for (const m of [
      'recall: witness busy, try again shortly',
      'recall: too many sessions from this client',
      'recall: prover did not connect in time',
    ]) {
      expect(classifyFailure(new Error('x'), m)).toEqual({ error: m, code: 'busy' });
    }
  });

  it('withTimeout rejects a promise that never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, 'too slow')).rejects.toThrow('too slow');
    await expect(withTimeout(Promise.resolve(7), 1_000, 'too slow')).resolves.toBe(7);
  });

  it('prefers the witness message verbatim', () => {
    expect(classifyFailure(new Error('reveal failed'), 'recall: cookies/auth not allowed')).toEqual(
      {
        error: 'recall: cookies/auth not allowed',
        code: 'failed',
      },
    );
  });

  it('extracts the witness message from a prover error', () => {
    const e = new Error(
      'prover error: proving rejected by verifier caused by: recall: commitments not allowed)',
    );
    expect(classifyFailure(e, null).error).toBe('recall: commitments not allowed');
    expect(witnessMessageIn('x "recall: header not allowed: range" y')).toBe(
      'recall: header not allowed: range',
    );
    expect(witnessMessageIn('recall: maxRecvData too large (limit 65536)')).toBe(
      'recall: maxRecvData too large (limit 65536)',
    );
  });

  it('maps an unreachable witness and a too-large page', () => {
    expect(classifyFailure(new Error('WebSocket connection failed'), null).code).toBe(
      'witness_offline',
    );
    expect(classifyFailure(null, 'recall: maxRecvData too large (limit 65536)').code).toBe(
      'too_large',
    );
  });

  it("maps tlsn's receive-limit overflow to too large (no pre-check without host access)", () => {
    // Seen when the page is over the cap and the pre-check could not read it.
    const raw =
      'Verification failed: Run failed: internal error: mpc-tls execution failed caused by: I/O error: ' +
      'unexpected end of file (Protocol: internal error caused by: backend error: internal error: ' +
      '"record layer error: attempted to receive more data than was configured, increase `max_recv` ' +
      'in the config: current=65552, additional=16384, max=65568")';
    expect(classifyFailure(new Error(raw), null)).toEqual({
      error: 'page too large (over 64 KB)',
      code: 'too_large',
    });
  });
});
