// Offscreen document: a stamped upload of a big file (a repository snapshot, R46) with several
// chunk pushes in flight. Chunks are still stamped one at a time and in order (each just before
// its push), so the stamp heights and the bucket accounting are exactly those of a serial upload;
// only the network pushes overlap. Each chunk is stamped ONCE: a retry re-sends the same stamp,
// so it never takes another slot of the batch. Mirrors the publish script's live push policy
// (packages/net/src/hosting.ts): Retry-After is a floor for the wait, and a 4xx before the first
// accepted chunk is retried (a fresh batch the node does not know yet).
import { ChunkSplitter, Utils } from '@ethersphere/bee-js';
import type { Hex } from 'viem';

type Envelope = Parameters<typeof Utils.convertEnvelopeToMarshaledStamp>[0];
export type ChunkStamper = { stamp(address: Uint8Array): unknown };

/** A refused or failed chunk push, with the node's status and Retry-After (ms) when known. */
export class PushError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PushError';
  }
}

/** Retry-After as milliseconds (seconds or an HTTP date), at most a minute. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

/** Pushes one stamped chunk (`POST /chunks`, the stamp in `swarm-postage-stamp`). */
export type PushFn = (uploadUrl: string, stampHex: string, data: Uint8Array, signal: AbortSignal) => Promise<void>;

export const pushChunkHttp: PushFn = async (uploadUrl, stampHex, data, signal) => {
  const res = await fetch(`${uploadUrl.replace(/\/+$/, '')}/chunks`, {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'content-type': 'application/octet-stream',
      'swarm-postage-stamp': stampHex,
      'swarm-deferred-upload': 'false',
    },
    body: data as Uint8Array<ArrayBuffer>,
    signal,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim().slice(0, 160);
    throw new PushError(
      `POST /chunks: HTTP ${res.status}${text ? ` ${text}` : ''}`,
      res.status,
      parseRetryAfter(res.headers.get('retry-after')),
    );
  }
  await res.body?.cancel().catch(() => undefined);
};

/** Worth another try: no status (network, timeout), 408/425/429, 5xx; any 4xx before the first success. */
export function retryablePush(e: unknown, anyAccepted: boolean): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  if (!anyAccepted && status >= 400 && status < 500) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export const PUSH_CONCURRENCY = 12;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];
const TRIES = 6;
const REQUEST_TIMEOUT_MS = 30_000;

export type ConcurrentUploadOptions = {
  uploadUrl: string;
  stamper: ChunkStamper;
  concurrency?: number;
  tries?: number;
  backoffMs?: number[];
  push?: PushFn;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each accepted chunk: (accepted, total). */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

type RawChunk = { address: Uint8Array; data: Uint8Array };

/**
 * Splits, stamps and pushes `bytes` with up to `concurrency` (12) pushes in flight; the root chunk
 * goes last, after every other chunk was accepted. Resolves with the root reference (0x-hex).
 * The first chunk that fails for good stops the rest (no further chunk is stamped) and its error,
 * with the node's status, is thrown.
 */
export async function uploadStampedConcurrent(bytes: Uint8Array, o: ConcurrentUploadOptions): Promise<Hex> {
  // Identical chunks (same content, same address) are stamped and pushed once.
  const chunks: RawChunk[] = [];
  const seen = new Set<string>();
  const splitter = new ChunkSplitter(async (batch) => {
    for (const { chunk } of batch) {
      const h = chunk.hash();
      if (seen.has(h.toHex())) continue;
      seen.add(h.toHex());
      chunks.push({ address: h.toUint8Array(), data: chunk.build() });
    }
    return [];
  });
  await splitter.append(bytes);
  const rootChunk = await splitter.finalize(); // the root is not handed to the batch callback
  const root: RawChunk = { address: rootChunk.hash().toUint8Array(), data: rootChunk.build() };
  const ref = `0x${rootChunk.hash().toHex()}` as Hex;

  const push = o.push ?? pushChunkHttp;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tries = o.tries ?? TRIES;
  const backoff = o.backoffMs ?? BACKOFF_MS;
  const total = chunks.length + 1;
  let done = 0;
  let accepted = false;
  let failure: unknown;

  // Stamped once, right before its first push; retries re-send this stamp.
  const stampOf = (c: RawChunk): string =>
    Utils.convertEnvelopeToMarshaledStamp(o.stamper.stamp(c.address) as Envelope).toHex();

  const pushOnce = async (c: RawChunk, stamp: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      if (o.signal?.aborted) throw new Error('upload cancelled');
      try {
        await push(o.uploadUrl, stamp, c.data, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        accepted = true;
        done++;
        o.onProgress?.(done, total);
        return;
      } catch (e) {
        if (!retryablePush(e, accepted) || attempt >= tries || failure !== undefined) throw e;
        const own = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 1_000;
        const asked = (e as { retryAfterMs?: unknown } | null)?.retryAfterMs;
        await sleep(typeof asked === 'number' ? Math.max(own, asked) : own);
      }
    }
  };

  let next = 0;
  const worker = async () => {
    while (failure === undefined && next < chunks.length) {
      const c = chunks[next++]!;
      const stamp = stampOf(c); // synchronous: stamps stay in chunk order
      await pushOnce(c, stamp);
    }
  };
  const width = Math.max(1, Math.min(o.concurrency ?? PUSH_CONCURRENCY, chunks.length || 1));
  await Promise.all(
    Array.from({ length: width }, () =>
      worker().catch((e: unknown) => {
        failure ??= e;
      }),
    ),
  );
  if (failure !== undefined) throw failure;
  await pushOnce(root, stampOf(root));
  return ref;
}
