/**
 * The document a captured page is shown in. It goes into `<iframe sandbox="" srcdoc>`: the empty
 * sandbox already blocks scripts, forms, popups, plugins and top navigation, and the page gets
 * an opaque origin. On top of that:
 *
 * - a Content-Security-Policy meta first in the head blocks every outside resource (images,
 *   styles, fonts, frames, requests); only inline styles and data: images are allowed, so the
 *   page still looks like itself;
 * - `<meta http-equiv>` (a refresh to another site) and `<base>` are removed;
 * - `<base target="_blank">` makes a clicked link a blocked popup, so the frame cannot be
 *   navigated away to a lookalike page.
 *
 * DOMParser's 'text/html' mode is inert: it runs no script and fetches nothing.
 */
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

const PLAIN_TEXT_STYLE = 'pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.45 ui-monospace,Menlo,Consolas,monospace}';

export function previewDocument(kind: 'html' | 'text', text: string): string {
  const doc = new DOMParser().parseFromString(kind === 'html' ? text : '<!doctype html><pre></pre>', 'text/html');
  if (kind === 'text') {
    doc.querySelector('pre')!.textContent = text;
    const style = doc.createElement('style');
    style.textContent = PLAIN_TEXT_STYLE;
    doc.head.append(style);
  }
  doc.querySelectorAll('meta[http-equiv], base').forEach((n) => n.remove());
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', CSP);
  doc.head.prepend(base);
  doc.head.prepend(csp); // first, so it covers everything after it
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
