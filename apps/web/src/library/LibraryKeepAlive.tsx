import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Hex } from 'viem';
import { KeepAlive } from '../components/KeepAlive';
import type { PageEntry } from './model';
import type { LibraryData } from './useLibrary';
import { barPercent, celebrateCard, flipRerank, prefersReducedMotion, type Stop } from './rerank';
import './keepAlive.css';

export const KEEP_ALIVE_HINT = 'Available after this capture is checked';

/** On a card the action is just two words: no hourglass, and no "…" (the card is already calm). */
const CARD_TRIGGER = { label: 'Keep alive', icon: false } as const;

/**
 * The card's one action (spec 6.3, 12.2, 12.3). On a verified card it is the keep-alive flow for the
 * page's newest capture only (its Arkiv record and its one Swarm batch: the record the ranking
 * uses). Until this browser has verified that capture, it is a disabled "Keep alive" that says why.
 */
export function LibraryKeepAlive({
  entry,
  verified,
  onExtended,
}: {
  entry: PageEntry;
  verified: boolean;
  onExtended: (urlHash: Hex) => Promise<void>;
}) {
  const hintId = useId();
  const target = useMemo(
    () => ({ entityKeys: [entry.newest.entityKey], batchId: entry.newest.batchId }),
    [entry.newest.entityKey, entry.newest.batchId],
  );
  if (!verified) {
    return (
      <div className="lib-ka" title={KEEP_ALIVE_HINT}>
        <button type="button" className="btn-card" disabled aria-describedby={hintId}>
          {CARD_TRIGGER.label}
        </button>
        <span id={hintId} className="visually-hidden">
          {KEEP_ALIVE_HINT}
        </span>
      </div>
    );
  }
  return (
    <div className="lib-ka" data-ka-for={entry.urlHash}>
      <KeepAlive target={target} trigger={CARD_TRIGGER} onChanged={() => onExtended(entry.urlHash)} />
    </div>
  );
}

type Days = ReadonlyMap<Hex, number | null>;

const whole = (d: number | null | undefined): number | null =>
  d === null || d === undefined || !Number.isFinite(d) ? null : Math.max(0, Math.floor(d));

/** The keep-alive slot of the card for `urlHash` (attribute compared as text: no selector is built from row data). */
function slotFor(urlHash: Hex): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.lib-ka[data-ka-for]')) {
    if (el.dataset.kaFor === urlHash) return el;
  }
  return null;
}

/**
 * Runs `fn` once no dialog is open inside `root` (on the next tick, if none is). A card must not
 * move while any card's modal is open: moving its node would drop the dialog from the top layer.
 * Returns a stop that forgets the wait.
 */
function whenNoDialogOpen(root: HTMLElement, fn: () => void): Stop {
  let timer = 0;
  let over = false;
  // `close` does not bubble, but a capturing listener on an ancestor still sees it.
  const onClose = () => schedule();
  const check = () => {
    if (over) return;
    if (root.isConnected && root.querySelector('dialog[open]')) {
      root.addEventListener('close', onClose, true);
      return;
    }
    over = true;
    root.removeEventListener('close', onClose, true);
    fn();
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(check, 0);
  };
  schedule();
  return () => {
    over = true;
    window.clearTimeout(timer);
    root.removeEventListener('close', onClose, true);
  };
}

/**
 * The library's side of a keep-alive. While a card's days are being read again its old value is
 * held on screen (and in the ranking); once the new value is in and the dialog is closed, it is let
 * go inside `flushSync`, so Flip sees the old and the new order around one synchronous commit.
 * When the days grew, the card counts up, its bar grows and it glows; otherwise nothing moves.
 *
 * Pass `days` and `refreshDays` from `useLibrary()`; render and sort with the returned `days`.
 */
export function useKeepAliveRerank(
  live: Days,
  refreshDays: (urlHash: Hex) => Promise<void>,
): { days: Days; onExtended: (urlHash: Hex) => Promise<void> } {
  const [held, setHeld] = useState<Days>(() => new Map());
  const [settled, setSettled] = useState(0);

  const days = useMemo<Days>(() => {
    if (held.size === 0) return live;
    const merged = new Map(live);
    for (const [k, v] of held) merged.set(k, v);
    return merged;
  }, [live, held]);

  const shownRef = useRef(days);
  const heldRef = useRef(held);
  useLayoutEffect(() => {
    shownRef.current = days;
    heldRef.current = held;
  });
  /** Reads in flight per page, and pages whose read has finished and await a decision. */
  const inFlight = useRef(new Map<Hex, number>());
  const done = useRef(new Set<Hex>());
  const mounted = useRef(true);
  /** Waits, moves, count-ups and glows under way: ended when the page goes away. */
  const running = useRef(new Set<Stop>());
  useEffect(() => {
    mounted.current = true;
    const stops = running.current;
    return () => {
      mounted.current = false;
      for (const stop of [...stops]) stop();
      stops.clear();
    };
  }, []);
  const track = useCallback((stop: Stop) => {
    running.current.add(stop);
  }, []);

  const letGo = useCallback((urlHash: Hex) => {
    setHeld((m) => {
      if (!m.has(urlHash)) return m;
      const next = new Map(m);
      next.delete(urlHash);
      return next;
    });
  }, []);

  const onExtended = useCallback(
    async (urlHash: Hex) => {
      inFlight.current.set(urlHash, (inFlight.current.get(urlHash) ?? 0) + 1);
      if (!heldRef.current.has(urlHash)) {
        const shown = shownRef.current.get(urlHash) ?? null;
        heldRef.current = new Map(heldRef.current).set(urlHash, shown);
        setHeld((m) => (m.has(urlHash) ? m : new Map(m).set(urlHash, shown)));
      }
      try {
        await refreshDays(urlHash);
      } catch {
        // The record could not be read again: the card keeps the days it showed.
      } finally {
        const n = (inFlight.current.get(urlHash) ?? 1) - 1;
        if (n > 0) inFlight.current.set(urlHash, n);
        else inFlight.current.delete(urlHash);
        done.current.add(urlHash);
        // Decided after the commit that carries the refreshed days (the effect below).
        if (mounted.current) setSettled((s) => s + 1);
      }
    },
    [refreshDays],
  );

  useEffect(() => {
    for (const urlHash of [...done.current]) {
      if (inFlight.current.has(urlHash)) continue;
      done.current.delete(urlHash);
      if (!held.has(urlHash)) continue;
      const from = whole(held.get(urlHash));
      const to = whole(live.get(urlHash));
      if (from === null || to === null || to <= from) {
        // Cancelled, failed or no longer: nothing moves.
        letGo(urlHash);
        continue;
      }
      const slot = slotFor(urlHash);
      if (!slot) {
        // The card is not on screen (filtered out): just show the new days.
        letGo(urlHash);
        continue;
      }
      const play = () => {
        if (!mounted.current || !heldRef.current.has(urlHash)) return;
        const current = slotFor(urlHash);
        const grid = current?.closest<HTMLElement>('[data-library-grid]') ?? null;
        const card = current?.closest<HTMLElement>('.ccard') ?? null;
        const mutate = () => flushSync(() => letGo(urlHash));
        if (!grid) {
          mutate();
          return;
        }
        const reducedMotion = prefersReducedMotion();
        const fromBar = barPercent(card);
        track(flipRerank(grid, mutate, { reducedMotion }));
        if (!reducedMotion && card) track(celebrateCard(card, from, to, fromBar));
      };
      track(whenNoDialogOpen(slot.closest<HTMLElement>('[data-library-grid]') ?? slot, play));
    }
  }, [settled, live, held, letGo, track]);

  return { days, onExtended };
}

/**
 * The library data a page renders with when its cards offer keep-alive: `days` holds a card's old
 * value until its keep-alive is played, and `refreshDays` re-reads the days and then plays it.
 */
export function useKeepAliveLibrary(lib: LibraryData): LibraryData {
  const { days, onExtended } = useKeepAliveRerank(lib.days, lib.refreshDays);
  return { ...lib, days, refreshDays: onExtended };
}
