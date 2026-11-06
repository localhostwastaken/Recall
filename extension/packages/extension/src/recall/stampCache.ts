// Offscreen document: the stamp each chunk address got from each batch, kept for the life of the
// document. A retried upload (a new attempt for the same capture, or the evidence of a capture
// re-sent) then re-sends the stamp a chunk already has instead of taking another slot of the
// batch: at depth 18 a bucket holds only 4 stamps, so re-stamping a whole snapshot on every retry
// would soon fill a bucket and finish the batch. Bee accepts an identical stamp sent again.
import type { Stamper } from '@recall/net/swarm';

type Envelope = ReturnType<Stamper['stamp']>;

/** Most entries kept; past this the cache starts over (a depth-18 batch has 262,144 slots). */
const MAX_ENTRIES = 300_000;

const cache = new Map<string, Envelope>();

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * `real`, except that an address this batch already stamped gets its earlier stamp back and
 * `real.stamp` is not called again (its bucket counter does not move).
 */
export function cachingStamper(batchId: string, real: Pick<Stamper, 'stamp'>): Pick<Stamper, 'stamp'> {
  const batch = batchId.replace(/^0x/, '').toLowerCase();
  return {
    stamp(address: Uint8Array, timestampMs?: number) {
      const key = `${batch}:${hex(address)}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const env = real.stamp(address, timestampMs);
      if (cache.size >= MAX_ENTRIES) cache.clear();
      cache.set(key, env);
      return env;
    },
  };
}

/** Tests only: forget every stamp. */
export function resetStampCache(): void {
  cache.clear();
}
