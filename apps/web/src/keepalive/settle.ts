import type { Hex } from 'viem';

/**
 * A wallet step that was sent but whose result never came back (the receipt wait failed, or timed
 * out) may still have gone through. Sending it again would pay twice, so a retry first asks the
 * chain what happened to the first one. Pure logic, with the chain reads passed in.
 */
export type Settled = 'landed' | 'not-landed' | 'unknown';

/** How long a transaction the node cannot show yet is given before the answer stays "unknown". */
export const SETTLE_WAIT_MS = 20_000;

export type SettleIo = {
  /** The transaction hash recorded when the step was sent, if it got that far. */
  hash?: Hex;
  /** The mined result of `hash`; 'absent' when the node does not know it (yet). Throws if unreadable. */
  receipt: (hash: Hex) => Promise<'success' | 'reverted' | 'absent'>;
  /** Waits up to `ms` for `hash` to be mined. */
  wait: (hash: Hex, ms: number) => Promise<'success' | 'reverted' | 'timeout'>;
  /**
   * True when the chain now shows the effect (the batch balance or the record expiry is higher than
   * before the step). Throws if the chain cannot be read.
   */
  moved: () => Promise<boolean>;
  waitMs?: number;
};

/**
 * - A mined receipt decides: success is `landed`, reverted is `not-landed` (nothing moved).
 * - A hash the node cannot show may be pending, or just not visible on this node yet (the wallet
 *   and the app read through different nodes): it is waited for, and if it still cannot be seen
 *   the answer is `unknown`, never "not sent".
 * - Without a hash (it never came back) the chain's own state decides: moved is `landed`, not
 *   moved is `not-landed`.
 * - If the chain cannot be read, the answer is `unknown`.
 */
export async function settle(io: SettleIo): Promise<Settled> {
  if (io.hash) {
    let seen: 'success' | 'reverted' | 'absent' | 'unreadable';
    try {
      seen = await io.receipt(io.hash);
    } catch {
      seen = 'unreadable';
    }
    if (seen === 'success') return 'landed';
    if (seen === 'reverted') return 'not-landed';
    let waited: 'success' | 'reverted' | 'timeout';
    try {
      waited = await io.wait(io.hash, io.waitMs ?? SETTLE_WAIT_MS);
    } catch {
      waited = 'timeout';
    }
    if (waited === 'success') return 'landed';
    if (waited === 'reverted') return 'not-landed';
  }
  let moved: boolean;
  try {
    moved = await io.moved();
  } catch {
    return 'unknown';
  }
  if (moved) return 'landed';
  return io.hash ? 'unknown' : 'not-landed';
}

/** True when `after` is a real step later than `before` (an hour: a top-up or an extension adds at least a day). */
export function datePassed(before: Date | null, after: Date | null): boolean | null {
  if (before === null || after === null) return null;
  return after.getTime() > before.getTime() + 3_600_000;
}
