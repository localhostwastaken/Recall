import { getAddress, isAddress, type Address } from 'viem';

// Input rules shared by the web app's Settings page and the extension's settings: what counts as
// a witness address and as an endpoint URL. Pure functions, no network.

export const ADDRESS_ERROR = 'Enter a 0x address (42 characters).';
export const URL_ERROR = 'Enter a full address starting with https://';

export type Checked<T> = { ok: true; value: T } | { ok: false };

/**
 * A witness address: 0x plus 40 hex digits, written either all lower-case or with a correct
 * EIP-55 checksum (a mixed-case address with a wrong checksum is a typo and is refused). The
 * value returned is the checksummed form.
 */
export function checkAddress(raw: unknown): Checked<Address> {
  if (typeof raw !== 'string') return { ok: false };
  const t = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { ok: false };
  if (!isAddress(t, { strict: true })) return { ok: false };
  return { ok: true, value: getAddress(t) };
}

/** Plain http is for a developer's own machine only. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * An endpoint URL: https://, or http:// for localhost and 127.0.0.1 (development). Every other
 * scheme (javascript:, data:, file:, ws:, ...) is refused, and so is a URL with a user name or
 * password in it (a key never belongs in a URL that is shown or stored as one). Returns the URL
 * trimmed, with trailing slashes dropped from a plain address.
 */
export function checkUrl(raw: unknown): Checked<string> {
  if (typeof raw !== 'string') return { ok: false };
  const t = raw.trim();
  if (!t || /\s/.test(t)) return { ok: false };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false };
  }
  const secure = u.protocol === 'https:';
  const local = u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  if (!secure && !local) return { ok: false };
  if (!u.hostname || u.username || u.password) return { ok: false };
  const plain = !u.search && !u.hash;
  return { ok: true, value: plain ? t.replace(/\/+$/, '') : t };
}

export const isSafeUrl = (raw: unknown): raw is string => checkUrl(raw).ok;
