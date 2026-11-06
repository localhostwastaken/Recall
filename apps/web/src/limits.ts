/**
 * Row budget for one address's timeline. The default (2000 rows per kind) lives in
 * `listByUrl`. In the dev server only, `?maxRows=<n>` before the `#` lowers it so the
 * "too many records" notice can be tested without writing thousands of records. A production
 * build ignores it.
 */
export function listOptions(): { maxRows?: number } {
  if (!import.meta.env.DEV) return {};
  const n = Number(new URLSearchParams(window.location.search).get('maxRows'));
  return Number.isInteger(n) && n >= 1 && n <= 5000 ? { maxRows: n } : {};
}
