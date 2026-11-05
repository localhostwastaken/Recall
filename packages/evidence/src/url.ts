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
