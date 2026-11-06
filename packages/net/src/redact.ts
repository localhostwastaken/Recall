import { RABDI_RPC_HOST } from './config';

const SHORTEST_KEY = 4;
const RABDI_PATH = new RegExp(`(${RABDI_RPC_HOST.replace(/\./g, '\\.')})/[^\\s"'<>)\\]]+`, 'gi');

/**
 * Removes secrets from text that may be shown or logged (an error message, a stack). Each given
 * key is replaced, in its plain and its URL-encoded form, by `[key]`; and whatever follows the
 * Rabdi host in a URL is replaced too, because that path IS the key (a person may have pasted
 * their own key URL). Keys shorter than 4 characters are ignored (they would garble the text).
 */
export function redactKey(text: string, ...keys: (string | null | undefined)[]): string {
  let out = text;
  for (const k of keys) {
    const key = k?.trim();
    if (!key || key.length < SHORTEST_KEY) continue;
    for (const form of new Set([key, encodeURIComponent(key)])) out = out.split(form).join('[key]');
  }
  return out.replace(RABDI_PATH, '$1/[key]');
}
