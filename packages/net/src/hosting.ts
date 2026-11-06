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
 * The manifest a feed URL points at: one root entry whose metadata names the feed. A node
 * answers `/bzz/<this reference>/` by looking up the feed's newest update and serving what that
 * update points at. It is the same entry Bee's own `POST /feeds` writes, so the reference is
 * the one `bee.feed.createManifest` returns (the local test compares them).
 */
export function feedManifest(owner: EthAddress, topic: Topic): MantarayNode {
  const node = new MantarayNode();
  node.addFork('/', NULL_ADDRESS, {
    'swarm-feed-owner': owner.toHex(),
    'swarm-feed-topic': topic.toHex(),
    'swarm-feed-type': 'Sequence',
  });
  // core-sdk draws a random obfuscation key per node. A feed manifest must come out the same on
  // every run (its reference is the feed's permanent address), so every key is zeros, as in
  // Bee's own manifests.
  const zero = (n: MantarayNode['core']) => {
    n.obfuscationKey = new Uint8Array(32);
    for (const f of n.forks.values()) zero(f.node);
  };
  zero(node.core);
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

/** The index the next update of the feed takes: 0 for a feed that does not exist yet. */
export async function nextFeedIndex(bee: Bee, owner: EthAddress, topic: Topic, signal?: AbortSignal): Promise<bigint> {
  try {
    const latest = await bee.feed.fetchLatestUpdate(topic, owner, signal ? { signal } : undefined);
    return (latest.feedIndexNext ?? latest.feedIndex.next()).toBigInt();
  } catch (e) {
    // The node answers 404 for a feed with no update yet.
    if ((e as { status?: number }).status === 404) return 0n;
    throw e;
  }
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
  /** Wait before the 2nd, 3rd... attempt, in ms (default 500, 2000). */
  backoffMs?: number[];
  /** Per-attempt time limit (default REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
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
      if (!isRetryable(e)) throw new Error(`${what} failed: ${msg}`);
      if (attempt >= tries) throw new Error(`${what} failed after ${attempt} tries: ${msg}`);
      await sleep(backoff[attempt - 1] ?? backoff[backoff.length - 1] ?? 1000);
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
