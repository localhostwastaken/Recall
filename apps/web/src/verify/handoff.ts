/**
 * Files the person gave on one page and another page picks up. Bytes cannot travel in a URL,
 * so they wait here (in memory only, never stored or sent anywhere) while the route changes.
 */
export type GivenFile = { name: string; bytes: Uint8Array };

let evidence: GivenFile | null = null;
let comparison: { entityKey: string; file: GivenFile } | null = null;

/** The evidence file dropped on the home page, shown on `#/file`. */
export const setEvidenceFile = (file: GivenFile | null): void => {
  evidence = file;
};
export const peekEvidenceFile = (): GivenFile | null => evidence;

/** A page file the person gave on the home page, to be compared (check D) with one capture. */
export const setComparisonFile = (entityKey: string, file: GivenFile): void => {
  comparison = { entityKey: entityKey.toLowerCase(), file };
};
export const peekComparisonFile = (entityKey: string): GivenFile | null =>
  comparison && comparison.entityKey === entityKey.toLowerCase() ? comparison.file : null;

/** The home page starts fresh: nothing from an earlier visit lingers. */
export const clearHandoff = (): void => {
  evidence = null;
  comparison = null;
};

/** Largest file the page reads into memory. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function readFile(file: File): Promise<GivenFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is too large to check here.');
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
