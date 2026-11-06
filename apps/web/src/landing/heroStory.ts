import { gsap } from 'gsap';

// The landing hero's one orchestrated story (spec 4.5, 6.2.1), played once on load, about 4 s:
// the letters of "forgets" scatter like link rot; the rail fills step by step while the owl stamps
// its seal (the receipt's check pops), the saddle-cloth hexagons pop in from the centre, the trunk
// lifts and the capture card springs in; then "forgets" reassembles. Afterwards only a blink and
// an ear flap, at least 3 s apart. Transform and opacity only. Under reduced motion every element
// is in its final state at once and nothing moves.

export type HeroStory = {
  kill(): void;
  /** True while the story is still playing (a pill pop then waits for the story's own). */
  playing(): boolean;
};

const all = <T extends Element>(root: ParentNode, sel: string): T[] => [...root.querySelectorAll<T>(sel)];

/**
 * Splits the word in `.hero-forgets` into one span per letter, once. The spans are aria-hidden:
 * the heading's aria-label carries the words.
 */
export function splitWord(root: ParentNode): HTMLElement[] {
  const word = root.querySelector<HTMLElement>('.hero-forgets');
  if (!word) return [];
  const existing = all<HTMLElement>(word, '.ch');
  if (existing.length > 0) return existing;
  const text = word.textContent ?? '';
  word.textContent = '';
  for (const c of text) {
    const span = document.createElement('span');
    span.className = 'ch';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = c;
    word.append(span);
  }
  return all<HTMLElement>(word, '.ch');
}

type Parts = ReturnType<typeof parts>;

function parts(root: HTMLElement) {
  return {
    chars: splitWord(root),
    steps: all<HTMLElement>(root, '.hero-step'),
    fills: all<HTMLElement>(root, '.hero-fill'),
    arm: root.querySelector('#duo-seal-arm'),
    owl: root.querySelector('#duo-owl-in'),
    check: root.querySelector('#duo-receipt-check'),
    hexes: all<SVGElement>(root, '.duo-cloth-hex'),
    trunk: root.querySelector('#duo-trunk'),
    lids: all<SVGElement>(root, '.duo-owl-lid'),
    eye: root.querySelector('#duo-eye'),
    ear: root.querySelector('#duo-ear'),
    card: root.querySelector<HTMLElement>('.hero-card'),
    pill: root.querySelector<HTMLElement>('.hero-card .ccard-pill'),
    bar: root.querySelector<HTMLElement>('.hero-card .ccard-bar-fill'),
  };
}

/**
 * The final frame, which is the page as React rendered it: every rail step on and every hexagon
 * shown. Nothing else is touched (clearing an SVG transform would also drop its own placement).
 */
function finalState(p: Parts): void {
  p.steps.forEach((s) => s.classList.add('is-on'));
  if (p.hexes.length) gsap.set(p.hexes, { scale: 1, opacity: 1 });
}

/** The idle loop after the story: a blink, then 3+ s later an ear flap, then 3+ s of rest. */
function idle(p: Parts): gsap.core.Timeline | null {
  if (!p.lids.length && !p.eye && !p.ear) return null;
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 3.2, delay: 2 });
  if (p.lids.length) tl.to(p.lids, { attr: { height: 24 }, duration: 0.08 }, 0).to(p.lids, { attr: { height: 0 }, duration: 0.12 });
  if (p.eye) tl.to(p.eye, { scaleY: 0.12, transformOrigin: '50% 50%', duration: 0.08, yoyo: true, repeat: 1 }, 0);
  if (p.ear) tl.to(p.ear, { rotation: -9, svgOrigin: '140 100', duration: 0.55, yoyo: true, repeat: 1, ease: 'sine.inOut' }, 3.4);
  return tl;
}

/**
 * Plays the hero story once on `root` (the hero section). Returns a handle to stop it; `kill`
 * also puts every element back as React rendered it.
 */
export function playHeroStory(root: HTMLElement, opts: { reducedMotion: boolean }): HeroStory {
  const p = parts(root);
  if (opts.reducedMotion) {
    finalState(p);
    return { kill() {}, playing: () => false };
  }
  let tl: gsap.core.Timeline | null = null;
  // eslint-disable-next-line prefer-const
  let ctx: gsap.Context;
  ctx = gsap.context(() => {
    const on = (i: number) => () => p.steps[i]?.classList.add('is-on');
    tl = gsap.timeline({
      defaults: { ease: 'power3.out' },
      // The idle loop joins the same context, so kill() reverts it too.
      onComplete: () => {
        ctx.add(() => {
          idle(p);
        });
      },
    });
    // The start frame, applied now (before the first paint), so the final frame never flashes.
    p.steps.forEach((s) => s.classList.remove('is-on'));
    if (p.card) gsap.set(p.card, { autoAlpha: 0, y: 24 });
    if (p.pill) gsap.set(p.pill, { scale: 0 });
    if (p.bar) gsap.set(p.bar, { scaleX: 0, transformOrigin: 'left center' });
    if (p.fills.length) gsap.set(p.fills, { scaleX: 0, transformOrigin: 'left center' });
    if (p.hexes.length) gsap.set(p.hexes, { scale: 0, opacity: 0, transformOrigin: '50% 50%' });
    if (p.check) gsap.set(p.check, { scale: 0, transformOrigin: '50% 50%' });
    if (p.trunk) gsap.set(p.trunk, { rotation: -16, svgOrigin: '70 154' });
    if (p.arm) gsap.set(p.arm, { rotation: 0, svgOrigin: '28 -48' });

    // 1. Link rot: the letters of "forgets" drift apart and fade.
    if (p.chars.length) {
      tl.to(
        p.chars,
        {
          duration: 0.8,
          opacity: 0.25,
          y: () => gsap.utils.random(-14, 8),
          rotation: () => gsap.utils.random(-20, 20),
          stagger: { each: 0.05, from: 'random' },
          ease: 'power2.inOut',
        },
        0.3,
      );
    }
    // 2. Captured.
    if (p.fills[0]) tl.to(p.fills[0], { scaleX: 1, duration: 0.4 }, 0.8).add(on(0), '<');
    // 3. Witness signed: the owl raises its seal and stamps; the receipt's check pops.
    if (p.fills[1]) tl.to(p.fills[1], { scaleX: 1, duration: 0.4 }, 1.25).add(on(1), '<');
    if (p.arm) {
      tl.to(p.arm, { rotation: -24, duration: 0.3, ease: 'power2.out' }, 1.25)
        .to(p.arm, { rotation: 34, duration: 0.14, ease: 'power4.in' })
        .addLabel('stamp');
      if (p.owl) tl.to(p.owl, { y: 2, duration: 0.05, yoyo: true, repeat: 1 }, 'stamp');
      if (p.check) tl.to(p.check, { scale: 1, duration: 0.4, ease: 'back.out(3)' }, 'stamp');
      tl.to(p.arm, { rotation: 0, duration: 0.35, ease: 'power2.out' }, 'stamp');
    } else if (p.check) {
      tl.to(p.check, { scale: 1, duration: 0.4, ease: 'back.out(3)' }, 1.7);
    }
    // 4. Stored on Swarm: the saddle-cloth hexagons pop in from the centre.
    if (p.fills[2]) tl.to(p.fills[2], { scaleX: 1, duration: 0.4 }, 2.0).add(on(2), '<');
    if (p.hexes.length) {
      tl.to(p.hexes, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(2.5)', stagger: { each: 0.015, from: 'center' } }, 2.0);
    }
    // 5. Indexed on Arkiv: the trunk lifts the receipt and the card springs in.
    if (p.fills[3]) tl.to(p.fills[3], { scaleX: 1, duration: 0.4 }, 2.75).add(on(3), '<');
    if (p.trunk) tl.to(p.trunk, { rotation: 0, duration: 0.8, ease: 'elastic.out(1, 0.55)' }, 2.75);
    if (p.card) tl.to(p.card, { autoAlpha: 1, y: 0, duration: 0.6, ease: 'back.out(1.6)' }, 2.85);
    if (p.pill) tl.to(p.pill, { scale: 1, duration: 0.35, ease: 'back.out(3)' }, 3.2);
    if (p.bar) tl.to(p.bar, { scaleX: 1, duration: 0.8 }, 3.2);
    // 6. "forgets" comes back together: Recall doesn't forget.
    if (p.chars.length) {
      tl.to(p.chars, { opacity: 1, y: 0, rotation: 0, duration: 0.5, stagger: { each: 0.03, from: 'edges' }, ease: 'back.out(2)' }, 3.5);
    }
  }, root);
  return {
    kill() {
      ctx.revert();
      p.steps.forEach((s) => s.classList.add('is-on'));
    },
    playing: () => tl !== null && (tl as gsap.core.Timeline).isActive(),
  };
}

/** A small pop when the hero card's status changes after the story (the real verdict arrived). */
export function popPill(pill: Element): void {
  gsap.fromTo(pill, { scale: 0.6 }, { scale: 1, duration: 0.35, ease: 'back.out(3)', clearProps: 'transform' });
}

/**
 * The owl's pupils follow the pointer (at most 5 px). Only with a fine pointer and without
 * reduced motion. Returns the cleanup.
 */
export function followPointer(root: HTMLElement): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  if (!window.matchMedia('(pointer: fine)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return () => {};
  }
  const pupils = all<SVGElement>(root, '.duo-owl-pupil');
  const owl = root.querySelector('#duo-owl');
  if (pupils.length === 0 || !owl) return () => {};
  const xTo = pupils.map((el) => gsap.quickTo(el, 'x', { duration: 0.3, ease: 'power3' }));
  const yTo = pupils.map((el) => gsap.quickTo(el, 'y', { duration: 0.3, ease: 'power3' }));
  const move = (e: PointerEvent) => {
    const r = owl.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.3;
    const a = Math.atan2(e.clientY - cy, e.clientX - cx);
    const d = Math.min(5, Math.hypot(e.clientX - cx, e.clientY - cy) / 40);
    xTo.forEach((f) => f(Math.cos(a) * d));
    yTo.forEach((f) => f(Math.sin(a) * d));
  };
  window.addEventListener('pointermove', move, { passive: true });
  return () => {
    window.removeEventListener('pointermove', move);
    gsap.killTweensOf(pupils);
    gsap.set(pupils, { clearProps: 'transform' });
  };
}
