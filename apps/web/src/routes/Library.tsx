import { Search } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { Duo } from '../brand/Duo';
import { CaptureCard, type CardStatus } from '../components/CaptureCard';
import { filterSort, isTestAddress, shortAddress, type PageEntry } from '../library/model';
import { getNetConfig } from '../net';
import { LibraryKeepAlive, useKeepAliveLibrary } from '../library/LibraryKeepAlive';
import { useLibrary, type LibraryData } from '../library/useLibrary';
import { libraryHash, parseHash, type LibrarySort, type LibraryType, type LibraryView } from '../router';
import { goToSection } from '../sectionNav';
import { Notice } from '../ui/Notice';
import { Segmented } from '../ui/Segmented';
import { Switch } from '../ui/Switch';
import './library.css';

export { KEEP_ALIVE_HINT } from '../library/LibraryKeepAlive';

const TYPES: { value: LibraryType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'page', label: 'Pages' },
  { value: 'repo', label: 'Repos' },
];
const SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'time', label: 'Most time left' },
  { value: 'newest', label: 'Newest' },
  { value: 'ending', label: 'Ending soon' },
];
const SEARCH_DEBOUNCE_MS = 200;
const SKELETON_CARDS = 6;

/**
 * The card's one action: keep-alive for the page's newest capture, in place. A card not verified
 * yet has a disabled button that says why. `lib` must come from `useKeepAliveLibrary`, so the
 * card counts up and the grid re-ranks once the new days are read.
 */
export function keepAliveSlot(entry: PageEntry, verified: boolean, _hintId: string, lib: LibraryData): ReactNode {
  return <LibraryKeepAlive entry={entry} verified={verified} onExtended={lib.refreshDays} />;
}

/**
 * Asks for a card's check when it comes within 200 px of the screen (only cards in view are
 * verified), and again for the cards in view whenever `entries` changes (a fresh read may reset a
 * card). Without IntersectionObserver every card asks (the queue still runs three at a time).
 */
export function useCheckOnView(requestCheck: (urlHash: Hex) => void, entries?: readonly unknown[]) {
  const req = useRef(requestCheck);
  req.current = requestCheck;
  const els = useRef(new Set<HTMLElement>());
  const visible = useRef(new Set<Element>());
  const observer = useRef<IntersectionObserver | null>(null);
  const ask = (el: Element) => {
    const h = (el as HTMLElement).dataset.urlHash;
    if (h) req.current(h as Hex);
  };
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      els.current.forEach(ask);
      return;
    }
    const o = new IntersectionObserver(
      (items) => {
        for (const it of items) {
          if (it.isIntersecting) {
            visible.current.add(it.target);
            ask(it.target);
          } else visible.current.delete(it.target);
        }
      },
      { rootMargin: '200px' },
    );
    observer.current = o;
    els.current.forEach((el) => o.observe(el));
    return () => {
      o.disconnect();
      observer.current = null;
      visible.current.clear();
    };
  }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') els.current.forEach(ask);
    else visible.current.forEach((el) => (els.current.has(el as HTMLElement) ? ask(el) : visible.current.delete(el)));
  }, [entries]);
  return useCallback((el: HTMLElement | null) => {
    if (!el) return;
    els.current.add(el);
    if (observer.current) observer.current.observe(el);
    else if (typeof IntersectionObserver === 'undefined') ask(el);
    return () => {
      els.current.delete(el);
      visible.current.delete(el);
      observer.current?.unobserve(el);
    };
  }, []);
}

/** A card's status: green only after this browser verified the page's newest capture. */
export function cardStatus(lib: Pick<LibraryData, 'check'>, urlHash: Hex): CardStatus {
  return lib.check.get(urlHash) ?? 'unchecked';
}

/** One library card in a grid cell, observed so it is checked when it scrolls into view. */
export function LibraryCardItem({
  entry,
  lib,
  rank,
  observe,
  keepAlive = keepAliveSlot,
}: {
  entry: PageEntry;
  lib: LibraryData;
  rank?: number;
  observe: (el: HTMLElement | null) => void;
  keepAlive?: (entry: PageEntry, verified: boolean, hintId: string, lib: LibraryData) => ReactNode;
}) {
  const hintId = useId();
  const status = cardStatus(lib, entry.urlHash);
  const verified = status === 'verified';
  // Until verified the title names only the host (the address line has path and query); then the
  // page's own <title>. The date is shown once the check proved the record's time.
  const host = shortAddress(entry.address.split('/')[0] || entry.address, 60);
  const title = (verified && lib.titles.get(entry.urlHash)) || `Capture of ${host}`;
  const date = verified ? new Date(Number(entry.signedAt) * 1000) : undefined;
  return (
    <li ref={observe} data-url-hash={entry.urlHash} data-flip-id={entry.urlHash} className="lib-cell">
      <CaptureCard
        title={title}
        address={shortAddress(entry.address)}
        href={`#/c/${entry.newest.entityKey}`}
        status={status}
        rank={rank}
        kind={entry.kind}
        versions={entry.versions}
        date={date}
        daysLeft={lib.days.get(entry.urlHash) ?? null}
        keepAlive={status === 'unverified' ? undefined : keepAlive(entry, verified, hintId, lib)}
        className={verified ? undefined : 'lib-claim'}
      />
    </li>
  );
}

/** Placeholder cards while the library is read (same size as a card, so nothing jumps). */
export function SkeletonGrid({ count = SKELETON_CARDS }: { count?: number }) {
  return (
    <ul className="lib-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="lib-cell">
          <div className="lib-skel">
            <div className="lib-skel-head">
              <span className="lib-skel-fav" />
              <span className="lib-skel-lines">
                <span className="lib-skel-line" />
                <span className="lib-skel-line short" />
              </span>
            </div>
            <span className="lib-skel-line pill" />
            <span className="lib-skel-line bar" />
          </div>
        </li>
      ))}
    </ul>
  );
}

const installClick = (e: MouseEvent<HTMLAnchorElement>) => {
  e.preventDefault();
  goToSection('install');
};

/** Nothing on Arkiv yet: the duo and the one thing to do. */
export function LibraryEmpty({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="lib-empty">
      <Duo className="lib-empty-art" />
      <H className="lib-empty-title">Nothing forgotten yet</H>
      <p className="lib-empty-text">Captures show up here as soon as someone saves one with the Recall extension.</p>
      <a className="btn btn-primary" href="#/" onClick={installClick}>
        Capture the first page
      </a>
    </div>
  );
}

/** Arkiv could not be read: an honest error and one way forward. */
export function LibraryError({ lib }: { lib: Pick<LibraryData, 'error' | 'retry'> }) {
  return (
    <Notice
      kind="error"
      title="The library couldn't be read from Arkiv"
      actions={
        <button type="button" className="btn btn-secondary" onClick={lib.retry}>
          Try again
        </button>
      }
    >
      <p>Arkiv may be busy or unreachable. Nothing here is marked verified until it can be read and checked.</p>
      {lib.error ? (
        <details className="tech-details lib-error-detail">
          <summary>Technical details</summary>
          <p>{lib.error}</p>
        </details>
      ) : null}
    </Notice>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The public library (spec 6.3): every capture on Arkiv, one card per page, searchable and
 * sortable, with the view kept in the address. A card says "Verified" only after this browser
 * checked the page's newest capture; cards in view are checked, three at a time.
 */
export function Library({ q = '', type = 'all', sort = 'time' }: Partial<LibraryView>) {
  const lib = useKeepAliveLibrary(useLibrary());
  const [text, setText] = useState(q);
  const [query, setQuery] = useState(q);
  const [kind, setKind] = useState<LibraryType>(type);
  const [order, setOrder] = useState<LibrarySort>(sort);
  const [showUnverified, setShowUnverified] = useState(false);
  const [showTests, setShowTests] = useState(false);
  const observe = useCheckOnView(lib.requestCheck, lib.entries);
  const searchId = useId();
  const sortId = useId();
  const unverifiedTitleId = useId();

  // The address can change under the page (Back, the header's Library link, a pasted link):
  // follow it. Typing does not fire this (the view is written with replaceState).
  useEffect(() => {
    setText(q);
    setQuery(q);
  }, [q]);
  useEffect(() => setKind(type), [type]);
  useEffect(() => setOrder(sort), [sort]);
  useEffect(() => {
    const follow = () => {
      const r = parseHash(window.location.hash);
      if (r.name !== 'library') return;
      setText(r.q);
      setQuery(r.q);
      setKind(r.type);
      setOrder(r.sort);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  useEffect(() => {
    if (text === query) return;
    const t = setTimeout(() => setQuery(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, query]);

  // The view lives in the address (shareable). replaceState: typing makes no history entries
  // and no route change (focus stays in the search box).
  useEffect(() => {
    const next = libraryHash({ q: query, type: kind, sort: order });
    if (window.location.hash === next) return;
    try {
      window.history.replaceState(window.history.state, '', next);
    } catch {
      /* the address just keeps the old view */
    }
  }, [query, kind, order]);

  const view: LibraryView = { q: query, type: kind, sort: order };
  // On the live network our own test pages (the fictional notice) are hidden unless asked for.
  const hidesTests = getNetConfig().arkiv.chain === 'rabdi';
  const tests = hidesTests ? lib.entries.filter((e) => isTestAddress(e.address)) : [];
  const entries = hidesTests && !showTests ? lib.entries.filter((e) => !isTestAddress(e.address)) : lib.entries;
  const listed = entries.filter((e) => lib.check.get(e.urlHash) !== 'unverified');
  const failed = entries.filter((e) => lib.check.get(e.urlHash) === 'unverified');
  const shown = filterSort(listed, view, lib.titles, lib.days);
  const shownFailed = filterSort(failed, view, lib.titles, lib.days);
  const filtering = query.trim() !== '' || kind !== 'all';

  const clear = () => {
    setText('');
    setQuery('');
    setKind('all');
  };

  let status = '';
  if (lib.status === 'loading') status = 'Reading the library from Arkiv…';
  else if (lib.status === 'ready' && lib.entries.length > 0) {
    status = filtering ? `Showing ${shown.length} of ${plural(listed.length, 'page', 'pages')}` : plural(listed.length, 'page', 'pages');
  }

  return (
    <section className="page library" aria-labelledby="library-title">
      <header className="lib-intro">
        <h1 id="library-title" tabIndex={-1}>
          Library
        </h1>
        <p className="lede">
          Every capture anyone has made with Recall, read live from Arkiv. A card says “Verified” only after this browser checks it
          against its signed evidence.
        </p>
      </header>

      <div className="lib-tools" role="search">
        <div className="lib-search">
          <label htmlFor={searchId} className="visually-hidden">
            Search the library
          </label>
          <Search size={18} strokeWidth={1.75} aria-hidden="true" className="lib-search-icon" />
          <input
            id={searchId}
            className="input lib-search-input"
            type="search"
            placeholder="Search a site, address or repo"
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="lib-type">
          <Segmented legend="Show" value={kind} options={TYPES} onChange={setKind} />
        </div>
        <div className="lib-sort">
          <label htmlFor={sortId} className="visually-hidden">
            Sort by
          </label>
          <select id={sortId} className="input lib-sort-select" value={order} onChange={(e) => setOrder(e.target.value as LibrarySort)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="lib-status" role="status" aria-live="polite">
        {status}
      </p>

      {lib.status === 'loading' ? <SkeletonGrid /> : null}

      {lib.status === 'error' ? <LibraryError lib={lib} /> : null}

      {lib.status === 'ready' && lib.entries.length === 0 ? <LibraryEmpty /> : null}

      {lib.status === 'ready' && lib.entries.length > 0 && shown.length === 0 ? (
        <div className="lib-none">
          <p>
            {filtering
              ? 'No captures match this search.'
              : 'None of the captures checked so far passed their checks in this browser.'}
          </p>
          {filtering ? (
            <button type="button" className="btn btn-secondary" onClick={clear}>
              Clear search and filters
            </button>
          ) : null}
        </div>
      ) : null}

      {lib.status === 'ready' && shown.length > 0 ? (
        <ul className="lib-grid" data-library-grid aria-label="Captures">
          {shown.map((e, i) => (
            <LibraryCardItem key={e.urlHash} entry={e} lib={lib} rank={order === 'time' ? i + 1 : undefined} observe={observe} />
          ))}
        </ul>
      ) : null}

      {lib.status === 'ready' && lib.truncated ? <p className="lib-note">Showing 1,000 captures. Arkiv has more than this page reads.</p> : null}

      {lib.status === 'ready' && tests.length > 0 ? (
        <div className="lib-unverified">
          <Switch label={`Show our test pages (${tests.length})`} checked={showTests} onChange={setShowTests} />
        </div>
      ) : null}

      {lib.status === 'ready' && shownFailed.length > 0 ? (
        <div className="lib-unverified">
          <Switch label={`Show unverified (${shownFailed.length})`} checked={showUnverified} onChange={setShowUnverified} />
          {showUnverified ? (
            <section aria-labelledby={unverifiedTitleId}>
              <h2 className="section-title" id={unverifiedTitleId}>
                Unverified
              </h2>
              <p className="lib-note">
                These captures didn't pass their checks in this browser: the evidence is missing or doesn't match, or a witness you
                don't trust signed it. Open one to see why.
              </p>
              <ul className="lib-grid" aria-label="Unverified captures">
                {shownFailed.map((e) => (
                  <LibraryCardItem key={e.urlHash} entry={e} lib={lib} observe={observe} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
