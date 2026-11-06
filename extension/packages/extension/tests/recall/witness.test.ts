import { afterEach, describe, expect, it, vi } from 'vitest';
import { WITNESS_CHECK_TIMEOUT_MS, probeWitness, witnessOnline } from '../../src/recall/witness';

// The live witness sits behind a Cloudflare quick tunnel: its first /info from a browser took
// ~2 s (DNS, TLS, the tunnel hop), which a 2 s probe called "offline". The probe allows longer.

const SIGNER = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';

/** A fetch that answers /info after `ms`, and honours the abort signal like the real one. */
function slowWitness(ms: number) {
  return vi.fn(
    (_url: URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(
          () => resolve(new Response(JSON.stringify({ signer: SIGNER }), { status: 200 })),
          ms,
        );
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new DOMException('The operation timed out.', 'TimeoutError'));
        });
      }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('witnessOnline', () => {
  it('allows a tunnel-slow /info (several seconds) by default', async () => {
    expect(WITNESS_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    vi.stubGlobal('fetch', slowWitness(2_500));
    await expect(witnessOnline('https://w.trycloudflare.com', undefined, [SIGNER])).resolves.toBe(
      true,
    );
  });

  it('a witness that does not answer within the timeout is offline', async () => {
    vi.stubGlobal('fetch', slowWitness(1_000));
    await expect(witnessOnline('https://w.trycloudflare.com', 200, [SIGNER])).resolves.toBe(false);
  });

  it('a witness answering for another key is offline', async () => {
    vi.stubGlobal('fetch', slowWitness(0));
    await expect(
      witnessOnline('https://w.trycloudflare.com', undefined, [
        '0x0000000000000000000000000000000000000001',
      ]),
    ).resolves.toBe(false);
  });
});

describe('probeWitness: why a witness is not online', () => {
  it('a /info that does not answer in time is a timeout (the network)', async () => {
    vi.stubGlobal('fetch', slowWitness(1_000));
    await expect(probeWitness('https://w.trycloudflare.com', 200, [SIGNER])).resolves.toEqual({
      ok: false,
      why: 'timeout',
    });
  });

  it('an answer for a key that is not pinned is a wrong signer, never a timeout', async () => {
    vi.stubGlobal('fetch', slowWitness(0));
    await expect(
      probeWitness('https://w.trycloudflare.com', undefined, ['0x0000000000000000000000000000000000000001']),
    ).resolves.toEqual({ ok: false, why: 'wrong_signer' });
  });

  it('a refused connection, a bad answer and no URL are unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(probeWitness('https://w.trycloudflare.com', undefined, [SIGNER])).resolves.toEqual({ ok: false, why: 'unreachable' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(probeWitness('https://w.trycloudflare.com', undefined, [SIGNER])).resolves.toEqual({ ok: false, why: 'unreachable' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ signer: 'nope' }), { status: 200 })));
    await expect(probeWitness('https://w.trycloudflare.com', undefined, [SIGNER])).resolves.toEqual({ ok: false, why: 'unreachable' });
    await expect(probeWitness(undefined)).resolves.toEqual({ ok: false, why: 'unreachable' });
  });

  it('an online witness', async () => {
    vi.stubGlobal('fetch', slowWitness(0));
    await expect(probeWitness('https://w.trycloudflare.com', undefined, [SIGNER])).resolves.toEqual({ ok: true });
  });
});
