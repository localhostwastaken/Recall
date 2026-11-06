import { formatUnits } from 'viem';

const SIG = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3, useGrouping: false, maximumFractionDigits: 20 });

/** Token amount with three significant digits: 0.0379, 0.00028, 1.23. */
export function formatToken(value: bigint, decimals: number): string {
  return SIG.format(Number(formatUnits(value, decimals)));
}

/** xBZZ has 16 decimals. */
export const formatBzz = (v: bigint) => formatToken(v, 16);
/** xDAI has 18 decimals. */
export const formatXdai = (v: bigint) => formatToken(v, 18);

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
