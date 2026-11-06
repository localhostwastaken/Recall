import type { Address } from 'viem';

/**
 * How long the popup waits for `GET {witness}/info` before calling the witness offline. The
 * live witness sits behind a Cloudflare quick tunnel, where a browser's first /info measured
 * about 2 s (DNS, TLS, the tunnel hop), so 2 s showed it offline. The popup shows "Checking
 * the witness" meanwhile.
 */
export const WITNESS_CHECK_TIMEOUT_MS = 6_000;

/**
 * Health check: the witness is online when `GET {witnessUrl}/info` answers 200 with a
 * `signer` address within the timeout. When witnesses are pinned, the signer must be one
 * of them: a URL that answers for another key (a stale or hostile announcement) is not
 * our witness. No URL configured counts as offline.
 */
export async function witnessOnline(
  witnessUrl: string | undefined,
  timeoutMs = WITNESS_CHECK_TIMEOUT_MS,
  pinned: readonly Address[] = [],
): Promise<boolean> {
  if (!witnessUrl) return false;
  try {
    const res = await fetch(new URL('info', witnessUrl.endsWith('/') ? witnessUrl : `${witnessUrl}/`), {
      signal: AbortSignal.timeout(timeoutMs),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const info = (await res.json()) as { signer?: unknown };
    if (typeof info.signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(info.signer)) return false;
    const signer = info.signer.toLowerCase();
    return pinned.length === 0 || pinned.some((p) => p.toLowerCase() === signer);
  } catch {
    return false;
  }
}
