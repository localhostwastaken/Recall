import { ArrowDownUp, ChevronDown, Search, SearchX, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { Hex } from 'viem';
import { Duo } from '../brand/Duo';
import { CaptureCard, type CardStatus } from '../components/CaptureCard';
import { filterSort, isTestAddress, shortAddress, type PageEntry } from '../library/model';
import { getNetConfig } from '../net';
import { LibraryKeepAlive, useKeepAliveLibrary } from '../library/LibraryKeepAlive';
import { PAGE_SIZE, pageOf, paginate } from '../library/paginate';
import { celebrateCard, prefersReducedMotion, type Stop } from '../library/rerank';
import { useLibrary, type LibraryData } from '../library/useLibrary';
import { libraryHash, parseHash, type LibrarySort, type LibraryType, type LibraryView } from '../router';
import { goToSection } from '../sectionNav';
import { Notice } from '../ui/Notice';
import { Pagination } from '../ui/Pagination';
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
/** Placeholder cards while the library is read: one page of them, so the grid keeps its height. */
const SKELETON_CARDS = 9;

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

/**
 * Placeholder cards while the library is read: the card's own rows (title and address, the status
 * pill and facts, then days, bar and button) at the card's height, so nothing jumps.
 */
export function SkeletonGrid({ count = SKELETON_CARDS }: { count?: number }) {
  return (
    <ul className="lib-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="lib-cell">
          <div className="lib-skel">
            <span className="lib-skel-line title" />
            <span className="lib-skel-line addr" />
            <span className="lib-skel-facts">
              <span className="lib-skel-line pill" />
              <span className="lib-skel-line meta" />
            </span>
            <span className="lib-skel-foot">
              <span className="lib-skel-life">
                <span className="lib-skel-line days" />
                <span className="lib-skel-line bar" />
              </span>
              <span className="lib-skel-line action" />
            </span>
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

const TYPE_WORDS: Record<LibraryType, string> = { all: 'captures', page: 'pages', repo: 'repos' };

/**
 * Nothing to show for this view. With a search or filter: what was asked for and one way back to
 * everything. Without: every page checked so far failed its checks (they wait behind "Show unverified").
 */
function NoResults({ query, kind, onClear }: { query: string | null; kind: LibraryType; onClear: () => void }) {
  if (query === null) {
    return (
      <div className="lib-none">
        <span className="lib-none-icon" aria-hidden="true">
          <ShieldAlert size={20} strokeWidth={1.75} />
        </span>
        <p className="lib-none-title">Nothing verified yet</p>
        <p className="lib-none-text">None of the captures checked so far passed their checks in this browser.</p>
      </div>
    );
  }
  const words = TYPE_WORDS[kind];
  const action = query && kind !== 'all' ? 'Clear search and filters' : query ? 'Clear search' : 'Show all captures';
  return (
    <div className="lib-none">
      <span className="lib-none-icon" aria-hidden="true">
        <SearchX size={20} strokeWidth={1.75} />
      </span>
      <p className="lib-none-title">{query ? 'No captures match this search.' : `No ${words} in the library yet.`}</p>
      {query ? (
        <p className="lib-none-text">
          Nothing {kind === 'all' ? '' : `among the ${words} `}matches “<span className="lib-none-q">{query}</span>”. Try part of a site
          name, like github.
        </p>
      ) : (
        <p className="lib-none-text">They show up here as soon as someone captures one with the Recall extension.</p>
      )}
      <button type="button" className="btn btn-secondary" onClick={onClear}>
        {action}
      </button>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A view's identity: a new search, filter or order starts again on page 1. */
const viewKey = (q: string, type: LibraryType, sort: LibrarySort) => `${type}|${sort}|${q.trim().toLowerCase()}`;

/** Brings the top of the results into view after a page change (smoothly, unless motion is reduced). */
function scrollToResults(el: HTMLElement | null) {
  el?.scrollIntoView?.({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/**
 * The public library (spec 6.3): every capture on Arkiv, one card per page, searchable and
 * sortable, nine cards a page, with the view and the page kept in the address. A card says
 * "Verified" only after this browser checked the page's newest capture; cards in view are checked,
 * three at a time.
 */
export function Library({ q = '', type = 'all', sort = 'time', page = 1 }: Partial<LibraryView> & { page?: number }) {
  // A card kept alive whose new rank is on another page: the library turns to that page and the
  // card counts up there (see the effect below).
  const [arrival, setArrival] = useState<{ urlHash: Hex; from: number; to: number } | null>(null);
  const shownRef = useRef<PageEntry[]>([]);
  const currentKeyRef = useRef('');
  const lib = useKeepAliveLibrary(useLibrary(), (urlHash, from, to) => {
    const i = shownRef.current.findIndex((e) => e.urlHash === urlHash);
    if (i < 0) return;
    setPaged({ key: currentKeyRef.current, n: pageOf(i) });
    setArrival({ urlHash, from, to });
  });
  const [text, setText] = useState(q);
  const [query, setQuery] = useState(q);
  const [kind, setKind] = useState<LibraryType>(type);
  const [order, setOrder] = useState<LibrarySort>(sort);
  const [showUnverified, setShowUnverified] = useState(false);
  const [showTests, setShowTests] = useState(false);
  // The page asked for, tied to the view it was asked for in: any other view shows page 1.
  const [paged, setPaged] = useState({ key: viewKey(q, type, sort), n: page });
  const [failedPage, setFailedPage] = useState(1);
  /** Set by a page change, so the effect below brings the new cards into view once they render. */
  const [turned, setTurned] = useState<'main' | 'failed' | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const failedRef = useRef<HTMLElement>(null);
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
  useEffect(() => setPaged({ key: viewKey(q, type, sort), n: page }), [q, type, sort, page]);
  useEffect(() => {
    const follow = () => {
      const r = parseHash(window.location.hash);
      if (r.name !== 'library') return;
      setText(r.q);
      setQuery(r.q);
      setKind(r.type);
      setOrder(r.sort);
      setPaged({ key: viewKey(r.q, r.type, r.sort), n: r.page });
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  useEffect(() => {
    if (text === query) return;
    const t = setTimeout(() => setQuery(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, query]);

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
  shownRef.current = shown;
  const key = viewKey(query, kind, order);
  currentKeyRef.current = key;
  const asked = paged.key === key ? paged.n : 1;
  const slice = paginate(shown, asked);
  const failedSlice = paginate(shownFailed, failedPage);
  const ready = lib.status === 'ready';

  // The view lives in the address (shareable). replaceState: typing makes no history entries
  // and no route change (focus stays in the search box). Until the library is read, the page
  // asked for stays in the address (it can't be checked against the count yet).
  const pageInAddress = ready ? slice.page : asked;
  useEffect(() => {
    const next = libraryHash({ q: query, type: kind, sort: order, page: pageInAddress });
    if (window.location.hash === next) return;
    try {
      window.history.replaceState(window.history.state, '', next);
    } catch {
      /* the address just keeps the old view */
    }
  }, [query, kind, order, pageInAddress]);

  const turnTo = (n: number) => {
    setPaged({ key, n });
    setTurned('main');
  };
  const turnFailedTo = (n: number) => {
    setFailedPage(n);
    setTurned('failed');
  };
  // After a page change: the top of the results comes into view and the list takes the focus
  // (the button pressed may now be disabled, or far below), so the keyboard carries on from there.
  useEffect(() => {
    if (!turned) return;
    setTurned(null);
    const list = turned === 'main' ? gridRef.current : failedRef.current?.querySelector<HTMLElement>('.lib-grid') ?? null;
    scrollToResults(turned === 'main' ? toolsRef.current : failedRef.current);
    list?.focus({ preventScroll: true });
  }, [turned]);

  // A kept-alive card that moved to another page: show it there, count its days up, and give it
  // the focus its Keep alive button had. The count-up is stopped only if the page goes away.
  const arrivalStop = useRef<Stop | null>(null);
  useEffect(() => () => arrivalStop.current?.(), []);
  useEffect(() => {
    if (!arrival) return;
    setArrival(null);
    let slot: HTMLElement | null = null;
    for (const el of document.querySelectorAll<HTMLElement>('.lib-ka[data-ka-for]')) {
      if (el.dataset.kaFor === arrival.urlHash) slot = el;
    }
    const card = slot?.closest<HTMLElement>('.ccard') ?? null;
    if (!card) return;
    card.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    card.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
    if (prefersReducedMotion()) return;
    arrivalStop.current?.();
    arrivalStop.current = celebrateCard(card, arrival.from, arrival.to, null);
  }, [arrival]);

  const searchRef = useRef<HTMLInputElement>(null);
  const clear = () => {
    setText('');
    setQuery('');
    setKind('all');
    searchRef.current?.focus();
  };

  let status = '';
  if (lib.status === 'loading') status = 'Reading the library from Arkiv…';
  else if (lib.status === 'ready' && lib.entries.length > 0) {
    if (slice.pages > 1) {
      const range = `${slice.first.toLocaleString('en-US')}–${slice.last.toLocaleString('en-US')}`;
      status = filtering
        ? `Showing ${range} of ${plural(shown.length, 'matching page', 'matching pages')}`
        : `Showing ${range} of ${plural(listed.length, 'page', 'pages')}`;
    } else {
      status = filtering ? `Showing ${shown.length} of ${plural(listed.length, 'page', 'pages')}` : plural(listed.length, 'page', 'pages');
    }
    if (order === 'time' && shown.length > 1) status += ' · ranked by time left';
  }
  const showTestSwitch = lib.status === 'ready' && tests.length > 0;
  const showFoot = lib.status === 'ready' && (lib.truncated || shownFailed.length > 0);

  return (
    <section className="page library" aria-labelledby="library-title">
      <header className="lib-intro">
        <h1 id="library-title" tabIndex={-1}>
          Library
        </h1>
        <p className="lib-lede">
          Every page anyone has captured with Recall, read live from Arkiv. A card says “Verified” only after this browser checks
          its signed evidence.
        </p>
      </header>

      <div className="lib-tools" role="search" ref={toolsRef}>
        <div className="lib-search">
          <label htmlFor={searchId} className="visually-hidden">
            Search the library
          </label>
          <Search size={18} strokeWidth={1.75} aria-hidden="true" className="lib-search-icon" />
          <input
            ref={searchRef}
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
          <ArrowDownUp size={16} strokeWidth={1.75} aria-hidden="true" className="lib-sort-icon" />
          <select id={sortId} className="input lib-sort-select" value={order} onChange={(e) => setOrder(e.target.value as LibrarySort)}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className="lib-sort-chevron" />
        </div>
      </div>

      <div className={status || showTestSwitch ? 'lib-meta' : 'lib-meta is-empty'}>
        <p className="lib-status" role="status" aria-live="polite">
          {status}
        </p>
        {showTestSwitch ? (
          <div className="lib-quiet" title="Pages we captured ourselves while building Recall">
            <Switch label={`Show our test pages (${tests.length})`} checked={showTests} onChange={setShowTests} />
          </div>
        ) : null}
      </div>

      {lib.status === 'loading' ? <SkeletonGrid /> : null}

      {lib.status === 'error' ? <LibraryError lib={lib} /> : null}

      {lib.status === 'ready' && lib.entries.length === 0 ? <LibraryEmpty /> : null}

      {lib.status === 'ready' && lib.entries.length > 0 && shown.length === 0 ? (
        <NoResults query={filtering ? query.trim() : null} kind={kind} onClear={clear} />
      ) : null}

      {lib.status === 'ready' && shown.length > 0 ? (
        <>
          <ul
            ref={gridRef}
            className="lib-grid"
            data-library-grid
            tabIndex={-1}
            aria-label={slice.pages > 1 ? `Captures, page ${slice.page} of ${slice.pages}` : 'Captures'}
          >
            {slice.items.map((e, i) => (
              <LibraryCardItem
                key={e.urlHash}
                entry={e}
                lib={lib}
                rank={order === 'time' ? (slice.page - 1) * PAGE_SIZE + i + 1 : undefined}
                observe={observe}
              />
            ))}
          </ul>
          <Pagination page={slice.page} pages={slice.pages} onChange={turnTo} label="Library pages" />
        </>
      ) : null}

      {showFoot ? (
        <div className="lib-foot">
          {lib.truncated ? <p className="lib-note">Showing 1,000 captures. Arkiv has more than this page reads.</p> : null}
          {shownFailed.length > 0 ? (
            <div className="lib-quiet">
              <Switch label={`Show unverified (${shownFailed.length})`} checked={showUnverified} onChange={setShowUnverified} />
            </div>
          ) : null}
          {shownFailed.length > 0 && showUnverified ? (
            <section className="lib-unverified" aria-labelledby={unverifiedTitleId} ref={failedRef}>
              <h2 className="section-title" id={unverifiedTitleId}>
                Unverified
              </h2>
              <p className="lib-note">
                These captures didn't pass their checks in this browser: the evidence is missing or doesn't match, or a witness you
                don't trust signed it. Open one to see why.
              </p>
              <ul className="lib-grid" tabIndex={-1} aria-label="Unverified captures">
                {failedSlice.items.map((e) => (
                  <LibraryCardItem key={e.urlHash} entry={e} lib={lib} observe={observe} />
                ))}
              </ul>
              <Pagination page={failedSlice.page} pages={failedSlice.pages} onChange={turnFailedTo} label="Unverified pages" />
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
