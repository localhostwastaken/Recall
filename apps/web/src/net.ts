import type { NetConfig } from '@recall/net';
import { baseNetConfig, getNetName, type NetName } from './defaults';
import { getSettings } from './settings';

export { getNetName };
export type { NetName };

/**
 * The effective configuration: the network's defaults (see defaults.ts for how the network is
 * chosen) with the person's settings on top. Every part of the app that talks to a network
 * reads it here, at the moment it needs it, so a saved setting applies on the next page view:
 * the Arkiv RPC and access key, the Swarm upload and download gateways, the Gnosis RPC and the
 * pinned witnesses (check C).
 *
 * The access key is the person's own when they set one; an empty override falls back to the
 * key built into a production build (if any).
 */
export function getNetConfig(): NetConfig {
  const base = baseNetConfig();
  const s = getSettings();
  const accessKey = s.arkivAccessKey || base.arkiv.accessKey;
  return {
    ...base,
    arkiv: { ...base.arkiv, rpcUrl: s.arkivRpcUrl, ...(accessKey ? { accessKey } : {}) },
    swarm: { uploadUrl: s.uploadUrl, downloadUrls: [...s.downloadUrls] },
    gnosis: { rpcUrl: s.gnosisRpcUrl },
    witness: { pinned: s.pinnedWitnesses.map((w) => w.address) },
  };
}
