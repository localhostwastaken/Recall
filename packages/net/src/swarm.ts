import { Bee, ChunkSplitter, type Stamper } from '@ethersphere/bee-js';
import type { Hex } from 'viem';

export { Stamper } from '@ethersphere/bee-js';

/**
 * Splits `bytes` into chunks, stamps each with `stamper` (client side, signed by
 * the batch owner key) and uploads them one by one via `POST /chunks`. Returns
 * the root reference as 0x-prefixed hex. Each chunk is pushed synchronously by
 * default (`deferred: false`), so a resolved promise means the network has it.
 */
export async function uploadStamped(
  bytes: Uint8Array,
  opts: { uploadUrl: string; stamper: Stamper; deferred?: boolean },
): Promise<Hex> {
  const bee = new Bee(opts.uploadUrl);
  const put = async (c: { hash(): { toUint8Array(): Uint8Array }; build(): Uint8Array }) => {
    const envelope = opts.stamper.stamp(c.hash().toUint8Array());
    await bee.chunk.upload(envelope, c.build(), { deferred: opts.deferred ?? false });
  };
  const splitter = new ChunkSplitter(async (batch) => {
    for (const { chunk } of batch) await put(chunk);
    return [];
  });
  await splitter.append(bytes);
  const root = await splitter.finalize();
  await put(root); // the root is not handed to the batch callback
  return `0x${root.hash().toHex()}`;
}

const bare = (ref: string) => ref.replace(/^0x/, '');

/** Tries each gateway's `/bytes/{ref}` in order and returns the first success. */
export async function downloadBytes(
  ref: string,
  urls: string[],
): Promise<{ bytes: Uint8Array; from: string }> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/bytes/${bare(ref)}`);
      if (res.ok) return { bytes: new Uint8Array(await res.arrayBuffer()), from: url };
      errors.push(`${url}: ${res.status}`);
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`download of ${bare(ref)} failed: ${errors.join('; ')}`);
}

/** Unstamped upload; only public gateways (which stamp with their own batch) accept it. */
export async function uploadFree(bytes: Uint8Array, uploadUrl: string): Promise<Hex> {
  const res = await fetch(`${uploadUrl.replace(/\/$/, '')}/bytes`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`free upload failed: ${res.status}`);
  const { reference } = (await res.json()) as { reference: string };
  return `0x${bare(reference)}`;
}
