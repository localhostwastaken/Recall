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
 *   inside our frame, so nothing in the document can navigate: every `a` and `area` (HTML and
 *   SVG) loses its `href` and `xlink:href` and gets `target=_blank` (a popup, which the sandbox
 *   blocks); `meta[http-equiv]`, `base`, `link` (preconnect and dns-prefetch are not CSP
 *   governed either) and every element that can load a frame are removed; our own
 *   `<base target="_blank">` makes anything that slips through a blocked popup.
 *
 * The result is parsed again and checked (`leftovers`), so a serialisation that did not come out
 * as intended is replaced by a plain notice instead of being shown.
 *
 * DOMParser's 'text/html' mode is inert: it runs no script and fetches nothing.
 */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";
const XLINK = 'http://www.w3.org/1999/xlink';

const PLAIN_TEXT_STYLE = 'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}';

/** Elements removed outright: anything that can pull in another document or a connection. */
const REMOVE = 'meta[http-equiv], base, link, iframe, frame, frameset, object, embed, portal, fencedframe';

/** What the preview shows when the safety check fails. */
const UNAVAILABLE =
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
  '<p style="font:14px system-ui,sans-serif">This page could not be shown safely. Nothing was loaded.</p>';

/** Takes away everything in the document that can navigate or load another document. */
function lockDown(doc: Document): void {
  doc.querySelectorAll(REMOVE).forEach((n) => n.remove());
  doc.querySelectorAll('a, area').forEach((link) => {
    // HTML links and SVG links (`a` in the SVG namespace, with `href` or `xlink:href`).
    link.removeAttribute('href');
    link.removeAttributeNS(XLINK, 'href');
    link.removeAttribute('xlink:href');
    link.removeAttribute('ping');
    link.setAttribute('target', '_blank');
  });
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
 */
export function leftovers(doc: Document): string[] {
  const found: string[] = [];
  const metas = [...doc.querySelectorAll('meta[http-equiv]')];
  if (metas.length !== 1 || metas[0] !== doc.head.firstElementChild || metas[0].getAttribute('content') !== CSP) {
    found.push('meta[http-equiv]');
  }
  const bases = [...doc.querySelectorAll('base')];
  if (bases.length !== 1 || bases[0].hasAttribute('href') || bases[0].getAttribute('target') !== '_blank') found.push('base');
  if (doc.querySelector('link, iframe, frame, frameset, object, embed, portal, fencedframe')) found.push('frame or link element');
  for (const link of doc.querySelectorAll('a, area')) {
    if (link.hasAttribute('href') || link.hasAttributeNS(XLINK, 'href') || link.hasAttribute('xlink:href')) found.push('a[href]');
    if (link.getAttribute('target') !== '_blank') found.push('a[target]');
  }
  return found;
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
  const again = new DOMParser().parseFromString(html, 'text/html');
  return leftovers(again).length === 0 ? html : UNAVAILABLE;
}
