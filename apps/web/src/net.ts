import { LOCAL, liveConfig, type NetConfig } from '@recall/net';

/**
 * Which network the app talks to. `pnpm --filter web dev` runs against the local devnet;
 * a production build runs against the live networks. `VITE_RECALL_NET=local|live`
 * overrides both. Settings (a later task) will layer user overrides on top.
 */
export function getNetConfig(): NetConfig {
  const mode = import.meta.env.VITE_RECALL_NET ?? (import.meta.env.DEV ? 'local' : 'live');
  return mode === 'local' ? LOCAL : liveConfig({});
}
