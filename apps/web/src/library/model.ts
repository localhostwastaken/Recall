import { canonicalPageUrl, urlHash as hashUrl } from '@recall/evidence';
import type { ListedAttachment, ListedCapture } from '@recall/net';
import type { Hex } from 'viem';
import type { LibraryView } from '../router';

/**
 * One card of the library: every capture record of one page (same `urlHash`). Everything here
 * comes from the Arkiv index, so it is a claim until this browser verified the newest capture;
 * it is only used to group, order and search, and to show host + path before the check.
 */
export type PageEntry = {
  /**
   * The page's `urlHash`, the card's id. For a junk row (its address does not hash to its
   * `urlHash`) it is the row's own record key, so the row never joins or hides a real page.
   */
  urlHash: Hex;
  /** host + path: the newest record's claim until verified, then the verified evidence's. */
  address: string;
  /** The record's address does not hash to its `urlHash`: never checked, shown only as unverified. */
  junk?: boolean;
  kind: 'page' | 'repo';
  /** owner/repo, once the newest capture verified as a GitHub branch. */
  repo?: string;
  versions: number;
  newest: ListedCapture;
  signedAt: bigint;
};

/** The longest address a card shows (a hostile record can carry kilobytes). */
const MAX_ADDRESS = 200;

/** host + path + query, without the scheme, `www.` or a lone `/` path (two pages can differ only by their query). */
export function hostPath(canonicalUrl: string, fallback: string): string {
  let out = typeof fallback === 'string' ? fallback : '';
  try {
    const u = new URL(canonicalUrl);
    if (u.protocol === 'https:' || u.protocol === 'http:') out = `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    /* not a URL: the server name it claims */
  }
  out = out.replace(/\s+/g, ' ').trim() || 'unknown address';
  return out.length > MAX_ADDRESS ? `${out.slice(0, MAX_ADDRESS - 1)}…` : out;
}

/**
 * An address short enough for one card line that still tells pages apart: the host stays whole
 * and the middle of the path goes, so the end (often the only difference, e.g. `?run=…`) shows.
 */
export function shortAddress(address: string, max = 36): string {
  if (address.length <= max) return address;
  const slash = address.indexOf('/');
  const host = slash < 0 ? address : address.slice(0, slash);
  if (slash < 0 || host.length > max - 12) {
    const head = Math.ceil((max - 1) / 2);
    return `${address.slice(0, head)}…${address.slice(address.length - (max - 1 - head))}`;
  }
  return `${host}/…${address.slice(address.length - (max - host.length - 2))}`;
}

const lower = (h: string) => h.toLowerCase();
const newer = (a: ListedCapture, b: ListedCapture): boolean =>
  a.signedAt !== b.signedAt ? a.signedAt > b.signedAt : BigInt(a.entityKey) > BigInt(b.entityKey);

/**
 * One entry per page (`urlHash`, any case). The newest record is the one with the latest signed
 * time (a tie goes to the larger record key); a page is a repo when any of its captures is named
 * by a git attachment.
 */
/** True when the record's address, canonicalised as a capture does it, hashes to its `urlHash`. */
export function addressMatchesHash(r: Pick<ListedCapture, 'canonicalUrl' | 'urlHash'>): boolean {
  try {
    return hashUrl(canonicalPageUrl(r.canonicalUrl)).toLowerCase() === r.urlHash.toLowerCase();
  } catch {
    return false;
  }
}

export function groupByPage(rows: readonly ListedCapture[], attachments: readonly ListedAttachment[]): PageEntry[] {
  const gitParents = new Set(attachments.filter((a) => a.kind === 'git').map((a) => lower(a.parentCaptureKey)));
  const pages = new Map<string, { rows: ListedCapture[]; newest: ListedCapture; repo: boolean }>();
  const junk: PageEntry[] = [];
  for (const r of rows) {
    if (!addressMatchesHash(r)) {
      // Anyone can write a record naming any address: one whose address and hash disagree is
      // its own (unverified) card, so it can neither join a real page nor become its newest.
      junk.push({
        urlHash: lower(r.entityKey) as Hex,
        address: hostPath(r.canonicalUrl, r.serverName),
        junk: true,
        kind: 'page',
        versions: 1,
        newest: r,
        signedAt: r.signedAt,
      });
      continue;
    }
    const id = lower(r.urlHash);
    const p = pages.get(id);
    const git = gitParents.has(lower(r.entityKey));
    if (!p) pages.set(id, { rows: [r], newest: r, repo: git });
    else {
      p.rows.push(r);
      if (newer(r, p.newest)) p.newest = r;
      p.repo ||= git;
    }
  }
  const real = [...pages.values()].map(
    (p): PageEntry => ({
      urlHash: lower(p.newest.urlHash) as Hex,
      address: hostPath(p.newest.canonicalUrl, p.newest.serverName),
      kind: p.repo ? 'repo' : 'page',
      versions: p.rows.length,
      newest: p.newest,
      signedAt: p.newest.signedAt,
    }),
  );
  return [...real, ...junk];
}

/** Whole days until `expiresAtBlock`, at the chain's real block time; never below zero. */
export function daysLeft(expiresAtBlock: bigint, currentBlock: bigint, blockSeconds: number): number {
  if (expiresAtBlock <= currentBlock) return 0;
  return Math.max(0, Math.floor((Number(expiresAtBlock - currentBlock) * blockSeconds) / 86_400));
}

/**
 * The cards to show for a view: search over address, repo and title (case-insensitive), the
 * type filter, then the order. `time` = most days left first, `newest` = latest signed first,
 * `ending` = fewest days left first; unknown days always go last.
 */
export function filterSort(
  entries: readonly PageEntry[],
  view: LibraryView,
  titles: ReadonlyMap<Hex, string>,
  days: ReadonlyMap<Hex, number | null>,
): PageEntry[] {
  const q = view.q.trim().toLowerCase();
  const shown = entries.filter((e) => {
    if (view.type !== 'all' && e.kind !== view.type) return false;
    if (!q) return true;
    return [e.address, e.repo ?? '', titles.get(e.urlHash) ?? ''].some((s) => s.toLowerCase().includes(q));
  });
  const d = (e: PageEntry) => days.get(e.urlHash) ?? null;
  const byNewest = (a: PageEntry, b: PageEntry) => (a.signedAt === b.signedAt ? 0 : a.signedAt > b.signedAt ? -1 : 1);
  const byDays = (dir: 1 | -1) => (a: PageEntry, b: PageEntry) => {
    const x = d(a);
    const y = d(b);
    if (x === null && y === null) return byNewest(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * dir || byNewest(a, b);
  };
  return shown.sort(view.sort === 'newest' ? byNewest : byDays(view.sort === 'ending' ? 1 : -1));
}
