import { useEffect, useState } from 'react';

/** Hash routes (#/…), so the built app works from any static host or folder. */
export type Route =
  | { name: 'home' }
  | { name: 'reader' }
  | { name: 'storage' }
  | { name: 'settings' }
  | { name: 'not-found'; path: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0].replace(/\/+$/, '');
  switch (path) {
    case '':
      return { name: 'home' };
    case '/reader':
      return { name: 'reader' };
    case '/storage':
      return { name: 'storage' };
    case '/settings':
      return { name: 'settings' };
    default:
      return { name: 'not-found', path: path || '/' };
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
