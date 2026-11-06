import { ArrowRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { filterSort, type PageEntry } from '../library/model';
import { useLibrary, type LibraryData } from '../library/useLibrary';
import { LibraryCardItem, LibraryEmpty, LibraryError, SkeletonGrid, keepAliveSlot, useCheckOnView } from '../routes/Library';
import '../routes/library.css';

const PREVIEW_CARDS = 3;

/** The card action in the preview (the same slot as the library page). */
function previewKeepAlive(entry: PageEntry, verified: boolean, hintId: string, lib: LibraryData): ReactNode {
  return keepAliveSlot(entry, verified, hintId, lib);
}

/**
 * Hero stats: captures (all versions), sites (distinct hosts) and repos, from the shared library
 * read. Null until the library has been read. The hero shows them only when there are enough.
 */
export function useLibraryCounts(): { captures: number; sites: number; repos: number } | null {
  const lib = useLibrary();
  if (lib.status !== 'ready') return null;
  const hosts = new Set(lib.entries.map((e) => e.address.split('/')[0]!.toLowerCase()));
  return { captures: lib.captureCount, sites: hosts.size, repos: lib.entries.filter((e) => e.kind === 'repo').length };
}

/**
 * Landing section 3: the three pages with the most time left (verified or still being checked;
 * failed ones never show here), and the way into the full library.
 */
export function LibraryPreview({ id = 'library-preview' }: { id?: string }) {
  const lib = useLibrary();
  const observe = useCheckOnView(lib.requestCheck);
  const titleId = useId();
  const listed = lib.entries.filter((e) => lib.check.get(e.urlHash) !== 'unverified');
  const top = filterSort(listed, { q: '', type: 'all', sort: 'time' }, lib.titles, lib.days).slice(0, PREVIEW_CARDS);
  return (
    <section id={id} className="lib-preview" aria-labelledby={titleId}>
      <div className="lib-preview-head">
        <div>
          <h2 className="section-title" id={titleId}>
            The public library
          </h2>
          <p>Every capture anyone has made, searchable. The ones people keep alive rise to the top.</p>
        </div>
        <a className="btn btn-secondary" href="#/library">
          Open the library
          <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </a>
      </div>
      {lib.status === 'loading' ? <SkeletonGrid count={PREVIEW_CARDS} /> : null}
      {lib.status === 'error' ? <LibraryError lib={lib} /> : null}
      {lib.status === 'ready' && lib.entries.length === 0 ? <LibraryEmpty headingLevel={3} /> : null}
      {lib.status === 'ready' && top.length > 0 ? (
        <ul className="lib-grid" data-library-grid aria-label="Captures with the most time left">
          {top.map((e, i) => (
            <LibraryCardItem key={e.urlHash} entry={e} lib={lib} rank={i + 1} observe={observe} keepAlive={previewKeepAlive} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
