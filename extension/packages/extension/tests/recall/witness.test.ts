import { afterEach, describe, expect, it, vi } from 'vitest';
import { WITNESS_CHECK_TIMEOUT_MS, witnessOnline } from '../../src/recall/witness';

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
