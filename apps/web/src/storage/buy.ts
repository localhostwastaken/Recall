// Buying one storage batch, shared by the Storage page (bulk) and the publish page (one batch
// for the capture waiting there). Never twice: the createBatch hash is kept from the moment
// MetaMask sends it (onSent) until the caller knows the outcome, and a purchase whose result
// was not read is looked up by that hash (batchFromTx) before anything is bought again. The
// price may rise at most 10% between the quote and the purchase (quotedTotal).
import { batchFromTx, batchTtlSeconds, buyBatch } from '@recall/net';
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { defaultSettings, getSettings, isSharedOrigin } from '../settings';
import { isUserRejection } from '../wallet';

/** One batch per capture; depth 17 is the capture default (design brief 4.7). */
export const DEPTH = 17;
/** How long a sent purchase is looked up before it counts as "not known yet". */
export const SETTLE_TIMEOUT_MS = 30_000;
/** Bee needs about 12 blocks (1 to 2 minutes) before it accepts stamps for a new batch. */
export const USABLE_TIMEOUT_MS = 4 * 60_000;

/**
 * The createBatch hash under `key`, kept until its outcome is known, so a retry looks the
 * purchase up instead of paying for it again: in memory for as long as the app is open, and in
 * this tab's sessionStorage so it survives a reload. Not in sessionStorage on a shared /bzz/
 * origin (R38), where another site could plant one, nor when the browser blocks it: there memory
 * alone keeps it.
 */
const sentInMemory = new Map<string, Hex>();
export function rememberSent(key: string, txHash: Hex): void {
  sentInMemory.set(key, txHash);
  if (isSharedOrigin()) return;
  try {
    window.sessionStorage.setItem(key, txHash);
  } catch {
    /* storage blocked: memory keeps it */
  }
}
export function recallSent(key: string): Hex | undefined {
  if (!isSharedOrigin()) {
    try {
      const v = window.sessionStorage.getItem(key);
      if (v && /^0x[0-9a-fA-F]{64}$/.test(v)) return v as Hex;
    } catch {
      /* storage blocked: memory keeps it */
    }
  }
  return sentInMemory.get(key);
}
export function forgetSent(key: string): void {
  sentInMemory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* nothing stored */
  }
}

/** "the batch price rose to <n> (16 decimals) from the quoted <m>": buyBatch's price ceiling. */
export function priceRose(err: unknown): { total: bigint; quoted: bigint } | null {
  const m = /price rose to (\d+) \(16 decimals\) from the quoted (\d+)/.exec(err instanceof Error ? err.message : '');
  return m ? { total: BigInt(m[1]!), quoted: BigInt(m[2]!) } : null;
}
export const reason = (e: unknown) =>
  (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : String(e));

export type Settled = { kind: 'bought'; batchId: Hex; ttl: bigint | null } | { kind: 'none' | 'unknown' };

/**
 * The batch a sent purchase made: `bought`, `none` (it bought nothing: safe to buy again) or
 * `unknown` (it may still go through: never buy again by itself). A batch for another owner or
 * depth (an older plan in this tab) is not this purchase's. The caller forgets the hash.
 */
export async function settlePurchase(pub: PublicClient, txHash: Hex, owner: Address, depth = DEPTH): Promise<Settled> {
  const r = await batchFromTx(pub, txHash, { timeoutMs: SETTLE_TIMEOUT_MS });
  if (r.status === 'unknown') return { kind: 'unknown' };
  if (r.status === 'created' && r.owner.toLowerCase() === owner.toLowerCase() && r.depth === depth) {
    const ttl = await batchTtlSeconds(pub, r.batchId).catch(() => null);
    return { kind: 'bought', batchId: r.batchId, ttl };
  }
  return { kind: 'none' };
}

export type BuyResult =
  | { kind: 'bought'; batchId: Hex; ttl: bigint | null }
  /** Sent, but its result could not be read: it may have gone through. */
  | { kind: 'unknown'; txHash: Hex }
  /** MetaMask was refused before anything was sent: nothing was charged. */
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string; rose?: { total: bigint; quoted: bigint } };

/**
 * Buys one batch for `owner`. The hash is remembered under `sentKey` as soon as MetaMask sends
 * it and is NOT forgotten here: the caller forgets it once the batch is safely in use (the
 * Storage page right away, the publish page once the extension holds the batch).
 */
export async function buyOneBatch(
  wallet: WalletClient,
  pub: PublicClient,
  opts: { owner: Address; days: number; quotedTotal?: bigint; sentKey: string; onSent?: (txHash: Hex) => void },
): Promise<BuyResult> {
  let sent: Hex | undefined;
  try {
    const { batchId } = await buyBatch(wallet, {
      owner: opts.owner,
      depth: DEPTH,
      days: opts.days,
      quotedTotal: opts.quotedTotal, // the price may move up 10% at most between the quote and the purchase
      onSent: (txHash) => {
        sent = txHash;
        rememberSent(opts.sentKey, txHash);
        opts.onSent?.(txHash);
      },
    });
    const ttl = await batchTtlSeconds(pub, batchId).catch(() => null);
    return { kind: 'bought', batchId, ttl };
  } catch (err) {
    if (sent) {
      const found = await settlePurchase(pub, sent, opts.owner);
      if (found.kind === 'bought') return found; // only reading the result failed
      if (found.kind === 'unknown') return { kind: 'unknown', txHash: sent };
      return { kind: 'failed', message: reason(err) };
    }
    if (isUserRejection(err)) return { kind: 'cancelled' };
    const rose = priceRose(err);
    return { kind: 'failed', message: reason(err), ...(rose ? { rose } : {}) };
  }
}

/**
 * Whether the extension a link names (`?ext=`) may be used without asking: only when it is the
 * one in Settings or the build default. Any other one reports a stamp address that would own
 * what is bought, so the person confirms it first.
 */
export function linkNeedsConfirm(linkId: string | undefined): boolean {
  if (!linkId) return false;
  return linkId !== (getSettings().extensionId || undefined) && linkId !== defaultSettings().extensionId;
}
