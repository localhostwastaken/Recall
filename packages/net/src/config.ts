import type { Address } from 'viem';

export type NetConfig = {
  arkiv: { chain: 'local' | 'rabdi'; rpcUrl: string; accessKey?: string };
  swarm: { uploadUrl: string; downloadUrls: string[] };
  gnosis: { rpcUrl: string };
  app: { url: string };
  witness: { pinned: Address[] };
  /**
   * Public block explorers, so a person can open a record or a payment in the explorer's own
   * page instead of trusting ours. Live only: the local devnet has none, so no explorer link is
   * shown there.
   */
  explorers?: { arkiv?: string; gnosis?: string };
};

/** The host of the public Rabdi RPC (the SDK's `rabdi({accessKey})` uses the same one). */
export const RABDI_RPC_HOST = 'rpc.rabdi.db-chain.testnet.arkiv.network';

export const LOCAL: NetConfig = {
  arkiv: { chain: 'local', rpcUrl: 'http://localhost:8545' },
  swarm: { uploadUrl: 'http://localhost:1633', downloadUrls: ['http://localhost:1643'] },
  gnosis: { rpcUrl: 'http://localhost:9545' },
  app: { url: 'http://localhost:5173' },
  witness: { pinned: [] },
};

export function liveConfig(env: Record<string, string>): NetConfig {
  return {
    arkiv: {
      chain: 'rabdi',
      rpcUrl: `https://${RABDI_RPC_HOST}`,
      accessKey: env.ARKIV_ACCESS_KEY,
    },
    swarm: {
      uploadUrl: 'https://api.gateway.ethswarm.org',
      downloadUrls: ['https://download.gateway.ethswarm.org', 'https://bzz.link'],
    },
    gnosis: { rpcUrl: 'https://rpc.gnosischain.com' },
    app: { url: 'https://localhostwastaken.github.io/Recall/app/' },
    witness: { pinned: [] },
    explorers: { arkiv: 'https://rabdi.explorer.arkiv.network', gnosis: 'https://gnosisscan.io' },
  };
}

/**
 * The URL Arkiv reads go to. The access key is part of the URL on the Rabdi host
 * (`https://<host>/<key>`, the SDK's own scheme), so for the Rabdi chain on exactly that host
 * (https), with a key set and no path of its own yet, the key is added. Any other URL is returned
 * as is, and the key is never appended to another host (a custom RPC the person chose must not
 * get a key meant for Rabdi).
 */
export function arkivRpcUrl(cfg: NetConfig): string {
  const { chain, rpcUrl, accessKey } = cfg.arkiv;
  const key = accessKey?.trim();
  if (chain !== 'rabdi' || !key) return rpcUrl;
  let u: URL;
  try {
    u = new URL(rpcUrl);
  } catch {
    return rpcUrl;
  }
  if (u.protocol !== 'https:' || u.hostname !== RABDI_RPC_HOST || u.username || u.password) return rpcUrl;
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return rpcUrl;
  return `${u.origin}/${encodeURIComponent(key)}`;
}

/** Accepts a private key with or without the 0x prefix (ruling R11). */
export function normalizeKey(k: string): Address {
  const t = k.trim();
  return (t.startsWith('0x') || t.startsWith('0X') ? `0x${t.slice(2)}` : `0x${t}`) as Address;
}
