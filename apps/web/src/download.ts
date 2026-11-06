import { downloadBytes } from '@recall/net';
import type { NetConfig } from '@recall/net';

/** Hands bytes to the browser as a file download (nothing is uploaded anywhere). */
export function saveBytes(bytes: Uint8Array, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `recall-<urlHash8>-<signedAt>.json`: the evidence file of one capture. */
export const evidenceFileName = (urlHash: string, signedAt: bigint): string => `recall-${urlHash.slice(2, 10)}-${signedAt}.json`;

/**
 * A free-mode capture: its evidence went to a gateway's own free storage, so the record carries
 * the all-zero batch id (no batch was used). This is the ONLY thing that switches the Swarm root
 * check off, see `evidenceDownloadOptions`.
 */
export const isFreeModeBatch = (batchId: string): boolean => /^0x0{64}$/i.test(batchId);

/**
 * How to download a record's evidence (R13). The default is to verify the Swarm root locally, so
 * a gateway cannot alter the bytes. For free-mode records only (all-zero batch id), the root is
 * not checked: for files over 4 KB the gateway's reference differs from the locally computed
 * root. Their bytes are bound another way: checks A to C on the evidence and the cross-check of
 * its facts (address hash, body hash, witness, signed time) against the record's indexed fields,
 * which every caller runs through `verifyRecordEvidence`.
 */
export const evidenceDownloadOptions = (batchId: string): { verifyRoot: boolean } => ({ verifyRoot: !isFreeModeBatch(batchId) });

/** Downloads the evidence a record points to from the configured download gateways. */
export function downloadEvidence(
  cfg: Pick<NetConfig, 'swarm'>,
  record: { evidenceRef: string; batchId: string },
  opts: { signal?: AbortSignal; maxBytes?: number } = {},
) {
  return downloadBytes(record.evidenceRef, cfg.swarm.downloadUrls, { ...opts, ...evidenceDownloadOptions(record.batchId) });
}
