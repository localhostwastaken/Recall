import { contentKind, decodeBody } from '../timeline/content';

/** Bidirectional embedding, override and isolate controls: a title could use them to reorder the card's text. */
export const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** The longest title a card shows; longer ones are cut with an ellipsis. */
export const MAX_TITLE = 120;

/**
 * The `<title>` of a captured HTML page, as plain text: DOMParser's inert 'text/html' mode (no
 * scripts run, nothing loads) and `textContent` only, whitespace collapsed, cut to 120
 * characters. Null when the body is not HTML or has no title. Captured pages are hostile input;
 * nothing here is ever inserted into the app's own DOM.
 */
export function pageTitle(body: Uint8Array, contentType?: string): string | null {
  if (contentKind(contentType) !== 'html') return null;
  let text: string;
  try {
    const doc = new DOMParser().parseFromString(decodeBody(body, contentType), 'text/html');
    text = doc.querySelector('title')?.textContent ?? '';
  } catch {
    return null;
  }
  text = text.replace(BIDI_CONTROLS, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // By code point, so a cut never splits a surrogate pair.
  const chars = Array.from(text);
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE).join('')}…` : text;
}
