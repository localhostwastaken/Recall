// The repository tarball of a pending capture (R46), kept in the extension's IndexedDB under its
// unguessable captureId until the capture is published or discarded (chrome.storage is too small
// for it). The offscreen document writes and reads it; the service worker deletes it. Never
// answered to a page.
const DB_NAME = 'recall-attachments';
const STORE = 'tarballs';

export type StoredAttachment = { bytes: Uint8Array; sha256: string; at: number };

const hasIdb = () => typeof indexedDB !== 'undefined';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function putAttachment(captureId: string, value: StoredAttachment): Promise<void> {
  await run('readwrite', (s) => s.put(value, captureId));
}

export async function getAttachment(captureId: string): Promise<StoredAttachment | null> {
  const v = await run<StoredAttachment>('readonly', (s) => s.get(captureId));
  return v && v.bytes instanceof Uint8Array ? v : null;
}

/** Best effort: never throws (no IndexedDB in unit tests, or nothing stored). */
export async function deleteAttachment(captureId: string): Promise<void> {
  if (!hasIdb()) return;
  try {
    await run('readwrite', (s) => s.delete(captureId));
  } catch (err) {
    console.error('[recall] the repository snapshot could not be deleted', err);
  }
}

/** Best effort: drops every stored tarball whose captureId is not in `keep`. */
export async function pruneAttachments(keep: Set<string>): Promise<void> {
  if (!hasIdb()) return;
  try {
    const keys = (await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())) ?? [];
    for (const k of keys) if (typeof k === 'string' && !keep.has(k)) await deleteAttachment(k);
  } catch (err) {
    console.error('[recall] pruning repository snapshots failed', err);
  }
}
