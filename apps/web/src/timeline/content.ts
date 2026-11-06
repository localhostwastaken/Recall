import { diffWords, type Change } from 'diff';

/**
 * Turns captured bytes into things the page can show or compare. Captured pages are hostile
 * input: everything here only reads them as text (DOMParser's inert 'text/html' mode does not
 * run scripts and loads nothing), and nothing is ever inserted into the app's own DOM.
 */

export type ContentKind = 'html' | 'pdf' | 'text' | 'other';

/** What a Content-Type header says the body is. Anything unstated or unknown is 'other'. */
export function contentKind(contentType: string | undefined): ContentKind {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml' || /^application\/.+\+(json|xml)$/.test(type)) {
    return 'text';
  }
  return 'other';
}

/** Bytes to a string using the charset the server stated (UTF-8 when it is missing or unknown). */
export function decodeBody(bytes: Uint8Array, contentType: string | undefined): string {
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Elements that end a line of text. Their content is separated from its neighbours. */
const BLOCK = new Set(
  'address article aside blockquote body br caption dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul'.split(
    ' ',
  ),
);
/** Elements whose content is not page text. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'svg', 'object', 'embed', 'iframe']);

/** One line per paragraph, single spaces, no blank lines: whitespace-only changes disappear. */
const tidy = (raw: string): string =>
  raw
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');

/** The visible text of an HTML page (tags, scripts and styles dropped). */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).localName;
    if (SKIP.has(tag)) return;
    const block = BLOCK.has(tag);
    if (block) out.push('\n');
    node.childNodes.forEach(walk);
    if (block) out.push('\n');
  };
  walk(doc.body);
  return tidy(out.join(''));
}

/** The text to compare for a captured body, or null when it is not an HTML or text file. */
export function comparableText(bytes: Uint8Array, contentType: string | undefined): string | null {
  const kind = contentKind(contentType);
  if (kind === 'html') return htmlToText(decodeBody(bytes, contentType));
  if (kind === 'text') return tidy(decodeBody(bytes, contentType));
  return null;
}

export type DiffPart = { kind: 'same' | 'removed' | 'added'; text: string };

/** A word diff of two texts (whitespace differences are not changes). */
export function wordDiff(before: string, after: string): DiffPart[] {
  return diffWords(before, after).map((c: Change) => ({
    kind: c.added ? 'added' : c.removed ? 'removed' : 'same',
    text: c.value,
  }));
}

export const hasChanges = (parts: readonly DiffPart[]): boolean => parts.some((p) => p.kind !== 'same');

/** How many words of unchanged text stay around a change. */
const CONTEXT = 24;

/**
 * Shortens long unchanged runs to the words next to a change, so a one-word edit in a long page
 * does not bury it. A cut shows as an ellipsis.
 */
export function withContext(parts: readonly DiffPart[], context = CONTEXT): DiffPart[] {
  return parts.map((part, i) => {
    if (part.kind !== 'same') return part;
    // Alternating words and spacing (a word, even an empty one, is always first and last).
    const tokens = part.text.split(/(\s+)/);
    const headN = i > 0 ? context * 2 : 0;
    const tailN = i < parts.length - 1 ? context * 2 : 0;
    if (tokens.length <= headN + tailN + 2) return part;
    const head = tokens.slice(0, headN).join('');
    const tail = tokens.slice(tokens.length - tailN).join('');
    return { kind: 'same', text: `${head}…${tail}` };
  });
}
