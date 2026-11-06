// Wording for a failure that came from a slow or broken network (isLikelyNetworkFailure in
// @recall/net decides when). Honest about what is kept and what was written, and always with a
// way forward. Real failures (a refusal, a mismatch, a rejected wallet request) never use it.

/** The upload of a captured page did not finish. The capture stays in the extension. */
export const UPLOAD_NETWORK_COPY = {
  title: "The upload couldn't finish on this connection",
  body: 'Your capture is kept. Try the upload again on a stronger connection.',
  retryLabel: 'Try upload again',
} as const;

/**
 * The publish step (the Arkiv write through MetaMask) could not reach the network. `sent`: the
 * wallet had already sent the transaction, so the record may have landed even though no receipt
 * came back. Trying again first looks for a record this account already wrote for this capture,
 * so it is never written twice.
 */
export function publishNetworkCopy(sent: boolean): { title: string; body: string } {
  return {
    title: "Couldn't reach the network to publish",
    body: sent
      ? 'The record may already have been written. Try again: Recall looks for it first, so it is never written twice. Your capture is still pending.'
      : 'Nothing was written. Try again.',
  };
}
