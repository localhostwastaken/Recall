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
