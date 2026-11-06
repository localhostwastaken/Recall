import { CAPTURE_TYPES, WITNESS_DOMAIN, recoverWitness, type Statement } from '@recall/evidence';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * viem loads its secp256k1 code lazily, on the first signature it recovers. Run one
 * recovery at start-up (a throwaway key, nothing is shown) so that code is already in the
 * browser when a file is dropped, and "Works offline" holds even if the connection is gone
 * by then. Failures are ignored: the checks report their own errors.
 */
export async function warmUpVerifier(): Promise<void> {
  try {
    const message: Statement = {
      serverName: 'warm-up.invalid',
      connTime: 0n,
      signedAt: 0n,
      sentSha256: `0x${'00'.repeat(32)}`,
      recvSha256: `0x${'00'.repeat(32)}`,
      sentLen: 0,
      recvLen: 0,
      tlsVersion: 12,
      nonce: `0x${'00'.repeat(32)}`,
    };
    const signature = await privateKeyToAccount(`0x${'11'.repeat(32)}`).signTypedData({
      domain: WITNESS_DOMAIN,
      types: CAPTURE_TYPES,
      primaryType: 'Capture',
      message,
    });
    await recoverWitness(message, signature);
  } catch {
    /* nothing to do: a later check will say what failed */
  }
}
