export type GatewayCopy = 'same' | 'different' | 'unavailable';

/** How long the approve page waits for the gateway's copy before treating it as unavailable. */
export const GATEWAY_COPY_MS = 15_000;

/**
 * Free-mode captures sit on a gateway's own storage under a reference the page cannot compute
 * (R13). Before publishing, the page asks the download gateways for that reference and compares
 * what comes back with the evidence it just checked: the same bytes, other bytes (the record would
 * point at somebody else's file: never publish), or nothing yet (the gateway may need a moment, or
 * not serve it: a soft warning, not a block). `null` means nothing came back.
 */
export function compareGatewayCopy(gateway: Uint8Array | null, evidence: Uint8Array): GatewayCopy {
  if (gateway === null) return 'unavailable';
  if (gateway.length !== evidence.length) return 'different';
  for (let i = 0; i < gateway.length; i++) if (gateway[i] !== evidence[i]) return 'different';
  return 'same';
}
