import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';

gsap.registerPlugin(Flip);

/** True when the person asked for less motion (or when it cannot be told: no matchMedia). */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Re-orders a grid with GSAP Flip: records where every card is, runs `mutate`, then animates each
 * card from its old place to its new one (0.8 s, power3.inOut).
 *
 * `mutate` must change the DOM before it returns. With React that means the state change is made
 * inside `flushSync` (react-dom), which renders and commits it synchronously; keyed cards keep
 * their DOM nodes, so Flip matches each card by identity. Under reduced motion it only mutates.
 *
 * `absolute` takes every card out of the flow while it moves, so the grid keeps its height until
 * the move ends (otherwise what follows the grid would jump up for 0.8 s).
 */
export function flipRerank(grid: HTMLElement, mutate: () => void, opts: { reducedMotion: boolean }): void {
  if (opts.reducedMotion) {
    mutate();
    return;
  }
  const state = Flip.getState(Array.from(grid.children));
  mutate();
  const height = grid.getBoundingClientRect().height;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    unlockHeight(grid);
  };
  Flip.from(state, { duration: 0.8, ease: 'power3.inOut', absolute: true, onComplete: release, onInterrupt: release });
  if (!released) lockHeight(grid, height);
}

/** Grids held at a height while cards move, with their own min-height and the moves under way. */
const heldGrids = new WeakMap<HTMLElement, { original: string; moves: number }>();

function lockHeight(grid: HTMLElement, height: number): void {
  const held = heldGrids.get(grid) ?? { original: grid.style.minHeight, moves: 0 };
  held.moves += 1;
  heldGrids.set(grid, held);
  grid.style.minHeight = `${height}px`;
}

function unlockHeight(grid: HTMLElement): void {
  const held = heldGrids.get(grid);
  if (!held) return;
  held.moves -= 1;
  if (held.moves > 0) return;
  grid.style.minHeight = held.original;
  heldGrids.delete(grid);
}

/** The fill width (in %) the card's life bar is drawn with, or null when there is none. */
export function barPercent(card: Element | null): number | null {
  const fill = card?.querySelector<HTMLElement>('.ccard-bar-fill');
  if (!fill) return null;
  const n = Number.parseFloat(fill.style.width);
  return Number.isFinite(n) ? n : null;
}

const GLOW_CLASS = 'lib-ka-glow';
const GLOW_MS = 600;

/**
 * What answers a keep-alive on a card once its new days are on screen: the day number counts up
 * from `from` to `to`, the life bar grows from its old width (`fromBar`, in %), and a brief blue ring
 * (`--life`) marks the card. Transform and text only; nothing here changes the layout.
 */
export function celebrateCard(card: HTMLElement, from: number, to: number, fromBar: number | null): void {
  const num = card.querySelector<HTMLElement>('.ccard-days');
  const text = num?.firstChild;
  if (num && text && text.nodeType === Node.TEXT_NODE) {
    const counter = { v: from };
    text.nodeValue = String(from);
    gsap.to(counter, {
      v: to,
      duration: 0.9,
      ease: 'power2.out',
      onUpdate: () => {
        // React owns this text: if it has rendered another value meanwhile, stop and keep React's.
        if (num.dataset.days !== String(to)) return;
        text.nodeValue = String(Math.round(counter.v));
      },
      onComplete: () => {
        text.nodeValue = num.dataset.days ?? String(to);
      },
    });
  }

  const fill = card.querySelector<HTMLElement>('.ccard-bar-fill');
  const toBar = barPercent(card);
  if (fill && fromBar !== null && toBar !== null && toBar > 0 && fromBar < toBar) {
    gsap.fromTo(
      fill,
      { scaleX: Math.max(0, fromBar / toBar) },
      { scaleX: 1, duration: 0.9, ease: 'power2.out', clearProps: 'transform' },
    );
  }

  card.classList.remove(GLOW_CLASS);
  // Restart the ring if it is still showing from an earlier keep-alive.
  void card.offsetWidth;
  card.classList.add(GLOW_CLASS);
  window.setTimeout(() => card.classList.remove(GLOW_CLASS), GLOW_MS);
}
