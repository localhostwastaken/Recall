import type { NetConfig } from '@recall/net';

// "Check it yourself": links to the outside tools that show the same record or payment (Arkiv's
// block explorer, a Swarm gateway, Gnosisscan), so nobody has to trust Recall's own page. Every
// builder returns null when the network has no such tool configured (the local devnet has none),
// or when the value is not what the tool expects.

const ENTITY_KEY = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A Swarm reference: 32 bytes, or 64 for an encrypted one. */
const SWARM_REF = /^(?:0x)?([0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/;

/** An http(s) base URL without its trailing slashes, or null. */
function baseUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u).protocol;
    if (p !== 'https:' && p !== 'http:') return null;
  } catch {
    return null;
  }
  return u.replace(/\/+$/, '');
}

/** The record's page on the Arkiv block explorer. */
export function arkivEntityUrl(cfg: NetConfig, entityKey: string | null | undefined): string | null {
  const base = baseUrl(cfg.explorers?.arkiv);
  return base && entityKey && ENTITY_KEY.test(entityKey) ? `${base}/entity/${entityKey}` : null;
}

/** An account's page on the Arkiv block explorer. */
export function arkivAddressUrl(cfg: NetConfig, address: string | null | undefined): string | null {
  const base = baseUrl(cfg.explorers?.arkiv);
  return base && address && ADDRESS.test(address) ? `${base}/address/${address}` : null;
}

/** A transaction on the Gnosis explorer. */
export function gnosisTxUrl(cfg: NetConfig, txHash: string | null | undefined): string | null {
  const base = baseUrl(cfg.explorers?.gnosis);
  return base && txHash && TX_HASH.test(txHash) ? `${base}/tx/${txHash}` : null;
}

/**
 * The raw file behind a Swarm reference, from the first download gateway (`/bytes/<ref>`, without
 * 0x). Shown only where the explorers are (the live network), so local runs show no link; an
 * all-zero reference is not a real one.
 */
export function swarmBytesUrl(cfg: NetConfig, ref: string | null | undefined): string | null {
  if (!baseUrl(cfg.explorers?.arkiv)) return null;
  const base = baseUrl(cfg.swarm.downloadUrls[0]);
  const m = ref ? SWARM_REF.exec(ref) : null;
  if (!base || !m || /^0+$/.test(m[1]!)) return null;
  return `${base}/bytes/${m[1]!.toLowerCase()}`;
}

export type OutsideLinkSpec = { label: string; href: string };

const present = (links: (OutsideLinkSpec | null)[]): OutsideLinkSpec[] => links.filter((l): l is OutsideLinkSpec => l !== null);
const link = (label: string, href: string | null): OutsideLinkSpec | null => (href ? { label, href } : null);

/** The links under "What the witness saw" on a record page. */
export function recordLinks(
  cfg: NetConfig,
  r: { entityKey?: string | null; evidenceRef?: string | null; owner?: string | null },
): OutsideLinkSpec[] {
  return present([
    link('Record on Arkiv explorer', arkivEntityUrl(cfg, r.entityKey)),
    link('Evidence file on Swarm', swarmBytesUrl(cfg, r.evidenceRef)),
    link('Publisher on Arkiv explorer', arkivAddressUrl(cfg, r.owner)),
  ]);
}

/** The links of a repository snapshot card: its code record and the code archive itself. */
export function attachmentLinks(cfg: NetConfig, a: { entityKey?: string | null; evidenceRef?: string | null }): OutsideLinkSpec[] {
  return present([
    link('Code record on Arkiv explorer', arkivEntityUrl(cfg, a.entityKey)),
    link('Code archive on Swarm', swarmBytesUrl(cfg, a.evidenceRef)),
  ]);
}
