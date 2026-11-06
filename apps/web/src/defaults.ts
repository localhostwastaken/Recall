import { LOCAL, liveConfig, type NetConfig } from '@recall/net';
import type { Address } from 'viem';

// The app's built-in configuration. Nothing here reads the person's settings: settings.ts
// layers their choices on top of these defaults, and net.ts hands the result to the app.

/**
 * Which network the app talks to (and so which witness check C trusts by default):
 *
 * - `pnpm --filter web dev` (Vite dev server) runs against the local devnet.
 * - A production build (`vite build`) runs against the live networks.
 * - `VITE_RECALL_NET=local|live` sets it at build or serve time.
 * - In the dev server only, `?net=local|live` in the page URL (before the `#`) overrides it for
 *   that page load. A production build ignores `?net=` on purpose: the local devnet's witness
 *   key is public, so a link must never be able to switch a deployed app to it.
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

/** The witness of the local devnet (Hardhat account #2: a public, test-only key). */
export const DEVNET_WITNESS: Address = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
/** The live Recall witness (its key stays on the operator's machine). */
export const LIVE_WITNESS: Address = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';
/** The label of the default witness. The Settings list adds "(default)" after it. */
export const DEFAULT_WITNESS_LABEL = 'Recall Witness';

/**
 * The Arkiv access key baked into a production build (R30). `vite.config.ts` reads it from the
 * build environment (ARKIV_ACCESS_KEY: a CI secret, or the git-ignored repo-root .env.local) and
 * never writes it to a file in the repo. The person can override it in Settings; an empty
 * override means "use this one". It is never shown in the page: Settings says "Built-in key
 * (default)".
 */
const baked = import.meta.env.VITE_ARKIV_ACCESS_KEY as string | undefined;
export const BUILT_IN_ARKIV_KEY: string = typeof baked === 'string' ? baked.trim() : '';
export const hasBuiltInArkivKey = (): boolean => getNetName() === 'live' && BUILT_IN_ARKIV_KEY !== '';

/** The network's own config, before any settings are applied. */
export function baseNetConfig(): NetConfig {
  if (getNetName() === 'local') return LOCAL;
  return liveConfig(BUILT_IN_ARKIV_KEY ? { ARKIV_ACCESS_KEY: BUILT_IN_ARKIV_KEY } : {});
}

/** The default trusted-witness address of the network. */
export const defaultWitnessAddress = (): Address => (getNetName() === 'local' ? DEVNET_WITNESS : LIVE_WITNESS);
