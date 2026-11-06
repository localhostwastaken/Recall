import { arkivPublic, downloadBytes, listByUrl, type Listed, type NetConfig } from '@recall/net';
import { useCallback, useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { listOptions } from '../limits';
import { getNetConfig } from '../net';
import { verifyRecordEvidence } from '../verify/useVerifiedCapture';
import { trustedWitnesses } from '../witness';
import { COULDNT_DOWNLOAD, classify, type Checked } from './model';

export type TimelineData =
  | { phase: 'loading'; rows: []; truncated: false; checked: ReadonlyMap<Hex, Checked>; retry: () => void }
  | { phase: 'error'; error: string; rows: []; truncated: false; checked: ReadonlyMap<Hex, Checked>; retry: () => void }
  | { phase: 'ready'; rows: Listed[]; truncated: boolean; checked: ReadonlyMap<Hex, Checked>; retry: () => void };

/** Records checked at the same time, so a long list does not open hundreds of downloads at once. */
const CONCURRENCY = 6;
/** One record's evidence gets this long to arrive before it counts as unavailable. */
const DOWNLOAD_MS = 30_000;

const EMPTY: ReadonlyMap<Hex, Checked> = new Map();

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Downloads (captures) or reads inline (confirmations) a record's evidence, and checks it. */
async function checkRow(cfg: NetConfig, row: Listed, urlHash: Hex): Promise<Checked> {
  let bytes: Uint8Array;
  try {
    bytes = row.kind === 'capture' ? (await withTimeout(downloadBytes(row.evidenceRef, cfg.swarm.downloadUrls), DOWNLOAD_MS)).bytes : row.evidence;
  } catch {
    return { state: 'unverified', reason: COULDNT_DOWNLOAD, status: 'unavailable' };
  }
  // Checks A to C and the record cross-check (R13). Nothing the index says is trusted.
  return classify(await verifyRecordEvidence(row, bytes), urlHash);
}

/** Records that claim a pinned witness go first: the index is only used to choose an order. */
function checkOrder(rows: Listed[]): Listed[] {
  const pinned = new Set(trustedWitnesses().map((w) => w.address.toLowerCase()));
  const rank = (r: Listed) => (pinned.has(r.witness.toLowerCase()) ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.signedAt === b.signedAt ? 0 : a.signedAt < b.signedAt ? 1 : -1));
}

/**
 * Lists the records of one address from Arkiv (R10: `truncated` says the row budget was hit),
 * then checks each one in the browser as it goes. A result arrives per record, so a list shows
 * "Checking…" items that settle one by one.
 */
export function useTimeline(urlHash: Hex): TimelineData {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const [list, setList] = useState<
    { phase: 'loading' } | { phase: 'error'; error: string } | { phase: 'ready'; rows: Listed[]; truncated: boolean }
  >({ phase: 'loading' });
  const [checked, setChecked] = useState<ReadonlyMap<Hex, Checked>>(EMPTY);

  useEffect(() => {
    let alive = true;
    setList({ phase: 'loading' });
    setChecked(EMPTY);
    (async () => {
      const cfg = getNetConfig();
      let result;
      try {
        result = await listByUrl(arkivPublic(cfg), urlHash, listOptions());
      } catch (e) {
        if (alive) setList({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!alive) return;
      setList({ phase: 'ready', rows: result.rows, truncated: result.truncated });
      const queue = checkOrder(result.rows);
      const worker = async () => {
        for (let row = queue.shift(); row && alive; row = queue.shift()) {
          let outcome: Checked;
          try {
            outcome = await checkRow(cfg, row, urlHash);
          } catch {
            outcome = { state: 'unverified', reason: "Couldn't be verified", status: 'unavailable' };
          }
          if (!alive) return;
          const key = row.entityKey;
          setChecked((prev) => new Map(prev).set(key, outcome));
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    })().catch((e) => {
      if (alive) setList({ phase: 'error', error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      alive = false;
    };
  }, [urlHash, attempt]);

  if (list.phase === 'ready') return { phase: 'ready', rows: list.rows, truncated: list.truncated, checked, retry };
  if (list.phase === 'error') return { phase: 'error', error: list.error, rows: [], truncated: false, checked: EMPTY, retry };
  return { phase: 'loading', rows: [], truncated: false, checked: EMPTY, retry };
}
