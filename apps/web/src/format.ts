import { formatUnits } from 'viem';

/**
 * Rounds a token amount UP to `sig` significant digits, in integer arithmetic. Amounts the
 * person has to have or pay are shown this way, so a figure on screen is never below the
 * real requirement.
 */
export function ceilSig(value: bigint, sig = 3): bigint {
  if (value <= 0n) return 0n;
  const scale = 10n ** BigInt(Math.max(value.toString().length - sig, 0));
  return ((value + scale - 1n) / scale) * scale;
}

/** Exact decimal string, trailing zeros trimmed (no floating point). */
export const formatToken = (value: bigint, decimals: number): string => formatUnits(value, decimals);

/** xBZZ has 16 decimals. */
export const formatBzz = (v: bigint) => formatToken(v, 16);
/** xDAI has 18 decimals. */
export const formatXdai = (v: bigint) => formatToken(v, 18);

/** An amount to pay or hold, rounded up to 3 significant digits: 0.0381, 0.00042, 1.24. */
export const formatBzzCeil = (v: bigint) => formatBzz(ceilSig(v));
export const formatXdaiCeil = (v: bigint) => formatXdai(ceilSig(v));

/** "6 d 23 h", "5 h 10 min", "under 1 min". */
export function formatTtl(seconds: bigint): string {
  const s = Number(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return m > 0 ? `${m} min` : 'under 1 min';
}
