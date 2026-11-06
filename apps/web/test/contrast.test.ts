import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// WCAG contrast of the shared design tokens, in both themes, plus the guarantee that the web app
// and the extension use the very same token file.

const WEB = fileURLToPath(new URL('../src/ui/tokens.css', import.meta.url));
const EXT = fileURLToPath(new URL('../../../extension/packages/extension/src/recall/ui/tokens.css', import.meta.url));
const css = readFileSync(WEB, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule that starts at `selector` (these rules have no nested braces). */
function declarations(selector: string): Map<string, string> {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out = new Map<string, string>();
  for (const part of css.slice(open + 1, close).split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const LIGHT = declarations(':root,\n[data-theme=light]');
const DARK = declarations('[data-theme=dark] {');
const DARK_SYSTEM = declarations(':root:not([data-theme=light]) {');
const THEMES = { light: LIGHT, dark: DARK } as const;

/** A token's colour as [r, g, b], following var(--other) references within the same theme. */
function rgb(theme: Map<string, string>, token: string): [number, number, number] {
  let v = theme.get(`--${token}`);
  for (let i = 0; v && i < 8; i++) {
    const ref = /^var\(--([\w-]+)\)$/.exec(v);
    if (!ref) break;
    v = theme.get(`--${ref[1]}`);
  }
  const hex = v && /^#([0-9a-f]{6})$/i.exec(v);
  if (!hex) throw new Error(`--${token} is not a hex colour: ${v}`);
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(theme: Map<string, string>, fg: string, bg: string): number {
  const a = luminance(rgb(theme, fg));
  const b = luminance(rgb(theme, bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SURFACES = ['bg', 'surface', 'surface-sunken'];
const TEXTS = ['text', 'text-muted', 'accent-text', 'pass', 'warn', 'fail', 'life', 'info'];
const STATUS_PAIRS: [string, string][] = [
  ['pass', 'pass-bg'],
  ['warn', 'warn-bg'],
  ['fail', 'fail-bg'],
  ['life', 'life-bg'],
  ['info', 'info-bg'],
  ['na', 'na-bg'],
  ['accent-text', 'accent-soft'],
  ['text', 'accent-soft'],
];

describe.each(Object.entries(THEMES))('contrast, %s theme', (_name, theme) => {
  for (const fg of TEXTS) {
    for (const bg of SURFACES) {
      it(`--${fg} on --${bg} is at least 4.5:1`, () => {
        expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  for (const [fg, bg] of STATUS_PAIRS) {
    it(`--${fg} on --${bg} is at least 4.5:1`, () => {
      expect(ratio(theme, fg, bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('text and muted text also read on the alternating section and the well', () => {
    for (const bg of ['bg-alt', 'surface-2']) {
      expect(ratio(theme, 'text', bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme, 'text-muted', bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('--border-strong on --surface and --bg is at least 3:1 (inputs, outline buttons)', () => {
    expect(ratio(theme, 'border-strong', 'surface')).toBeGreaterThanOrEqual(3);
    expect(ratio(theme, 'border-strong', 'bg')).toBeGreaterThanOrEqual(3);
  });

  it('--on-accent on --accent is at least 4.5:1', () => {
    expect(ratio(theme, 'on-accent', 'accent')).toBeGreaterThanOrEqual(4.5);
  });

  it('--on-danger on --danger is at least 4.5:1', () => {
    expect(ratio(theme, 'on-danger', 'danger')).toBeGreaterThanOrEqual(4.5);
  });

  it('--focus is visible (3:1) on the page, cards and wells', () => {
    for (const bg of SURFACES) expect(ratio(theme, 'focus', bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('token files', () => {
  it('the web and extension token files are byte-identical', () => {
    expect(readFileSync(EXT).equals(readFileSync(WEB))).toBe(true);
  });

  it('the two copies of the dark theme (attribute and system setting) are the same', () => {
    expect([...DARK_SYSTEM].sort()).toEqual([...DARK].sort());
  });

  it('light and dark define the same token names', () => {
    expect([...LIGHT.keys()].sort()).toEqual([...DARK.keys()].sort());
  });

  it('each theme sets its own color-scheme', () => {
    expect(css).toMatch(/\[data-theme=light\][\s\S]*?color-scheme: light;/);
    expect(css).toMatch(/\[data-theme=dark\] \{[\s\S]*?color-scheme: dark;/);
    expect(css).not.toMatch(/:root \{[^}]*color-scheme/);
  });
});
