import type { Hex } from 'viem';

/**
 * What step 1 (the storage top-up) has sent, kept in sessionStorage under the batch id. A reload
 * while the top-up is still pending in the wallet or the network starts the dialog over; without
 * this record it would pay a second time. With it, the retry first asks the chain what happened to
 * the first one (see `settle`). Everything here is best effort: a browser that refuses
 * sessionStorage (private window, blocked site data) simply keeps nothing, as before.
 */
export type SentTopUp = {
  batchId: Hex;
  /** The transaction hash, once the wallet sent the top-up. */
  hash?: Hex;
  /** The batch's normalised balance read just before step 1. */
  baseNormalised: bigint;
  /** The batch's end date read just before step 1 (ms), or null. */
  baseEndsAt: number | null;
};

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const keyFor = (batchId: Hex): string => `recall.keepalive.topup.${batchId.toLowerCase()}`;

const sessionStore = (): Store | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

export function saveSentTopUp(v: SentTopUp, store: Store | null = sessionStore()): void {
  try {
    store?.setItem(
      keyFor(v.batchId),
      JSON.stringify({ batchId: v.batchId, hash: v.hash, baseNormalised: v.baseNormalised.toString(10), baseEndsAt: v.baseEndsAt }),
    );
  } catch {
    /* nothing kept */
  }
}

/** The kept record for this batch, or null when there is none or it is not a record this code wrote. */
export function loadSentTopUp(batchId: Hex, store: Store | null = sessionStore()): SentTopUp | null {
  try {
    const raw = store?.getItem(keyFor(batchId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.batchId !== 'string' || v.batchId.toLowerCase() !== batchId.toLowerCase()) return null;
    if (typeof v.baseNormalised !== 'string' || !/^\d{1,78}$/.test(v.baseNormalised)) return null;
    if (v.hash !== undefined && v.hash !== null && !(typeof v.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.hash))) return null;
    if (v.baseEndsAt !== null && !(typeof v.baseEndsAt === 'number' && Number.isFinite(v.baseEndsAt))) return null;
    return {
      batchId,
      ...(typeof v.hash === 'string' ? { hash: v.hash as Hex } : {}),
      baseNormalised: BigInt(v.baseNormalised),
      baseEndsAt: v.baseEndsAt as number | null,
    };
  } catch {
    return null;
  }
}

/** Forgets the record: the chain gave a definite answer, so nothing is outstanding. */
export function clearSentTopUp(batchId: Hex, store: Store | null = sessionStore()): void {
  try {
    store?.removeItem(keyFor(batchId));
  } catch {
    /* nothing to forget */
  }
}
