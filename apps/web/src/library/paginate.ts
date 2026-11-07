/** Cards on one page of the library: three rows of three on a desktop. */
export const PAGE_SIZE = 9;

export type PageSlice<T> = {
  /** The items on this page. */
  items: T[];
  /** The page shown (1-based), kept inside 1..pages. */
  page: number;
  /** How many pages there are (at least 1, even with nothing to show). */
  pages: number;
  /** The 1-based position of the first and the last item on this page (0 and 0 when there are none). */
  first: number;
  last: number;
};

/** One page of `items`. A page past the end shows the last page; anything below 1 shows the first. */
export function paginate<T>(items: readonly T[], page: number, size = PAGE_SIZE): PageSlice<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const wanted = Number.isFinite(page) ? Math.floor(page) : 1;
  const p = Math.min(Math.max(1, wanted), pages);
  const start = (p - 1) * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: p, pages, first: slice.length ? start + 1 : 0, last: start + slice.length };
}

/** The page an item at `index` (0-based) sits on. */
export const pageOf = (index: number, size = PAGE_SIZE): number => Math.floor(Math.max(0, index) / size) + 1;

/**
 * The page numbers the pager shows: every page up to seven, otherwise always seven slots (the first
 * and the last page, the current one with its neighbours, and a gap for each skipped run), so the
 * buttons don't jump about as you step through.
 */
export function pageList(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, 'gap', pages];
  if (page >= pages - 3) return [1, 'gap', pages - 4, pages - 3, pages - 2, pages - 1, pages];
  return [1, 'gap', page - 1, page, page + 1, 'gap', pages];
}
