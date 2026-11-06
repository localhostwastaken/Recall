import {
  arkivPublic,
  listAllAttachments,
  listAllCaptures,
  readArkivExpiry,
  type ListedAttachment,
  type ListedCapture,
} from '@recall/net';
import { useSyncExternalStore } from 'react';
import type { Hex } from 'viem';
import { repoOf } from '../attachments/git';
import { errorText } from '../errors';
import { getNetConfig } from '../net';
import type { Checked } from '../timeline/model';
import { checkCaptureRow } from '../timeline/useTimeline';
import { daysLeft, groupByPage, hostPath, type PageEntry } from './model';
import { createVerifyQueue } from './queue';
import { pageTitle } from './title';

export type CheckState = 'checking' | 'verified' | 'unverified';

export type LibraryState = {
  status: 'loading' | 'ready' | 'error';
  /** Why Arkiv could not be read (status 'error'). */
  error?: string;
  entries: PageEntry[];
  /** Capture records listed (all versions of all pages). */
  captureCount: number;
  /** More rows existed than the row budget (1,000). */
  truncated: boolean;
  /** By page (`urlHash`): the check of its newest capture. Missing = not checked yet. */
  check: ReadonlyMap<Hex, CheckState>;
  /** By page: the title from the verified evidence (page `<title>` or owner/repo). */
  titles: ReadonlyMap<Hex, string>;
  /** By page: whole days the newest record stays on Arkiv; null when the chain time was unreadable. */
  days: ReadonlyMap<Hex, number | null>;
};

export type LibraryData = LibraryState & {
  /** Verify this page's newest capture (once; at most three run at a time). Cards call it when they scroll into view. */
  requestCheck(urlHash: Hex): void;
  retry(): void;
  /** Re-reads the newest record's expiry (after a keep-alive) and updates `days`. */
  refreshDays(urlHash: Hex): Promise<void>;
};

type Timing = { currentBlock: bigint; blockSeconds: number };

export type LibraryDeps = {
  load(): Promise<{ captures: ListedCapture[]; attachments: ListedAttachment[]; truncated: boolean; timing: Timing | null }>;
  check(row: ListedCapture, signal: AbortSignal): Promise<Checked>;
  readExpiry(entityKey: Hex): Promise<{ expiresAtBlock: bigint } & Timing>;
};

/**
 * Records of one page checked at most, newest first. Anyone can write a newer record with bad
 * evidence; trying the next ones keeps such a record from hiding a real page.
 */
const MAX_TRIES = 3;

/** Arkiv gets this long to list the library before the page says it could not be read. */
const LOAD_MS = 30_000;
/** A library read older than this is refreshed (quietly) when the library is opened again. */
const STALE_MS = 60_000;

const EMPTY: LibraryState = {
  status: 'loading',
  entries: [],
  captureCount: 0,
  truncated: false,
  check: new Map(),
  titles: new Map(),
  days: new Map(),
};

/**
 * Every field of the record that was checked. A result is reused only for the exact same row: a
 * reloaded row under the same key that says anything else is checked again.
 */
export const rowFingerprint = (r: ListedCapture): string =>
  [r.entityKey, r.urlHash, r.canonicalUrl, r.serverName, r.bodySha256, r.evidenceRef, r.witness, String(r.signedAt), r.batchId].join('|');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Arkiv did not answer in time.')), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

/**
 * The library's data, shared by every view of it (the landing preview and the library page),
 * so a capture verified in one is verified in the other. Arkiv rows are claims: a page shows
 * "Verified" only after this browser checked its newest capture (`requestCheck`).
 */
export function createLibraryStore(deps: LibraryDeps) {
  let state: LibraryState = EMPTY;
  let loadedAt = 0;
  let generation = 0;
  let ac = new AbortController();
  const queue = createVerifyQueue(3);
  /** urlHash -> the fingerprint of the row whose check was started. */
  const started = new Map<Hex, string>();
  /** urlHash -> what the verified evidence says (address, repo), shown instead of the row's claims. */
  const proven = new Map<Hex, { address: string; repo?: string }>();
  /** urlHash -> how many of its records failed their check in this read. */
  const tries = new Map<Hex, number>();
  let timing: Timing | null = null;
  const listeners = new Set<() => void>();

  const set = (patch: Partial<LibraryState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const update = <V>(m: ReadonlyMap<Hex, V>, k: Hex, v: V | undefined): Map<Hex, V> => {
    const next = new Map(m);
    if (v === undefined) next.delete(k);
    else next.set(k, v);
    return next;
  };

  const load = (quiet: boolean) => {
    const gen = ++generation;
    if (!quiet) {
      ac.abort();
      ac = new AbortController();
      queue.cancelAll();
      started.clear();
      proven.clear();
      tries.clear();
      set({ ...EMPTY });
    }
    withTimeout(deps.load(), LOAD_MS)
      .then(({ captures, attachments, truncated, timing: read }) => {
        if (gen !== generation) return;
        timing = read;
        loadedAt = Date.now();
        const entries = groupByPage(captures, attachments);
        const days = new Map<Hex, number | null>();
        for (const e of entries) days.set(e.urlHash, timing ? daysLeft(e.newest.expiresAtBlock, timing.currentBlock, timing.blockSeconds) : null);
        // A result carries over only to the exact row that was checked; anything else is checked again.
        const check = new Map<Hex, CheckState>();
        const titles = new Map<Hex, string>();
        for (const e of entries) {
          if (e.junk) {
            check.set(e.urlHash, 'unverified');
            continue;
          }
          if (started.get(e.urlHash) !== rowFingerprint(e.newest)) {
            started.delete(e.urlHash);
            proven.delete(e.urlHash);
            tries.delete(e.urlHash);
            continue;
          }
          const c = state.check.get(e.urlHash);
          const t = state.titles.get(e.urlHash);
          if (c) check.set(e.urlHash, c);
          if (t) titles.set(e.urlHash, t);
          const p = proven.get(e.urlHash);
          if (p) {
            e.address = p.address;
            if (p.repo) e.repo = p.repo;
          }
        }
        set({ status: 'ready', error: undefined, entries, captureCount: captures.length, truncated, check, titles, days });
      })
      .catch((e: unknown) => {
        if (gen !== generation) return;
        if (quiet && state.status === 'ready') return; // keep showing what was read
        set({ status: 'error', error: errorText(e) });
      });
  };

  const requestCheck = (urlHash: Hex) => {
    const entry = state.entries.find((e) => e.urlHash === urlHash);
    if (!entry || entry.junk) return;
    const key = rowFingerprint(entry.newest);
    if (started.get(urlHash) === key) return;
    started.set(urlHash, key);
    set({ check: update(state.check, urlHash, 'checking') });
    const signal = ac.signal;
    queue
      .run(() => deps.check(entry.newest, signal))
      .then((result) => {
        if (started.get(urlHash) !== key || signal.aborted) return;
        if (result.state !== 'verified') {
          const now = state.entries.find((e) => e.urlHash === urlHash);
          const next = now?.older?.[0];
          const n = (tries.get(urlHash) ?? 0) + 1;
          tries.set(urlHash, n);
          if (now && next && n < MAX_TRIES) {
            // Try the page's next newest record instead (the card stays "Checking…").
            started.delete(urlHash);
            const moved: PageEntry = { ...now, newest: next, older: now.older!.slice(1), signedAt: next.signedAt };
            state = {
              ...state,
              entries: state.entries.map((e) => (e.urlHash === urlHash ? moved : e)),
              days: update(state.days, urlHash, timing ? daysLeft(next.expiresAtBlock, timing.currentBlock, timing.blockSeconds) : null),
            };
            requestCheck(urlHash);
            return;
          }
          set({ check: update(state.check, urlHash, 'unverified') });
          return;
        }
        // From here on the card shows what the verified evidence says, never the row's claims.
        const facts = result.facts;
        const shown: { address: string; repo?: string } = { address: hostPath(facts.canonicalUrl, facts.serverName) };
        let title: string | null = null;
        if (entry.kind === 'repo') {
          const b = repoOf(facts);
          if (b) title = shown.repo = `${b.owner}/${b.repo}`;
        }
        title ??= pageTitle(facts.body, facts.contentType);
        proven.set(urlHash, shown);
        set({
          entries: state.entries.map((e) => (e.urlHash === urlHash ? { ...e, ...shown } : e)),
          check: update(state.check, urlHash, 'verified'),
          titles: title ? update(state.titles, urlHash, title) : state.titles,
        });
      })
      .catch((e: unknown) => {
        if (started.get(urlHash) !== key) return;
        if ((e as Error)?.name === 'AbortError' || signal.aborted) {
          // Dropped before it ran (the library was left): not checked, so it can be asked again.
          started.delete(urlHash);
          set({ check: update(state.check, urlHash, undefined) });
          return;
        }
        set({ check: update(state.check, urlHash, 'unverified') });
      });
  };

  const refreshDays = async (urlHash: Hex): Promise<void> => {
    const entry = state.entries.find((e) => e.urlHash === urlHash);
    if (!entry) return;
    const r = await deps.readExpiry(entry.newest.entityKey);
    set({
      entries: state.entries.map((e) =>
        e.urlHash === urlHash ? { ...e, newest: { ...e.newest, expiresAtBlock: r.expiresAtBlock } } : e,
      ),
      days: update(state.days, urlHash, daysLeft(r.expiresAtBlock, r.currentBlock, r.blockSeconds)),
    });
  };

  return {
    subscribe(listener: () => void): () => void {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) {
        if (generation === 0 || state.status === 'error') load(false);
        else if (state.status === 'ready' && Date.now() - loadedAt > STALE_MS) load(true);
      }
      return () => {
        listeners.delete(listener);
        // Nobody is looking: drop the checks still waiting (they are asked again when seen).
        if (listeners.size === 0) queue.cancelAll();
      };
    },
    getSnapshot: (): LibraryState => state,
    requestCheck,
    retry: () => load(false),
    refreshDays,
  };
}

export type LibraryStore = ReturnType<typeof createLibraryStore>;

function liveDeps(): LibraryDeps {
  return {
    async load() {
      const pub = arkivPublic(getNetConfig());
      const [captures, attachments, timing] = await Promise.all([
        listAllCaptures(pub),
        // Attachments only mark repos; without them every card is still shown (as a page).
        listAllAttachments(pub).catch(() => ({ rows: [] as ListedAttachment[], truncated: false })),
        pub
          .getBlockTiming()
          .then((t): Timing => ({ currentBlock: t.currentBlock, blockSeconds: t.blockDuration }))
          .catch(() => null),
      ]);
      return { captures: captures.rows, attachments: attachments.rows, truncated: captures.truncated, timing };
    },
    check: (row, signal) => checkCaptureRow(getNetConfig(), row, signal),
    async readExpiry(entityKey) {
      const [e] = await readArkivExpiry(arkivPublic(getNetConfig()), [entityKey]);
      if (!e) throw new Error('The record could not be read.');
      return { expiresAtBlock: e.expiresAtBlock, currentBlock: e.currentBlock, blockSeconds: e.blockSeconds };
    },
  };
}

let shared: LibraryStore | null = null;
/** The app's one library store (created on first use). */
export function libraryStore(): LibraryStore {
  shared ??= createLibraryStore(liveDeps());
  return shared;
}

export function useLibrary(store: LibraryStore = libraryStore()): LibraryData {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...state, requestCheck: store.requestCheck, retry: store.retry, refreshDays: store.refreshDays };
}
