// The extension's stamp key (service worker side). It owns the postage batches the web
// app buys and signs the client-side Swarm stamps. It is created once, kept in
// chrome.storage.local, and only ever handed to our own offscreen document, which
// signs the stamps. Pages get the address, never the key. Never log it.
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

export const STAMP_KEY = 'recall.stampKey';

/** The subset of chrome.storage.StorageArea the key needs (injectable for tests). */
export type KeyArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

const defaultArea = (): KeyArea => chrome.storage.local as unknown as KeyArea;

const isKey = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

// One read-or-create per storage area, so concurrent first calls share one key.
const loading = new WeakMap<KeyArea, Promise<Hex>>();

/** The stamp key: read from storage, or generated and stored on first use. */
export function stampKey(area: KeyArea = defaultArea()): Promise<Hex> {
  let p = loading.get(area);
  if (!p) {
    p = (async () => {
      const stored = (await area.get(STAMP_KEY))[STAMP_KEY];
      if (isKey(stored)) return stored;
      const key = generatePrivateKey();
      await area.set({ [STAMP_KEY]: key });
      return key;
    })();
    // A failed read is not cached: the next call tries again.
    p.catch(() => loading.delete(area));
    loading.set(area, p);
  }
  return p;
}

/** The public address of the stamp key (the owner of every batch in the pool). */
export async function stampAddress(area: KeyArea = defaultArea()): Promise<Address> {
  return privateKeyToAddress(await stampKey(area));
}
