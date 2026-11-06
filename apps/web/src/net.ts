import { LOCAL, liveConfig, type NetConfig } from '@recall/net';

/**
 * Which network the app talks to (and so which witness check C trusts by default):
 *
 * - `pnpm --filter web dev` (Vite dev server) runs against the local devnet.
 * - A production build (`vite build`) runs against the live networks.
 * - `VITE_RECALL_NET=local|live` sets it at build or serve time.
 * - In the dev server only, `?net=local|live` in the page URL (before the `#`) overrides it for
 *   that page load. A production build ignores `?net=` on purpose: the local devnet's witness
 *   key is public, so a link must never be able to switch a deployed app to it.
 *
 * Settings (a later task) will layer user overrides on top.
 */
export type NetName = 'local' | 'live';

export function getNetName(): NetName {
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(window.location.search).get('net');
    if (q === 'local' || q === 'live') return q;
  }
  const env = import.meta.env.VITE_RECALL_NET as string | undefined;
  if (env !== undefined && env !== '') return env === 'local' ? 'local' : 'live';
  return import.meta.env.DEV ? 'local' : 'live';
}

export function getNetConfig(): NetConfig {
  return getNetName() === 'local' ? LOCAL : liveConfig({});
}
