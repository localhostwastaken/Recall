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
import { daysLeft, groupByPage, type PageEntry } from './model';
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
  /** urlHash -> the record key whose check was started. */
  const started = new Map<Hex, Hex>();
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
      set({ ...EMPTY });
    }
    withTimeout(deps.load(), LOAD_MS)
      .then(({ captures, attachments, truncated, timing }) => {
        if (gen !== generation) return;
        loadedAt = Date.now();
        const entries = groupByPage(captures, attachments);
        const days = new Map<Hex, number | null>();
        for (const e of entries) days.set(e.urlHash, timing ? daysLeft(e.newest.expiresAtBlock, timing.currentBlock, timing.blockSeconds) : null);
        // A page whose newest record changed must be checked again; the others keep their result.
        const check = new Map<Hex, CheckState>();
        const titles = new Map<Hex, string>();
        for (const e of entries) {
          if (started.get(e.urlHash) !== e.newest.entityKey) {
            started.delete(e.urlHash);
            continue;
          }
          const c = state.check.get(e.urlHash);
          const t = state.titles.get(e.urlHash);
          if (c) check.set(e.urlHash, c);
          if (t) titles.set(e.urlHash, t);
          const repo = state.entries.find((x) => x.urlHash === e.urlHash)?.repo;
          if (repo) e.repo = repo;
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
    if (!entry || started.get(urlHash) === entry.newest.entityKey) return;
    const key = entry.newest.entityKey;
    started.set(urlHash, key);
    set({ check: update(state.check, urlHash, 'checking') });
    const signal = ac.signal;
    queue
      .run(() => deps.check(entry.newest, signal))
      .then((result) => {
        if (started.get(urlHash) !== key || signal.aborted) return;
        if (result.state !== 'verified') {
          set({ check: update(state.check, urlHash, 'unverified') });
          return;
        }
        let title: string | null = null;
        if (entry.kind === 'repo') {
          const b = repoOf(result.facts);
          if (b) {
            title = `${b.owner}/${b.repo}`;
            state = { ...state, entries: state.entries.map((e) => (e.urlHash === urlHash ? { ...e, repo: title! } : e)) };
          }
        }
        title ??= pageTitle(result.facts.body, result.facts.contentType);
        set({ check: update(state.check, urlHash, 'verified'), titles: title ? update(state.titles, urlHash, title) : state.titles });
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
