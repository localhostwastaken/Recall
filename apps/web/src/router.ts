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
  | { name: 'not-found'; path: string };

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
  }
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
