/** The existing simplified reading view. Only text is rendered in React;
 * archived tags never enter the live DOM. Original response bytes are retained. */
export function readingText(body: Uint8Array, contentType?: string): string | null {
  if (!contentType || !/^text\/(html|plain)(?:\s*;|$)/i.test(contentType) || /charset\s*=\s*(?!["']?utf-?8(?:["'\s;]|$))/i.test(contentType)) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return null; }
  if (/^text\/plain/i.test(contentType)) return text;
  const stripped = text.replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  const doc = new DOMParser().parseFromString(`<body>${stripped.replace(/</g, '&lt;')}</body>`, 'text/html');
  return (doc.body.textContent ?? '').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
