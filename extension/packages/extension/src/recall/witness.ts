/** How long the popup waits for `GET {witness}/info` before calling the witness offline. */
export const WITNESS_CHECK_TIMEOUT_MS = 2_000;

/**
 * Health check: the witness is online when `GET {witnessUrl}/info` answers 200 with a
 * `signer` address within the timeout. No URL configured counts as offline.
 */
export async function witnessOnline(witnessUrl: string | undefined, timeoutMs = WITNESS_CHECK_TIMEOUT_MS): Promise<boolean> {
  if (!witnessUrl) return false;
  try {
    const res = await fetch(new URL('info', witnessUrl.endsWith('/') ? witnessUrl : `${witnessUrl}/`), {
      signal: AbortSignal.timeout(timeoutMs),
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const info = (await res.json()) as { signer?: unknown };
    return typeof info.signer === 'string' && /^0x[0-9a-fA-F]{40}$/.test(info.signer);
  } catch {
    return false;
  }
}
