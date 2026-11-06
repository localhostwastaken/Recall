/**
 * The document a captured page is shown in. It goes into `<iframe sandbox="" srcdoc>`: the empty
 * sandbox already blocks scripts, forms, popups, plugins and top navigation, and the page gets
 * an opaque origin. Two things the sandbox does NOT stop are handled here, because a captured
 * page is hostile input:
 *
 * - Outside resources. A Content-Security-Policy meta first in the head blocks every image,
 *   style, font, frame and request; only inline styles and data: images are allowed, so the
 *   page still looks like itself.
 * - Navigation. A sandboxed frame may still navigate ITSELF (a link, `target=_self`, an SVG
 *   link, a meta refresh), and CSP does not govern navigation. That would put a lookalike page
 *   inside our frame, so nothing in the document can navigate:
 *   - NO element keeps an `href` or `xlink:href` (HTML, SVG and MathML alike) or a `ping`, and
 *     every `a` and `area` gets `target=_blank` (a popup, which the sandbox blocks);
 *   - `template` is removed. The browser that shows the preview (its srcdoc parser, unlike
 *     DOMParser) turns `<template shadowrootmode>` into a live shadow root, and what is inside
 *     a template is invisible to `querySelectorAll`, so a link hidden there would survive every
 *     other step. No template is allowed at all;
 *   - SVG animation elements (`animate`, `set`, ...) are removed: they can write an `href`
 *     back onto an SVG link without any script;
 *   - `meta[http-equiv]`, `base`, `link` (preconnect and dns-prefetch are not CSP governed
 *     either) and every element that can load a frame are removed;
 *   - our own `<base target="_blank">` makes anything that slips through a blocked popup.
 *
 * The result is parsed again and checked (`leftovers`), with the parser that attaches declarative
 * shadow roots when the browser has one, so a serialisation that did not come out as intended is
 * replaced by a plain notice instead of being shown.
 *
 * DOMParser's 'text/html' mode is inert: it runs no script and fetches nothing.
 */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

const PLAIN_TEXT_STYLE = 'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}';

/** Elements that can pull in another document or a connection, or hide content from a query. */
const FRAMES = 'iframe, frame, frameset, object, embed, portal, fencedframe';
/** SVG animation can set an `href` on a link with no script. (SVG names are case-sensitive in selectors.) */
const ANIMATION = 'animate, set, animateMotion, animateTransform, discard';
/** Elements removed outright. `template` is here because its content cannot be seen, only trusted. */
const REMOVE = `meta[http-equiv], base, link, template, ${FRAMES}, ${ANIMATION}`;

/** What the preview shows when the safety check fails. */
const UNAVAILABLE =
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
  '<p style="font:14px system-ui,sans-serif">This page could not be shown safely. Nothing was loaded.</p>';

/** Takes away everything in the document that can navigate or load another document. */
function lockDown(doc: Document): void {
  doc.querySelectorAll(REMOVE).forEach((n) => n.remove());
  // No element may keep an href, in any namespace (`href`, `xlink:href`, MathML's `href`).
  doc.querySelectorAll('[href], [*|href]').forEach((el) => {
    for (const attr of [...el.attributes]) if (attr.localName === 'href') el.removeAttributeNode(attr);
  });
  doc.querySelectorAll('[ping]').forEach((el) => el.removeAttribute('ping'));
  doc.querySelectorAll('a, area').forEach((link) => link.setAttribute('target', '_blank'));
}

const csp = (doc: Document): HTMLMetaElement => {
  const m = doc.createElement('meta');
  m.setAttribute('http-equiv', 'Content-Security-Policy');
  m.setAttribute('content', CSP);
  return m;
};

/**
 * What still could navigate or load something in a parsed document, ignoring the two elements
 * we add ourselves (the first meta and the first base, in the head). Empty means locked down.
 * It cannot see inside a `template`, so any template at all is a leftover.
 */
export function leftovers(doc: Document): string[] {
  const found: string[] = [];
  const metas = [...doc.querySelectorAll('meta[http-equiv]')];
  if (metas.length !== 1 || metas[0] !== doc.head.firstElementChild || metas[0].getAttribute('content') !== CSP) {
    found.push('meta[http-equiv]');
  }
  const bases = [...doc.querySelectorAll('base')];
  if (bases.length !== 1 || bases[0].hasAttribute('href') || bases[0].getAttribute('target') !== '_blank') found.push('base');
  if (doc.querySelector(`link, template, ${FRAMES}, ${ANIMATION}`)) found.push('frame, link, template or animation element');
  for (const el of doc.querySelectorAll('*')) {
    if (el.shadowRoot) found.push('shadow root');
    if ([...el.attributes].some((a) => a.localName === 'href' || a.localName === 'ping')) found.push('href');
  }
  for (const link of doc.querySelectorAll('a, area')) {
    if (link.getAttribute('target') !== '_blank') found.push('a[target]');
  }
  return found;
}

/** The parser that also attaches declarative shadow roots (what an iframe's srcdoc does), where there is one. */
function parseLikeTheFrame(html: string): Document {
  const unsafe = (Document as unknown as { parseHTMLUnsafe?: (html: string) => Document }).parseHTMLUnsafe;
  return typeof unsafe === 'function' ? unsafe.call(Document, html) : new DOMParser().parseFromString(html, 'text/html');
}

export function previewDocument(kind: 'html' | 'text', text: string): string {
  const doc = new DOMParser().parseFromString(kind === 'html' ? text : '<!doctype html><pre></pre>', 'text/html');
  if (kind === 'text') {
    doc.querySelector('pre')!.textContent = text;
    const style = doc.createElement('style');
    style.textContent = PLAIN_TEXT_STYLE;
    doc.head.append(style);
  }
  lockDown(doc);
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  doc.head.prepend(base);
  doc.head.prepend(csp(doc)); // first, so it covers everything after it
  const html = `<!doctype html>${doc.documentElement.outerHTML}`;
  // The browser will parse this string again; make sure that parse is as locked down as this one.
  const again = parseLikeTheFrame(html);
  return leftovers(again).length === 0 ? html : UNAVAILABLE;
}
