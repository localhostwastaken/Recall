/**
 * Budgets for one address's timeline.
 *
 * - `maxRows`: the row budget per kind (default 2000, in `listByUrl`).
 * - `batch`: how many records are checked automatically, and per "Check the next" click
 *   (default 100). Anyone can publish records for any address, so checking every one by
 *   default would let spam cost the reader bandwidth and time.
 *
 * - `pageSize`: the most rows drawn at once in a list that spam can make long (default 50);
 *   "Show more" adds this many.
 *
 * In the dev server only, `?maxRows=<n>`, `?batch=<n>` and `?page=<n>` before the `#` lower them so the
 * "too many records" notice and the "check the next" button can be tested without writing
 * thousands of records. A production build ignores both.
 */
export const DEFAULT_CHECK_BATCH = 100;
export const DEFAULT_PAGE_SIZE = 50;

function devNumber(name: string, max: number): number | undefined {
  if (!import.meta.env.DEV) return undefined;
  const n = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
}

export function listOptions(): { maxRows?: number } {
  const maxRows = devNumber('maxRows', 5000);
  return maxRows === undefined ? {} : { maxRows };
}

export const checkBatch = (): number => devNumber('batch', 1000) ?? DEFAULT_CHECK_BATCH;

export const pageSize = (): number => devNumber('page', 1000) ?? DEFAULT_PAGE_SIZE;
