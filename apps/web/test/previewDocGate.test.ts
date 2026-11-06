// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pins the wiring of the fail-closed gate. The sanitiser is replaced by a stub that returns
// whatever hostile markup the test wants, so only the final `safe(out)` check can stand between
// that markup and the frame. If the pipeline returned `out` without the gate, these go red.
const sanitize = vi.hoisted(() => vi.fn<(source: string, config?: unknown) => string>());
vi.mock('dompurify', () => ({ default: { sanitize } }));

import { previewDocument } from '../src/components/previewDoc';

const UNAVAILABLE = 'This page could not be shown safely.';
const page = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const HOSTILE: Record<string, string> = {
  'a closed declarative shadow root holding a link': page(
    '<div><template shadowrootmode="closed"><a target="_self" href="http://x.test/shadow">hidden</a></template></div>',
  ),
  'a link with href': page('<a href="http://x.test/a" target="_self">go</a>'),
  'an extra meta http-equiv': page('<p>hi</p>', '<meta http-equiv="refresh" content="0;url=http://x.test/away">'),
  'a form': page('<form action="http://x.test/f"><input name="q"></form>'),
  'an svg': page('<svg width="10" height="10"><circle r="5"></circle></svg>'),
};

describe('previewDocument: the gate is wired to the sanitiser output', () => {
  beforeEach(() => sanitize.mockReset());

  for (const [name, markup] of Object.entries(HOSTILE)) {
    it(`shows the notice, not the page, when the sanitiser lets through ${name}`, () => {
      sanitize.mockReturnValue(markup);
      const out = previewDocument('html', '<p>anything</p>');
      expect(out).toContain(UNAVAILABLE);
      expect(out).not.toContain('x.test');
      expect(out).not.toContain('<form');
      expect(out).not.toContain('<svg');
    });
  }

  it('renders a benign sanitiser result, so the stub itself is not what makes the others fail', () => {
    sanitize.mockReturnValue(page('<p>hello</p>'));
    const out = previewDocument('html', '<p>anything</p>');
    expect(out).not.toContain(UNAVAILABLE);
    expect(out).toContain('<p>hello</p>');
    expect(out).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(sanitize).toHaveBeenCalledTimes(1);
  });
});
