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

/** Swarm root reference of `bytes`, computed locally with the same chunking as uploadStamped. */
export async function swarmRootOf(bytes: Uint8Array): Promise<string> {
  const splitter = new ChunkSplitter(async () => []);
  await splitter.append(bytes);
  return (await splitter.finalize()).hash().toHex();
}

/** Largest response `downloadBytes` accepts by default. Evidence files are far smaller (a capture is at most 64 KB of page). */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
/** The `maxBytes` callers pass for attachments (a repository tarball, R46). */
export const ATTACHMENT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export type DownloadOptions = {
  /** Abandons the download (and every later gateway) when aborted. */
  signal?: AbortSignal;
  /** Refuses responses larger than this many bytes (default 2 MB). */
  maxBytes?: number;
  /**
   * Compares the locally recomputed Swarm root with the reference (default: true). Only a literal
   * `false` turns it off. This is an explicit opt-out for evidence uploaded to a gateway's free
   * storage (`POST /bytes`): for files over 4 KB that gateway returns a reference that differs
   * from the locally computed root, so the root cannot bind the bytes. Callers must use it only
   * for records whose batch id is all zeros (free mode) and must bind the bytes another way
   * (the evidence checks A to C plus the record cross-check). Every other limit still applies.
   */
  verifyRoot?: boolean;
};

class TooLarge extends Error {}

/**
 * Reads a response body, counting bytes as they arrive and cancelling the stream as soon as
 * `maxBytes` is passed, so a hostile or broken gateway cannot make the page buffer a huge body.
 */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const stated = Number(res.headers.get('content-length'));
  if (Number.isFinite(stated) && stated > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooLarge(`response is ${stated} bytes, over the ${maxBytes}-byte limit`);
  }
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw new TooLarge(`response is over the ${maxBytes}-byte limit`);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge(`response is over the ${maxBytes}-byte limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Tries each gateway's `/bytes/{ref}` in order and returns the first response
 * whose locally recomputed root reference equals `ref`; gateways are not trusted.
 * A response over `maxBytes` (default 2 MB) is cut off and counts as a failure of that
 * gateway. Aborting `signal` stops everything and throws. `verifyRoot: false` (free-mode
 * records only, see `DownloadOptions`) skips the root comparison; `rootVerified` in the result
 * says whether the root was compared.
 */
export async function downloadBytes(
  ref: string,
  urls: string[],
  opts: DownloadOptions = {},
): Promise<{ bytes: Uint8Array; from: string; rootVerified: boolean }> {
  if (!/^(0x)?[0-9a-f]{64}$/i.test(ref)) throw new Error('invalid swarm reference');
  const want = bare(ref).toLowerCase();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const checkRoot = opts.verifyRoot !== false;
  const errors: string[] = [];
  for (const url of urls) {
    opts.signal?.throwIfAborted();
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/bytes/${bare(ref)}`, { signal: opts.signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        errors.push(`${url}: ${res.status}`);
        continue;
      }
      const bytes = await readCapped(res, maxBytes);
      if (!checkRoot) return { bytes, from: url, rootVerified: false };
      if ((await swarmRootOf(bytes)) === want) return { bytes, from: url, rootVerified: true };
      errors.push(`${url}: reference mismatch (returned bytes do not hash to ${want})`);
    } catch (e) {
      if (opts.signal?.aborted) throw new Error(`download of ${want} aborted`);
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`download of ${want} failed: ${errors.join('; ')}`);
}

/** Unstamped upload; only public gateways (which stamp with their own batch) accept it. */
export async function uploadFree(bytes: Uint8Array, uploadUrl: string): Promise<Hex> {
  const res = await fetch(`${uploadUrl.replace(/\/$/, '')}/bytes`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    // TS 6 accepts only ArrayBuffer-backed views as a fetch body; callers never pass a shared one.
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  if (!res.ok) throw new Error(`free upload failed: ${res.status}`);
  const { reference } = (await res.json()) as { reference: string };
  return `0x${bare(reference)}`;
}
