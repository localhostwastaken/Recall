import type { Address } from 'viem';

/**
 * How long the popup waits for `GET {witness}/info` before calling the witness offline. The
 * live witness sits behind a Cloudflare quick tunnel, where a browser's first /info measured
 * about 2 s (DNS, TLS, the tunnel hop), so 2 s showed it offline. The popup shows "Checking
 * the witness" meanwhile.
 */
export const WITNESS_CHECK_TIMEOUT_MS = 6_000;

/**
 * Why a witness is not online, for the popup's hint:
 * - timeout: `/info` did not answer in time (a slow or congested network);
 * - wrong_signer: it answered, but for a key that is not pinned (never a network matter);
 * - unreachable: anything else (refused, a bad answer, no URL).
 */
export type WitnessWhy = 'timeout' | 'wrong_signer' | 'unreachable';

export type WitnessProbe = { ok: true } | { ok: false; why: WitnessWhy };

const isTimeout = (err: unknown) =>
  typeof err === 'object' &&
  err !== null &&
  ((err as { name?: unknown }).name === 'TimeoutError' ||
    (err as { name?: unknown }).name === 'AbortError');

/**
 * Health check: the witness is online when `GET {witnessUrl}/info` answers 200 with a
 * `signer` address within the timeout. When witnesses are pinned, the signer must be one
 * of them: a URL that answers for another key (a stale or hostile announcement) is not
 * our witness. No URL configured counts as offline. A failure says why.
 */
export async function probeWitness(
  witnessUrl: string | undefined,
  timeoutMs = WITNESS_CHECK_TIMEOUT_MS,
  pinned: readonly Address[] = [],
): Promise<WitnessProbe> {
  if (!witnessUrl) return { ok: false, why: 'unreachable' };
  try {
    const res = await fetch(
      new URL('info', witnessUrl.endsWith('/') ? witnessUrl : `${witnessUrl}/`),
      {
        signal: AbortSignal.timeout(timeoutMs),
        credentials: 'omit',
        cache: 'no-store',
      },
    );
    if (!res.ok) return { ok: false, why: 'unreachable' };
    const info = (await res.json()) as { signer?: unknown };
    if (typeof info.signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(info.signer)) {
      return { ok: false, why: 'unreachable' };
    }
    const signer = info.signer.toLowerCase();
    if (pinned.length === 0 || pinned.some((p) => p.toLowerCase() === signer)) return { ok: true };
    return { ok: false, why: 'wrong_signer' };
  } catch (err) {
    return { ok: false, why: isTimeout(err) ? 'timeout' : 'unreachable' };
  }
}

/** `probeWitness` as a yes or no. */
export async function witnessOnline(
  witnessUrl: string | undefined,
  timeoutMs = WITNESS_CHECK_TIMEOUT_MS,
  pinned: readonly Address[] = [],
): Promise<boolean> {
  return (await probeWitness(witnessUrl, timeoutMs, pinned)).ok;
}
