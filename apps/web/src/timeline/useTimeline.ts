import { DEFAULT_MAX_DOWNLOAD_BYTES, arkivPublic, listByUrl, type CaptureRow, type Listed, type NetConfig } from '@recall/net';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Hex } from 'viem';
import { downloadEvidence } from '../download';
import { errorText } from '../errors';
import { checkBatch, listOptions } from '../limits';
import { getNetConfig } from '../net';
import { verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { trustedWitnesses } from '../witness';
import { COULDNT_DOWNLOAD, classify, type Checked } from './model';

export type TimelineData = {
  phase: 'loading' | 'error' | 'ready';
  /** Why the records could not be read (phase 'error'). */
  error?: string;
  rows: Listed[];
  truncated: boolean;
  /**
   * Results by record key. This map is updated in place as checks finish; `version` changes
   * whenever it (or `notStarted`) did, so use it as a dependency.
   */
  checked: ReadonlyMap<Hex, Checked>;
  /** Records whose check has not been started (the automatic budget ran out). */
  notStarted: ReadonlySet<Hex>;
  version: number;
  /** How many records one "check more" click adds. */
  batch: number;
  checkMore: () => void;
  retry: () => void;
};

/** Records checked at the same time, so a long list does not open hundreds of downloads at once. */
const CONCURRENCY = 6;
/** One record's evidence gets this long to arrive before it counts as unavailable. */
const DOWNLOAD_MS = 30_000;
/** Results reach the screen in groups at most this often, however many records finish. */
const FLUSH_MS = 80;

const EMPTY_MAP: ReadonlyMap<Hex, Checked> = new Map();
const EMPTY_SET: ReadonlySet<Hex> = new Set();
const NO_ROWS: Listed[] = [];
const unverified = (reason: string): Checked => ({ state: 'unverified', reason, status: 'unavailable' });

/**
 * Downloads (captures) or reads inline (confirmations) a record's evidence, and checks it.
 * Each download has its own abort controller, aborted on the timeout and when the page leaves
 * (`controllers`), and an aborted or failed download is "couldn't be downloaded".
 */
async function checkRow(cfg: NetConfig, row: Listed, urlHash: Hex, controllers: Set<AbortController>): Promise<Checked> {
  if (row.kind === 'capture') {
    const ac = new AbortController();
    controllers.add(ac);
    try {
      return await checkCaptureRow(cfg, row, ac.signal, urlHash);
    } finally {
      controllers.delete(ac);
    }
  }
  const bytes = row.evidence;
  if (bytes.length > DEFAULT_MAX_DOWNLOAD_BYTES) return { state: 'unverified', reason: 'Evidence file is too large', status: 'fail' };
  // Checks A to C and the record cross-check (R13). Nothing the index says is trusted.
  return classify(await verifyRecordEvidence(row, bytes), urlHash);
}

/**
 * One capture record's check, as the timeline does it: download its evidence (aborted by
 * `signal` or after 30 s; a failed download is "couldn't be downloaded"), run checks A to C and
 * the record cross-check (R13), and require the evidence to be about `urlHash` (the record's own
 * by default). Used by the timeline and the library.
 */
export async function checkCaptureRow(
  cfg: NetConfig,
  row: CaptureRow,
  signal?: AbortSignal,
  urlHash: Hex = row.urlHash,
): Promise<Checked> {
  let bytes: Uint8Array;
  const ac = new AbortController();
  const stop = () => ac.abort();
  if (signal?.aborted) ac.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, DOWNLOAD_MS);
  try {
    bytes = (await downloadEvidence(cfg, row, { signal: ac.signal })).bytes;
  } catch {
    return unverified(COULDNT_DOWNLOAD);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
  // Checks A to C and the record cross-check (R13). Nothing the index says is trusted.
  return classify(await verifyRecordEvidence(row, bytes), urlHash);
}

/**
 * The order records are checked in. The index is only used to choose an order, never as proof:
 * a spammer can claim anything, so claiming the pinned witness earns no protection. Newest
 * claimed time first just puts the likeliest-wanted records in the first batch.
 */
function checkOrder(rows: Listed[]): Listed[] {
  const pinned = new Set(trustedWitnesses().map((w) => w.address.toLowerCase()));
  const rank = (r: Listed) => (pinned.has(r.witness.toLowerCase()) ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.signedAt === b.signedAt ? 0 : a.signedAt < b.signedAt ? 1 : -1));
}

/**
 * Lists the records of one address from Arkiv (R10: `truncated` says the row budget was hit),
 * then checks them in the browser: the first `batch` automatically, `batch` more on each
 * `checkMore()`. Records that were not started stay "not checked", never verified. Results are
 * collected in a map and handed to the screen in groups, so many results are not many renders.
 * Leaving the page (or the address) aborts every download in flight.
 */
export function useTimeline(urlHash: Hex): TimelineData {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const [version, setVersion] = useState(0);
  const [list, setList] = useState<
    { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; rows: Listed[]; truncated: boolean }
  >({ phase: 'loading' });
  const results = useRef<Map<Hex, Checked>>(new Map());
  const started = useRef<Set<Hex>>(new Set());
  const more = useRef<() => void>(() => undefined);
  const batch = useMemo(checkBatch, []);

  useEffect(() => {
    let alive = true;
    const controllers = new Set<AbortController>();
    const done = new Map<Hex, Checked>();
    const begun = new Set<Hex>();
    results.current = done;
    started.current = begun;
    more.current = () => undefined;
    setList({ phase: 'loading' });
    setVersion((v) => v + 1);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (alive) setVersion((v) => v + 1);
      }, FLUSH_MS);
    };

    (async () => {
      const cfg = getNetConfig();
      let result;
      try {
        result = await listByUrl(arkivPublic(cfg), urlHash, listOptions());
      } catch (e) {
        if (alive) setList({ phase: 'error', error: errorText(e) });
        return;
      }
      if (!alive) return;
      const queue = checkOrder(result.rows);
      let budget = batch;
      let active = 0;
      const pump = () => {
        while (alive && active < CONCURRENCY && budget > 0 && queue.length > 0) {
          const row = queue.shift()!;
          budget--;
          active++;
          begun.add(row.entityKey);
          checkRow(cfg, row, urlHash, controllers)
            .catch(() => unverified("Couldn't be verified"))
            .then((outcome) => {
              if (alive) done.set(row.entityKey, outcome);
            })
            .finally(() => {
              active--;
              pump();
              flush();
            });
        }
      };
      more.current = () => {
        budget += batch;
        pump();
        flush();
      };
      setList({ phase: 'ready', rows: result.rows, truncated: result.truncated });
      pump();
      flush();
    })().catch((e) => {
      if (alive) setList({ phase: 'error', error: errorText(e) });
    });

    return () => {
      alive = false;
      clearTimeout(timer);
      controllers.forEach((c) => c.abort());
    };
  }, [urlHash, attempt, batch]);

  const rows = list.phase === 'ready' ? list.rows : NO_ROWS;
  // `version` is the signal that `results` and `started` changed.
  const notStarted = useMemo(() => {
    if (rows.length === 0) return EMPTY_SET;
    return new Set(rows.filter((r) => !started.current.has(r.entityKey)).map((r) => r.entityKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, version]);

  return {
    phase: list.phase,
    error: list.phase === 'error' ? list.error : undefined,
    rows,
    truncated: list.phase === 'ready' ? list.truncated : false,
    checked: list.phase === 'ready' ? results.current : EMPTY_MAP,
    notStarted,
    version,
    batch,
    checkMore: () => more.current(),
    retry,
  };
}
