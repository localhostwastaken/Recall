// Helpers for hosting a site on Swarm with client-side stamping (scripts/publish-swarm.ts).
//
// bee-js is a dependency of this package only, so scripts get it from here instead of reaching
// into node_modules. This module is deliberately NOT exported from index.ts: the web app and the
// extension import @recall/net, and neither needs the manifest builder.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  Bee,
  ChunkSplitter,
  EthAddress,
  FeedIndex,
  Identifier,
  MantarayNode,
  NULL_ADDRESS,
  PrivateKey,
  Reference,
  Topic,
  Utils,
  type Stamper,
} from '@ethersphere/bee-js';
import { keccak256, type Hex } from 'viem';

export { Bee, ChunkSplitter, MantarayNode, NULL_ADDRESS, PrivateKey, Reference, Topic };

/** The envelope a `Stamper` signs for one chunk (what goes in the `swarm-postage-stamp` header). */
export type Envelope = ReturnType<Stamper['stamp']>;

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** The topic name the Swarm docs (host-your-website) use for a site's feed. */
export const DEFAULT_FEED_TOPIC = 'website';

/** The feed topic of a name: keccak256(name), the same rule as bee-js and swarm-cli. */
export const feedTopic = (name: string): Topic => Topic.fromString(name);

/** The identifier of update `index` of a sequence feed: keccak256(topic || index as 8 bytes, big-endian). */
export function feedIdentifier(topic: Topic, index: bigint): Identifier {
  const id = keccak256(concat(topic.toUint8Array(), FeedIndex.fromBigInt(index).toUint8Array()), 'bytes');
  return new Identifier(id);
}

/** The address of a single-owner chunk: keccak256(identifier || owner). */
export function socAddress(identifier: Identifier, owner: EthAddress): Reference {
  return new Reference(keccak256(concat(identifier.toUint8Array(), owner.toUint8Array()), 'bytes'));
}

/**
 * core-sdk draws a random obfuscation key for every manifest node, so the same site would get a
 * different reference on every run. Setting every key to zeros (as Bee's own manifests have)
 * makes a manifest, and the stamp slots its chunks take, the same on every run: a feed manifest
 * keeps its permanent address, and a resumed publish re-stamps exactly the slots of the first try.
 * Call it after the last `addFork` and before `saveRecursively`.
 */
export function zeroObfuscation(node: MantarayNode): void {
  const zero = (n: MantarayNode['core']) => {
    n.obfuscationKey = new Uint8Array(32);
    for (const f of n.forks.values()) zero(f.node);
  };
  zero(node.core);
}

/**
 * The manifest a feed URL points at: one root entry whose metadata names the feed. A node
 * answers `/bzz/<this reference>/` by looking up the feed's newest update and serving what that
 * update points at. It is byte for byte what Bee's own `POST /feeds` (bee-js
 * `createFeedManifest`) stores, so the reference is the same one: core-sdk would leave the
 * empty leaf's 32-byte entry out (reference size 0), Bee writes it, so the leaf is marshalled
 * here the way Bee does. The local test compares the two references.
 */
export function feedManifest(owner: EthAddress, topic: Topic): MantarayNode {
  const node = new MantarayNode();
  node.addFork('/', NULL_ADDRESS, {
    'swarm-feed-owner': owner.toHex(),
    'swarm-feed-topic': topic.toHex(),
    'swarm-feed-type': 'Sequence',
  });
  zeroObfuscation(node);
  const leaf = node.core.forks.get('/'.charCodeAt(0))!.node;
  const plain = leaf.marshal.bind(leaf);
  leaf.marshal = async () => {
    const m = await plain(); // obfuscation key (32) | header (32, reference size 0) | bitmap (32)
    if (m.length !== 96) throw new Error('unexpected Mantaray leaf layout');
    const out = new Uint8Array(128);
    out.set(m.subarray(0, 64));
    out[63] = 32; // reference size, as Bee writes it
    out.set(m.subarray(64), 96); // 32 zero bytes of entry, then the bitmap
    return out;
  };
  return node;
}

/** One feed update, ready to stamp and push: a single-owner chunk at `address`. */
export type FeedUpdate = { index: bigint; identifier: Identifier; address: Reference; payload: Uint8Array };

/**
 * Update `index` of the feed, pointing at `reference`. The payload is the 8-byte timestamp
 * followed by the 32-byte reference, the layout every Bee feed reader understands.
 */
export function feedUpdate(
  owner: EthAddress,
  topic: Topic,
  index: bigint,
  reference: Uint8Array,
  atSeconds: number = Math.floor(Date.now() / 1000),
): FeedUpdate {
  if (reference.length !== 32) throw new Error('a feed update points at a 32-byte reference');
  const stamp = new Uint8Array(8);
  new DataView(stamp.buffer).setBigUint64(0, BigInt(atSeconds), false);
  const identifier = feedIdentifier(topic, index);
  return { index, identifier, address: socAddress(identifier, owner), payload: concat(stamp, reference) };
}

/**
 * Pushes the update. The stamp is made by the caller (client side, from the batch owner's
 * stamper) for `update.address`; the single-owner chunk is signed here with the feed key and
 * sent to `POST /soc/{owner}/{identifier}?sig=...` with the stamp as the `swarm-postage-stamp`
 * header, so no Bee node needs to own the batch. bee-js types the stamp as a batch id, but its
 * request code sends an envelope as the pre-made stamp header.
 */
export async function pushFeedUpdate(
  bee: Bee,
  signer: PrivateKey,
  envelope: Envelope,
  update: FeedUpdate,
  signal?: AbortSignal,
): Promise<void> {
  const writer = bee.soc.makeWriter(signer, signal ? { signal } : undefined);
  await writer.upload(envelope as unknown as string, update.identifier, update.payload, { deferred: false });
}

/** A failed HTTP answer, with the status and the node's Retry-After (ms) when it sent one. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Retry-After as milliseconds (seconds or an HTTP date), at most a minute. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : undefined;
}

async function failureOf(res: Response, what: string): Promise<HttpError> {
  const text = (await res.text().catch(() => '')).trim();
  let message = text;
  try {
    const m = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof m === 'string') message = m;
  } catch {
    /* not JSON: keep the text */
  }
  return new HttpError(`${what}: HTTP ${res.status}${message ? ` ${message.slice(0, 160)}` : ''}`, res.status, parseRetryAfter(res.headers.get('retry-after')));
}

/**
 * Pushes one stamped chunk with `POST /chunks` (the stamp goes in the `swarm-postage-stamp`
 * header, so no node needs to own the batch). A failed answer throws an HttpError, which carries
 * the node's Retry-After; bee-js hides the response headers, hence the plain fetch.
 */
export async function pushChunk(beeUrl: string, envelope: Envelope, data: Uint8Array, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${beeUrl.replace(/\/+$/, '')}/chunks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'swarm-postage-stamp': Utils.convertEnvelopeToMarshaledStamp(envelope).toHex(),
      'swarm-deferred-upload': 'false',
    },
    body: data as Uint8Array<ArrayBuffer>,
    signal,
  });
  if (!res.ok) throw await failureOf(res, 'POST /chunks');
  await res.body?.cancel().catch(() => undefined);
}

/** How many existing updates `nextFeedIndex` will walk when it has to probe the chunks. */
const MAX_PROBE = 64;

/**
 * The index the next update of the feed takes (0 for a feed with no update).
 *
 * The node's own lookup (`GET /feeds`) is asked first: 200 names the next index. A 404 whose
 * message says "no update found" means the feed is empty. Bee 2.8 answers 404 "lookup at failed"
 * both for an empty feed and for one whose newest update it cannot reach yet (it also asks the
 * network for the index after the newest), so that answer proves nothing: the update chunks are
 * probed instead (`GET /chunks/<soc address of index i>`), and the first index whose chunk is
 * missing twice in a row (`confirmDelayMs` apart) is the next one. Anything else (another 404, a
 * 5xx, a network error) throws, and the caller retries or stops: guessing 0 for a feed that
 * has updates would try to overwrite one.
 */
export async function nextFeedIndex(
  beeUrl: string,
  owner: EthAddress,
  topic: Topic,
  opts: { signal?: AbortSignal; confirmDelayMs?: number } = {},
): Promise<bigint> {
  const base = beeUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/feeds/${owner.toHex()}/${topic.toHex()}`, { signal: opts.signal });
  if (res.ok) {
    const next = res.headers.get('swarm-feed-index-next');
    const current = res.headers.get('swarm-feed-index');
    await res.body?.cancel().catch(() => undefined);
    if (next && /^[0-9a-f]{1,16}$/i.test(next)) return BigInt(`0x${next}`);
    if (current && /^[0-9a-f]{1,16}$/i.test(current)) return BigInt(`0x${current}`) + 1n;
    throw new Error('GET /feeds answered without a feed index');
  }
  const err = await failureOf(res, 'GET /feeds');
  if (res.status === 404 && /no update found/i.test(err.message)) return 0n;
  if (res.status !== 404 || !/lookup (at )?failed/i.test(err.message)) throw err;

  const wait = opts.confirmDelayMs ?? 1000;
  const present = async (i: number): Promise<boolean> => {
    const addr = socAddress(feedIdentifier(topic, BigInt(i)), owner).toHex();
    const r = await fetch(`${base}/chunks/${addr}`, { signal: opts.signal });
    if (r.ok) {
      await r.body?.cancel().catch(() => undefined);
      return true;
    }
    const e = await failureOf(r, `GET /chunks (update ${i})`);
    // Bee answers a chunk it does not hold with 404, or 500 "read chunk failed".
    if (e.status === 404 || (e.status === 500 && /read chunk failed|not found/i.test(e.message))) return false;
    throw e;
  };
  for (let i = 0; i < MAX_PROBE; i++) {
    if (await present(i)) continue;
    await new Promise((r) => setTimeout(r, wait));
    if (!(await present(i))) return BigInt(i);
  }
  throw new Error(`the feed lookup fails and ${MAX_PROBE} updates exist: not guessing the next index`);
}

/**
 * What a node says the feed currently points at (`GET /feeds`), or undefined while it has no
 * readable update. Bee 2.x answers with the content the feed points at and names the target
 * reference in the `Etag` header; older nodes answer `{"reference": ...}`. A node that has just
 * received an update may say "not found" for a few seconds (the lookup also asks the network
 * for the next index), so callers poll.
 */
export async function readFeed(
  beeUrl: string,
  owner: EthAddress,
  topic: Topic,
): Promise<{ reference: string; index: string } | undefined> {
  const res = await fetch(`${beeUrl.replace(/\/+$/, '')}/feeds/${owner.toHex()}/${topic.toHex()}`).catch(() => undefined);
  if (!res?.ok) {
    await res?.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const index = res.headers.get('swarm-feed-index') ?? '';
  const etag = (res.headers.get('etag') ?? '').replace(/"/g, '');
  if (/^[0-9a-f]{64}$/i.test(etag)) {
    await res.body?.cancel().catch(() => undefined);
    return { reference: etag.toLowerCase(), index };
  }
  const body = (await res.json().catch(() => ({}))) as { reference?: string };
  return /^[0-9a-f]{64}$/i.test(body.reference ?? '') ? { reference: body.reference!.toLowerCase(), index } : undefined;
}

/** The owner address (and its 0x form) of a feed key. The key itself never leaves this call. */
export function feedOwnerOf(key: Hex): { signer: PrivateKey; owner: EthAddress } {
  const signer = new PrivateKey(key.replace(/^0x/i, ''));
  return { signer, owner: signer.publicKey().address() };
}

/** 64-hex form of a reference. */
export const refHex = (r: Reference | Uint8Array): string => (r instanceof Reference ? r.toHex() : hex(r));

/** One request's time limit in the publish script. */
export const REQUEST_TIMEOUT_MS = 30_000;

export type RetryOptions = {
  /** Attempts in all (default 3). */
  tries?: number;
  /** Wait before the 2nd, 3rd... attempt, in ms; the last value repeats (default 500, 2000). */
  backoffMs?: number[];
  /** Per-attempt time limit (default REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Replaces `isRetryable`: which failures are tried again. */
  retryable?: (e: unknown) => boolean;
  /** Test hook: replaces the real wait. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * False for an answer that will not change on a retry: a 4xx other than 408/425/429 (a bad stamp,
 * a malformed chunk). A missing status (network error, the request timeout) and 5xx are retried.
 */
export function isRetryable(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Runs `fn` with a fresh time-limit signal per attempt; on a retryable failure waits and tries
 * again (3 attempts by default). `fn` must be safe to repeat: the publish script stamps a chunk
 * once and re-sends the same stamp, so a retry never uses another slot of the batch.
 */
export async function retryWithBackoff<T>(
  what: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const tries = opts.tries ?? 3;
  const backoff = opts.backoffMs ?? [500, 2000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(opts.retryable ?? isRetryable)(e)) throw new Error(`${what} failed: ${msg}`);
      if (attempt >= tries) throw new Error(`${what} failed after ${attempt} tries: ${msg}`);
      // The node's Retry-After (when it sent one) is a floor for the wait.
      const asked = (e as { retryAfterMs?: unknown } | null)?.retryAfterMs;
      const own = backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 1000;
      await sleep(typeof asked === 'number' ? Math.max(own, asked) : own);
    }
  }
}

/**
 * Which network a built web app targets, read from its bundle: `defaults.ts` compiles to
 * `return"<VITE_RECALL_NET>"==="local"?"local":"live"`. Undefined when no bundle carries that
 * pattern (a different minifier, or not the Recall app), so a caller can say "cannot tell".
 */
export function builtNetOf(dir: string): 'local' | 'live' | undefined {
  const pattern = /return\s*"(local|live)"\s*===\s*"local"\s*\?\s*"local"\s*:\s*"live"/;
  const walk = (d: string): 'local' | 'live' | undefined => {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) {
        const hit = walk(abs);
        if (hit) return hit;
      } else if (/\.m?js$/.test(name)) {
        const m = pattern.exec(readFileSync(abs, 'utf8'));
        if (m) return m[1] as 'local' | 'live';
      }
    }
    return undefined;
  };
  return walk(dir);
}

/** The first four-hundred-something status of a failure, or undefined (no HTTP status). */
export const isClientError = (e: unknown): boolean => {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
};

// ---- the publish state file (live money) ----------------------------------------------------

export type BatchRecord = {
  /** sent: the buy transaction has a hash, no receipt yet. bought: the batch exists. uploaded: chunks are in. done: verified. */
  status: 'sent' | 'bought' | 'uploaded' | 'done';
  txHash?: Hex;
  batchId?: Hex;
  depth?: number;
  siteRef?: string;
  dir?: string;
  at: string;
};

export type PublishState = {
  batch?: BatchRecord;
  /** The last feed this machine wrote: a different owner or topic later means a different feed address. */
  lastFeed?: { owner: string; topic: string; manifestRef: string; index: string };
};

/**
 * The reason a new batch must not be bought now, or undefined. A batch from an earlier run that
 * was paid for (or whose payment was sent) but never finished may still be unused: resume it
 * instead of paying again. `--new-batch` is the explicit way past this.
 */
export function refuseNewBuy(state: PublishState | undefined, resume: string | undefined): string | undefined {
  const b = state?.batch;
  if (!b || b.status === 'done') return undefined;
  const what =
    b.status === 'sent'
      ? `a batch purchase was sent (tx ${b.txHash ?? 'unknown'}) and may have been mined`
      : `batch ${b.batchId ?? 'unknown'} was bought and not used up (${b.status})`;
  return `${what}; not paying again. ${resume ? `Resume: ${resume}. ` : ''}Pass --new-batch to buy another one anyway.`;
}

/** The command that continues a publish on a batch that is already paid for. */
export function resumeCommand(o: { net: string; batchId: string; dir: string; bee?: string; feedTopic?: string }): string {
  const q = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  return [
    'pnpm publish:swarm',
    `--net ${o.net}`,
    `--batch ${o.batchId}`,
    `--dir ${q(o.dir)}`,
    '--no-wait',
    ...(o.bee ? [`--bee ${q(o.bee)}`] : []),
    ...(o.feedTopic ? [`--feed --feed-topic ${q(o.feedTopic)}`] : []),
  ].join(' ');
}
