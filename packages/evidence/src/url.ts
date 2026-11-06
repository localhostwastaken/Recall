import { keccak256, toBytes, type Hex } from 'viem';

/**
 * Canonical form of a captured URL: `https:` only, lower-case host, `:443` and
 * the fragment dropped, path and query kept verbatim (no dot-segment or
 * percent-encoding rewrites). An empty path becomes `/`. Throws on anything
 * ambiguous (userinfo, IPv6 literals, spaces, backslashes, non-ASCII).
 */
export function canonicalUrl(raw: string): string {
  const fail = (m: string): never => {
    throw new Error(`invalid URL: ${m}`);
  };
  const hash = raw.indexOf('#');
  const noFragment = hash < 0 ? raw : raw.slice(0, hash);
  if (!/^[\x21-\x7e]+$/.test(noFragment)) fail('must be printable ASCII without spaces');
  if (noFragment.includes('\\')) fail('backslash is not allowed');
  const m = /^https:\/\/([^/?]*)([^?]*)(\?.*)?$/i.exec(noFragment);
  if (!m) return fail('only https:// URLs are supported');
  const [, authority, path, query = ''] = m;
  if (authority === '') fail('missing host');
  if (authority.includes('@')) fail('userinfo is not allowed');
  const colon = authority.indexOf(':');
  const host = colon < 0 ? authority : authority.slice(0, colon);
  const port = colon < 0 ? '' : authority.slice(colon + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(host)) fail('invalid host');
  let portPart = '';
  if (port !== '') {
    if (!/^[0-9]{1,5}$/.test(port) || Number(port) > 65535) fail('invalid port');
    if (Number(port) !== 443) portPart = `:${Number(port)}`;
  }
  return `https://${host.toLowerCase()}${portPart}${path === '' ? '/' : path}${query}`;
}

export const urlHash = (canonical: string): Hex => keccak256(toBytes(canonical));

export type PageAddressProblem = 'invalid' | 'not-https' | 'port' | 'userinfo';

/** A typed or tab address that cannot be captured; `message` is a lower-case sentence for the UI. */
export class PageAddressError extends Error {
  constructor(
    readonly problem: PageAddressProblem,
    message: string,
  ) {
    super(message);
    this.name = 'PageAddressError';
  }
}

/**
 * A page address as a capture of it requests it: parsed by the WHATWG URL parser (as the browser
 * and the prover parse it, so dot segments are resolved and spaces percent-encoded), https only on
 * port 443, without user name or password, a trailing dot in the host, a fragment or a bare
 * trailing `?` (the prover sends the path without it). Throws PageAddressError.
 */
export function pageAddress(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new PageAddressError('invalid', 'this is not a web address');
  }
  if (u.protocol !== 'https:') throw new PageAddressError('not-https', 'only https:// pages can be captured');
  if (u.port !== '' && u.port !== '443') {
    throw new PageAddressError('port', 'only pages on the standard https port (443) can be captured');
  }
  if (u.username || u.password) {
    throw new PageAddressError('userinfo', 'addresses with a user name or password cannot be captured');
  }
  // "example.org." is the same name as "example.org"; the witness signs the name without the
  // trailing dot, so the request and the statement use that form.
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.replace(/\.+$/, '');
  if (!u.hostname || u.hostname.endsWith('.')) throw new PageAddressError('invalid', 'this is not a web address');
  u.hash = '';
  if (u.search === '') u.search = ''; // drops a bare "?"
  return u;
}

/**
 * The canonical URL a capture of `raw` records: `canonicalUrl(pageAddress(raw).href)`. Searches
 * use it, so a typed address finds the captures made of it. Throws on an address that cannot be
 * captured.
 */
export const canonicalPageUrl = (raw: string): string => canonicalUrl(pageAddress(raw).href);
