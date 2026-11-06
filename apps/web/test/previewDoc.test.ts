// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { previewDocument, safe } from '../src/components/previewDoc';

// What a captured page may turn into before it goes into the sandboxed frame. The page is hostile
// input: whatever it contains, the result is either a document that cannot navigate or load
// anything, or the plain "could not be shown safely" page.

const UNAVAILABLE = 'This page could not be shown safely.';
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

const NOTICE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mumbai Institute of Studies - Admissions Notice</title></head>
<body>
<h1>Mumbai Institute of Studies - Admissions Notice</h1>
<p>Applications for the 2027 intake are now open.</p>
<p id="deadline">Deadline: 15 December</p>
<p>This is a fictional notice used for software testing.</p>
</body>
</html>
`;

/** The page from a reviewer's mutation-XSS report: a closed shadow root hidden in an attribute. */
const MXSS =
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1&gt;&lt;div&gt;&lt;template shadowrootmode=closed&gt;' +
  '&lt;a target=_self href=http://localhost:15199/mxss style=display:block;width:400px;height:200px&gt;CLICK&lt;/a&gt;&lt;/template&gt;&lt;/div&gt;">';

/** Everything that must be true of any document the preview hands to the frame. */
function expectLockedDown(out: string): void {
  const doc = parse(out);
  expect(doc.querySelector('template, svg, math, script, form, link, iframe, frame, object, embed, [href], [*|href]')).toBeNull();
  expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(1);
  expect(doc.querySelectorAll('base')).toHaveLength(1);
  expect(out).not.toMatch(/shadowrootmode\s*=/i);
  expect(out).not.toContain('localhost:15199');
}

describe('previewDocument', () => {
  it('keeps the text of an ordinary notice page, with our CSP first and a blocked-popup base', () => {
    const out = previewDocument('html', NOTICE);
    expect(out).not.toContain(UNAVAILABLE);
    const doc = parse(out);
    expect(doc.body.textContent).toContain('Mumbai Institute of Studies - Admissions Notice');
    expect(doc.body.textContent).toContain('Deadline: 15 December');
    expect(doc.querySelector('p#deadline')?.textContent).toBe('Deadline: 15 December');
    expect(doc.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(doc.querySelector('base')?.getAttribute('target')).toBe('_blank');
    expectLockedDown(out);
    expect(safe(out)).toBe(true);
  });

  it('drops inline SVG and keeps the page text around it', () => {
    const out = previewDocument(
      'html',
      '<!doctype html><body><p>Before the logo.</p><svg width="40" height="40"><a href="http://x.test/a" target="_self"><text x="2" y="20">svg words</text></a><circle r="5"/></svg><p>After the logo.</p></body>',
    );
    expect(out).not.toContain(UNAVAILABLE);
    const doc = parse(out);
    expect(doc.querySelector('svg, circle, text')).toBeNull();
    expect(doc.body.textContent).toContain('Before the logo.');
    expect(doc.body.textContent).toContain('After the logo.');
    expectLockedDown(out);
  });

  it('shows the mutation-XSS payload as no template and no link at all (or as the notice)', () => {
    const out = previewDocument('html', MXSS);
    expectLockedDown(out);
    expect(out.includes(UNAVAILABLE) || safe(out)).toBe(true);
  });

  it('removes a closed shadow root written directly in the page, and its link', () => {
    const out = previewDocument(
      'html',
      '<body><p>visible</p><div><template shadowrootmode="closed"><a target="_self" href="http://localhost:15199/closed">hidden link</a></template></div></body>',
    );
    expectLockedDown(out);
    expect(out).not.toContain('hidden link');
    expect(parse(out).body.textContent).toContain('visible');
  });

  it('still shows a page that merely talks about shadowrootmode', () => {
    const out = previewDocument(
      'html',
      '<body><p>The attribute shadowrootmode makes a template into a shadow root; so does <code>&lt;template shadowrootmode="open"&gt;</code>.</p></body>',
    );
    expect(out).not.toContain(UNAVAILABLE);
    expect(parse(out).body.textContent).toContain('The attribute shadowrootmode makes a template into a shadow root');
    expect(parse(out).body.textContent).toContain('<template shadowrootmode="open">');
  });

  it('takes the navigation out of links, forms, redirects, frames and outside resources', () => {
    const out = previewDocument(
      'html',
      `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=http://x.test/away"><base href="http://x.test/"><link rel="preconnect" href="http://x.test">
<style>p{color:#333}</style></head><body>
<a href="http://x.test/a" target="_self">plain</a><a target="_top" href="http://x.test/b" ping="http://x.test/p">top</a>
<form action="http://x.test/f"><input name="q"><button formaction="http://x.test/g">go</button></form>
<iframe src="http://x.test/frame"></iframe><object data="http://x.test/o"></object>
<img src="http://x.test/pixel.png" alt="outside"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="inline" srcset="http://x.test/2x.png 2x">
<p data-track="x">kept</p></body></html>`,
    );
    expect(out).not.toContain(UNAVAILABLE);
    expectLockedDown(out);
    const doc = parse(out);
    expect(doc.body.textContent).toContain('plain');
    expect(doc.body.textContent).toContain('kept');
    expect(doc.querySelector('[data-track]')).toBeNull();
    expect(doc.querySelector('[ping], [srcset], [action], [formaction]')).toBeNull();
    expect([...doc.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([null, 'data:image/gif;base64,R0lGODlhAQABAAAAACw=']);
    expect(doc.querySelector('style')?.textContent).toContain('p{color:#333}'); // CSS cannot navigate
    expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("default-src 'none'");
    expect(out).not.toContain('x.test');
  });

  it('shows plain text safely, as text', () => {
    const out = previewDocument('text', 'Line one\n<script>alert(1)</script> <a href="http://x.test">not a link</a> & more');
    expectLockedDown(out);
    const doc = parse(out);
    expect(doc.querySelector('pre')?.textContent).toBe('Line one\n<script>alert(1)</script> <a href="http://x.test">not a link</a> & more');
    expect(doc.querySelector('a')).toBeNull();
  });
});

describe('safe: the fail-closed check on the final string', () => {
  const good = () => previewDocument('html', NOTICE);

  it('accepts the document the preview builds', () => {
    expect(safe(good())).toBe(true);
  });

  it('rejects a string that is not a fixed point of parse and serialise', () => {
    expect(safe(good().replace('<!doctype html>', ''))).toBe(false);
    expect(safe(good().replace('</body>', '<p></body>'))).toBe(false); // an unclosed element serialises differently
  });

  it('rejects anything that can navigate or hide content, even in a string that otherwise holds', () => {
    const add = (html: string) => good().replace('</body>', `${html}</body>`);
    for (const bad of [
      '<a href="http://x.test/">x</a>',
      '<template><p>x</p></template>',
      '<div><template shadowrootmode="closed"><a href="http://x.test/">x</a></template></div>',
      '<svg></svg>',
      '<math></math>',
      '<form></form>',
      '<iframe></iframe>',
      '<script></script>',
    ]) {
      expect(safe(add(bad)), bad).toBe(false);
    }
  });

  it('rejects a second meta or base, or a CSP that is not first', () => {
    expect(safe(good().replace('<body>', '<body><meta http-equiv="refresh" content="0;url=http://x.test">'))).toBe(false);
    expect(safe(good().replace('<head>', '<head><base href="http://x.test/">'))).toBe(false);
    expect(safe(good().replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''))).toBe(false);
  });

  it('is what stops mutation XSS: a page that is only parsed and serialised once is not a fixed point', () => {
    // What a sanitiser-free, one-pass pipeline would produce for the reviewer's payload.
    const once = parse(MXSS);
    const meta = once.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'");
    const base = once.createElement('base');
    base.setAttribute('target', '_blank');
    once.head.prepend(base);
    once.head.prepend(meta);
    const naive = `<!doctype html>${once.documentElement.outerHTML}`;
    expect(safe(naive)).toBe(false);
  });
});
