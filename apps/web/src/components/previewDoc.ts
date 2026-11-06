import DOMPurify from 'dompurify';

/**
 * The document a captured page is shown in. It goes into `<iframe sandbox="" srcdoc>`: the empty
 * sandbox already blocks scripts, forms, popups, plugins and top navigation, and the page gets
 * an opaque origin. What the sandbox does NOT stop is a sandboxed frame navigating ITSELF (a
 * link, `target=_self`, a meta refresh), which would put a lookalike page inside our frame, and
 * CSP does not govern navigation. A captured page is hostile input, so it is not trusted:
 *
 * 1. An allowlist, not a blocklist (R35): DOMPurify keeps plain HTML only (no SVG, no MathML,
 *    no template, no frames, no forms, no meta or link, no `href` on anything, no data
 *    attributes) and only `data:` images for any URL. `<style>` stays, because CSS cannot
 *    navigate and the CSP below blocks every load it could start.
 * 2. Our CSP meta goes first in the head: `default-src 'none'`, so no image, font, frame or
 *    request loads from anywhere but `data:`. `<base target="_blank">` makes anything that is
 *    left a blocked popup instead of a navigation.
 * 3. A fail-closed check on the FINAL string (`safe`). A sanitiser works on one parse of the
 *    page; the frame parses the string again, and a page can be built so the two disagree
 *    (mutation XSS: content hidden inside an attribute becomes markup, for example a closed
 *    declarative shadow root that no query can see). So the string must be a fixed point of
 *    parse and serialise, and must still contain nothing that can navigate. Any failure
 *    shows a plain notice instead of the page.
 *
 * DOMParser's 'text/html' mode is inert: it runs no script and fetches nothing.
 */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

const SANITIZE = {
  WHOLE_DOCUMENT: true,
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['template', 'noscript', 'meta', 'base', 'link', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'portal'],
  FORBID_ATTR: [
    'href',
    'xlink:href',
    'ping',
    'action',
    'formaction',
    'srcset',
    'shadowrootmode',
    'shadowrootclonable',
    'shadowrootdelegatesfocus',
    'shadowrootserializable',
  ],
  ALLOW_DATA_ATTR: false,
  // Any URL that is left (an image source, a background) must be a data: image.
  ALLOWED_URI_REGEXP: /^data:image\/(?:png|gif|jpe?g|webp|bmp|avif|x-icon)[;,]/i,
};

/** What the preview shows when a page cannot be shown safely. */
const UNAVAILABLE =
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
  '<p style="font:14px system-ui,sans-serif">This page could not be shown safely. Nothing was loaded.</p>';

/** What must not exist anywhere in the final document. */
const FORBIDDEN =
  'template, svg, math, script, noscript, form, link, iframe, frame, frameset, object, embed, portal, fencedframe, [href], [*|href]';

const PLAIN_TEXT_STYLE = 'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}';

const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The fail-closed check on the final string: it is a fixed point of parse and serialise (what the
 * frame will build is exactly what was checked), and it holds our one CSP meta first in the head,
 * our one base, and nothing that can navigate or load a document.
 */
export function safe(out: string): boolean {
  const dp = new DOMParser().parseFromString(out, 'text/html');
  if (`<!doctype html>${dp.documentElement.outerHTML}` !== out) return false;
  if (dp.querySelector(FORBIDDEN)) return false;
  const metas = [...dp.querySelectorAll('meta[http-equiv]')];
  if (metas.length !== 1 || metas[0] !== dp.head.firstElementChild || metas[0].getAttribute('content') !== CSP) return false;
  const bases = [...dp.querySelectorAll('base')];
  return bases.length === 1 && bases[0].getAttribute('target') === '_blank' && !bases[0].hasAttribute('href');
}

export function previewDocument(kind: 'html' | 'text', text: string): string {
  const source =
    kind === 'html'
      ? text
      : `<!doctype html><html><head><style>${PLAIN_TEXT_STYLE}</style></head><body><pre>${escapeText(text)}</pre></body></html>`;
  const clean = DOMPurify.sanitize(source, SANITIZE);
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', CSP);
  doc.head.prepend(base);
  doc.head.prepend(csp); // first, so it covers everything after it
  const out = `<!doctype html>${doc.documentElement.outerHTML}`;
  return safe(out) ? out : UNAVAILABLE;
}
