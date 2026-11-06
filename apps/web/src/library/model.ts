import type { ListedAttachment, ListedCapture } from '@recall/net';
import type { Hex } from 'viem';
import type { LibraryView } from '../router';

/**
 * One card of the library: every capture record of one page (same `urlHash`). Everything here
 * comes from the Arkiv index, so it is a claim until this browser verified the newest capture;
 * it is only used to group, order and search, and to show host + path before the check.
 */
export type PageEntry = {
  urlHash: Hex;
  /** host + path of the newest record's address (a claim until verified). */
  address: string;
  kind: 'page' | 'repo';
  /** owner/repo, once the newest capture verified as a GitHub branch. */
  repo?: string;
  versions: number;
  newest: ListedCapture;
  signedAt: bigint;
};

/** The longest address a card shows (a hostile record can carry kilobytes). */
const MAX_ADDRESS = 200;

/** host + path, without the scheme, `www.`, query or a trailing slash. */
export function hostPath(canonicalUrl: string, fallback: string): string {
  let out = fallback;
  try {
    const u = new URL(canonicalUrl);
    if (u.protocol === 'https:' || u.protocol === 'http:') out = `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    /* not a URL: the server name it claims */
  }
  out = out.replace(/\s+/g, ' ').trim() || 'unknown address';
  return out.length > MAX_ADDRESS ? `${out.slice(0, MAX_ADDRESS - 1)}…` : out;
}

const lower = (h: string) => h.toLowerCase();
const newer = (a: ListedCapture, b: ListedCapture): boolean =>
  a.signedAt !== b.signedAt ? a.signedAt > b.signedAt : BigInt(a.entityKey) > BigInt(b.entityKey);

/**
 * One entry per page (`urlHash`, any case). The newest record is the one with the latest signed
 * time (a tie goes to the larger record key); a page is a repo when any of its captures is named
 * by a git attachment.
 */
export function groupByPage(rows: readonly ListedCapture[], attachments: readonly ListedAttachment[]): PageEntry[] {
  const gitParents = new Set(attachments.filter((a) => a.kind === 'git').map((a) => lower(a.parentCaptureKey)));
  const pages = new Map<string, { rows: ListedCapture[]; newest: ListedCapture; repo: boolean }>();
  for (const r of rows) {
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
  return [...pages.values()].map((p) => ({
    urlHash: lower(p.newest.urlHash) as Hex,
    address: hostPath(p.newest.canonicalUrl, p.newest.serverName),
    kind: p.repo ? 'repo' : 'page',
    versions: p.rows.length,
    newest: p.newest,
    signedAt: p.newest.signedAt,
  }));
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
