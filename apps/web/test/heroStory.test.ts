// @vitest-environment jsdom
import { gsap } from 'gsap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followPointer, playHeroStory, splitWord } from '../src/landing/heroStory';

const NS = 'http://www.w3.org/2000/svg';

function hero(split = false): HTMLElement {
  const root = document.createElement('section');
  const word = split ? [...'forgets'].map((c) => `<span class="ch" aria-hidden="true">${c}</span>`).join('') : 'forgets';
  root.innerHTML = `
    <h1 aria-label="The web forgets. Recall doesn't.">The web <span class="hero-forgets">${word}</span>.</h1>
    <ol>${['Captured', 'Witness signed', 'Stored on Swarm', 'Indexed on Arkiv']
      .map((s) => `<li class="hero-step is-on"><span class="hero-fill"></span>${s}</li>`)
      .join('')}</ol>
    <article class="hero-card"><span class="ccard-pill">Checking…</span><span class="ccard-bar-fill" style="width: 15%"></span></article>`;
  const svg = document.createElementNS(NS, 'svg');
  svg.innerHTML = `
    <g id="duo-owl"><g id="duo-owl-in"><circle class="duo-owl-pupil"/><circle class="duo-owl-pupil"/>
      <rect class="duo-owl-lid" height="0"/><rect class="duo-owl-lid" height="0"/></g><g id="duo-seal-arm"/></g>
    <g id="duo-trunk"><g id="duo-receipt-check" transform="translate(52 36)"/></g><g id="duo-ear"/><g id="duo-eye"/>
    ${Array.from({ length: 6 }, () => '<g><path class="duo-cloth-hex"/></g>').join('')}`;
  root.append(svg);
  document.body.append(root);
  return root;
}

const tweens = () => gsap.globalTimeline.getChildren(true, true, true).length;

beforeEach(() => {
  gsap.globalTimeline.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  gsap.globalTimeline.clear();
});

describe('hero story', () => {
  it('under reduced motion shows the final frame at once and starts nothing', () => {
    const root = hero();
    const story = playHeroStory(root, { reducedMotion: true });
    for (const hex of root.querySelectorAll('.duo-cloth-hex')) {
      expect(gsap.getProperty(hex, 'scale')).toBe(1);
      expect(gsap.getProperty(hex, 'opacity')).toBe(1);
    }
    for (const ch of root.querySelectorAll<HTMLElement>('.hero-forgets .ch')) expect(ch.style.transform).toBe('');
    expect(root.querySelectorAll('.hero-step.is-on')).toHaveLength(4);
    // The SVG parts keep their own placement.
    expect(root.querySelector('#duo-receipt-check')!.getAttribute('transform')).toBe('translate(52 36)');
    expect(story.playing()).toBe(false);
    expect(tweens()).toBe(0);
  });

  it('plays one timeline that kill() stops and reverts', () => {
    const root = hero();
    const story = playHeroStory(root, { reducedMotion: false });
    expect(tweens()).toBeGreaterThan(0);
    expect(gsap.getProperty(root.querySelector('.hero-card')!, 'opacity')).toBe(0);
    story.kill();
    expect(tweens()).toBe(0);
    expect(gsap.globalTimeline.getChildren().length).toBe(0);
    // Back as rendered: the card visible, the bar keeps its width, every rail step on.
    const card = root.querySelector<HTMLElement>('.hero-card')!;
    expect(card.style.visibility).toBe('');
    expect(card.style.opacity).toBe('');
    expect(root.querySelector<HTMLElement>('.ccard-bar-fill')!.style.width).toBe('15%');
    expect(root.querySelectorAll('.hero-step.is-on')).toHaveLength(4);
  });

  it('ends on the final frame and never repeats the story', () => {
    const root = hero();
    const story = playHeroStory(root, { reducedMotion: false });
    gsap.globalTimeline.getChildren(false, false, true)[0]!.progress(1);
    expect(story.playing()).toBe(false);
    for (const hex of root.querySelectorAll('.duo-cloth-hex')) expect(gsap.getProperty(hex, 'scale')).toBe(1);
    for (const ch of root.querySelectorAll('.hero-forgets .ch')) {
      expect(gsap.getProperty(ch, 'y')).toBe(0);
      expect(gsap.getProperty(ch, 'rotation')).toBe(0);
    }
    expect(gsap.getProperty(root.querySelector('.hero-card')!, 'opacity')).toBe(1);
    expect(root.querySelectorAll('.hero-step.is-on')).toHaveLength(4);
    story.kill();
  });

  it('splits "forgets" into aria-hidden letters once, keeping the heading label', () => {
    const root = hero();
    playHeroStory(root, { reducedMotion: true });
    playHeroStory(root, { reducedMotion: true });
    const letters = root.querySelectorAll('.hero-forgets .ch');
    expect(letters).toHaveLength(7);
    expect([...letters].every((l) => l.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(root.querySelector('.hero-forgets')!.textContent).toBe('forgets');
    expect(root.querySelector('h1')!.getAttribute('aria-label')).toBe("The web forgets. Recall doesn't.");
    // Already split (as React renders it): left alone.
    const pre = hero(true);
    expect(splitWord(pre)).toHaveLength(7);
    expect(pre.querySelectorAll('.hero-forgets .ch')).toHaveLength(7);
  });

  it('follows the pointer only with a fine pointer and without reduced motion', () => {
    const root = hero();
    const add = vi.spyOn(window, 'addEventListener');
    const media = (fine: boolean, reduce: boolean) =>
      vi.fn((q: string) => ({ matches: q.includes('pointer') ? fine : reduce }) as MediaQueryList);
    window.matchMedia = media(false, false);
    followPointer(root)();
    window.matchMedia = media(true, true);
    followPointer(root)();
    expect(add).not.toHaveBeenCalledWith('pointermove', expect.anything(), expect.anything());
    window.matchMedia = media(true, false);
    const stop = followPointer(root);
    expect(add).toHaveBeenCalledWith('pointermove', expect.any(Function), { passive: true });
    stop();
    add.mockRestore();
  });
});
