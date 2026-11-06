import { useEffect, useState } from 'react';
import type { Hex } from 'viem';

/** Hash routes (#/…), so the built app works from any static host or folder. */
export type Route =
  | { name: 'home' }
  | { name: 'url'; urlHash: Hex }
  | { name: 'capture'; key: Hex }
  | { name: 'file' }
  | { name: 'storage' }
  | { name: 'settings' }
  | { name: 'approve'; captureId: string | null }
  | { name: 'library'; q: string; type: LibraryType; sort: LibrarySort }
  | { name: 'not-found'; path: string };

export type LibraryType = 'all' | 'page' | 'repo';
export type LibrarySort = 'time' | 'newest' | 'ending';
export type LibraryView = { q: string; type: LibraryType; sort: LibrarySort };

const LIBRARY_TYPES: readonly LibraryType[] = ['all', 'page', 'repo'];
const LIBRARY_SORTS: readonly LibrarySort[] = ['time', 'newest', 'ending'];
const oneOf = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/** `#/library?q=&type=&sort=`: the library view in the address, so a view can be shared. Defaults are left out. */
export function libraryHash(p: Partial<LibraryView>): string {
  const params = new URLSearchParams();
  if (p.q) params.set('q', p.q);
  if (p.type && p.type !== 'all') params.set('type', p.type);
  if (p.sort && p.sort !== 'time') params.set('sort', p.sort);
  const qs = params.toString();
  return qs ? `#/library?${qs}` : '#/library';
}

const KEY = /^0x[0-9a-fA-F]{64}$/;

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0].replace(/\/+$/, '');
  switch (path) {
    case '':
      return { name: 'home' };
    case '/file':
      return { name: 'file' };
    case '/storage':
      return { name: 'storage' };
    case '/settings':
      return { name: 'settings' };
    case '/approve':
      return { name: 'approve', captureId: null };
    case '/library': {
      const params = new URLSearchParams(hash.replace(/^#/, '').split('?').slice(1).join('?'));
      return {
        name: 'library',
        q: params.get('q') ?? '',
        type: oneOf(params.get('type'), LIBRARY_TYPES, 'all'),
        sort: oneOf(params.get('sort'), LIBRARY_SORTS, 'time'),
      };
    }
  }
  // `#/approve/:captureId` (the extension's 128-bit id; `?ext=` names the extension).
  const approve = /^\/approve\/([0-9a-f]{32})$/.exec(path);
  if (approve) return { name: 'approve', captureId: approve[1] };
  // `#/c/:entityKey` (also `#/capture/:key`) and `#/u/:urlHash` (also `#/url/:urlHash`).
  const m = /^\/(c|capture|u|url)\/([^/]+)$/.exec(path);
  if (m && KEY.test(m[2])) {
    const hex = m[2].toLowerCase() as Hex;
    return m[1] === 'c' || m[1] === 'capture' ? { name: 'capture', key: hex } : { name: 'url', urlHash: hex };
  }
  return { name: 'not-found', path: path || '/' };
}

/** Changes whenever the page changes (also between two captures), so focus moves to the h1. */
export function routeId(route: Route): string {
  switch (route.name) {
    case 'capture':
      return `capture:${route.key}`;
    case 'url':
      return `url:${route.urlHash}`;
    case 'approve':
      return `approve:${route.captureId ?? ''}`;
    default:
      return route.name;
  }
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parseHash(hash);
}
