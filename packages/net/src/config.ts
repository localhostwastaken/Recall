import type { Address } from 'viem';

export type NetConfig = {
  arkiv: { chain: 'local' | 'rabdi'; rpcUrl: string; accessKey?: string };
  swarm: { uploadUrl: string; downloadUrls: string[] };
  gnosis: { rpcUrl: string };
  app: { url: string };
  witness: { pinned: Address[] };
};

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
      rpcUrl: 'https://rpc.rabdi.db-chain.testnet.arkiv.network',
      accessKey: env.ARKIV_ACCESS_KEY,
    },
    swarm: {
      uploadUrl: 'https://api.gateway.ethswarm.org',
      downloadUrls: ['https://download.gateway.ethswarm.org', 'https://bzz.link'],
    },
    gnosis: { rpcUrl: 'https://rpc.gnosischain.com' },
    app: { url: 'https://localhostwastaken.github.io/Recall/app/' },
    witness: { pinned: [] },
  };
}

/** Accepts a private key with or without the 0x prefix (ruling R11). */
export function normalizeKey(k: string): Address {
  const t = k.trim();
  return (t.startsWith('0x') || t.startsWith('0X') ? `0x${t.slice(2)}` : `0x${t}`) as Address;
}
