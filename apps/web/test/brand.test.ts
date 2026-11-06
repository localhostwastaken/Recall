// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Duo } from '../src/brand/Duo';
import { Logo, Wordmark } from '../src/brand/Logo';

function render(el: ReturnType<typeof createElement>): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(el);
  return host;
}

describe('Logo', () => {
  it('is decorative by default', () => {
    const svg = render(createElement(Logo)).querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.querySelector('title')).toBeNull();
    expect(svg.getAttribute('width')).toBe('28');
  });

  it('is an image with a title when titled', () => {
    const svg = render(createElement(Logo, { size: 40, title: 'Recall' })).querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
    expect(svg.querySelector('title')?.textContent).toBe('Recall');
    expect(svg.getAttribute('width')).toBe('40');
  });

  it('keeps the hexagon orange and the R ink in every theme', () => {
    const svg = render(createElement(Logo)).querySelector('svg')!;
    expect(svg.querySelector('path')?.getAttribute('fill')).toBe('#f47a20');
    expect(svg.innerHTML).toContain('#101411');
  });
});

describe('Wordmark', () => {
  it('shows the logo and the word Recall', () => {
    const host = render(createElement(Wordmark));
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('.wordmark-text')?.textContent).toBe('Recall');
  });
});

describe('Duo', () => {
  const host = render(createElement(Duo, { className: 'hero-duo' }));
  const svg = host.querySelector('svg')!;

  it('is one labelled image', () => {
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe(
      'A small owl riding an elephant. The owl stamps a seal; the elephant holds up a verified receipt.',
    );
    expect(svg.getAttribute('class')).toContain('hero-duo');
  });

  it('exposes the animation hooks', () => {
    expect(svg.querySelectorAll('.duo-owl-pupil')).toHaveLength(2);
    expect(svg.querySelectorAll('.duo-owl-lid')).toHaveLength(2);
    expect(svg.querySelectorAll('.duo-cloth-hex').length).toBeGreaterThanOrEqual(20);
    for (const id of ['duo-receipt-check', 'duo-seal-arm', 'duo-trunk', 'duo-ear', 'duo-eye', 'duo-tail', 'duo-owl']) {
      expect(svg.querySelectorAll(`#${id}`), id).toHaveLength(1);
    }
  });

  it('starts with the owl eyes open', () => {
    for (const lid of svg.querySelectorAll('.duo-owl-lid')) expect(lid.getAttribute('height')).toBe('0');
  });

  it('clips the cloth hexes with a per-instance clip path', () => {
    const clip = svg.querySelector('clipPath')!;
    expect(clip.id).not.toBe('');
    expect(svg.innerHTML).toContain(`url(#${clip.id})`);
  });
});
