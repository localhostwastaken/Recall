import { ChevronLeft, ChevronRight } from 'lucide-react';
import { pageList } from '../library/paginate';
import './pagination.css';

/**
 * Previous, the page numbers and Next, under a list of results. The current page is a state, not an
 * action, so it is drawn in neutral ink like the selected option of a segmented control (never
 * orange). On a phone the numbers give way to "Page 2 of 5". Nothing is shown for a single page.
 */
export function Pagination({
  page,
  pages,
  onChange,
  label = 'Pages',
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  /** The navigation landmark's name (two pagers on one screen need different names). */
  label?: string;
}) {
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label={label}>
      <button type="button" className="btn btn-secondary pager-step" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
        Previous
      </button>
      <ol className="pager-pages">
        {pageList(page, pages).map((n, i) =>
          n === 'gap' ? (
            <li key={`gap-${i}`} className="pager-gap" aria-hidden="true">
              …
            </li>
          ) : (
            <li key={n}>
              <button
                type="button"
                className="pager-num"
                aria-label={`Page ${n}`}
                aria-current={n === page ? 'page' : undefined}
                onClick={() => {
                  if (n !== page) onChange(n);
                }}
              >
                {n}
              </button>
            </li>
          ),
        )}
      </ol>
      <p className="pager-where">
        Page {page} of {pages}
      </p>
      <button type="button" className="btn btn-secondary pager-step" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Next
        <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </nav>
  );
}
