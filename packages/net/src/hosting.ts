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
 * message says "no update found" means the feed is empty, but a lagging node can say that about
 * a feed that has updates, so it is asked a second time (`confirmDelayMs` later) and only two
 * such answers in a row give 0. Even then 0 is a claim of the node, not a proof: the publish
 * script checks the result against the last index it wrote itself (`feedIndexProblem`).
 *
 * Bee 2.8 answers 404 "lookup at failed" both for an empty feed and for one whose newest update
 * it cannot reach yet (it also asks the network for the index after the newest), so that answer
 * proves nothing: the update chunks are probed instead (`GET /chunks/<soc address of index i>`),
 * and the first index whose chunk is missing twice in a row is the next one. Anything else
 * (another 404, a 5xx, a network error) throws, and the caller retries or stops: guessing 0 for
 * a feed that has updates would try to overwrite one.
 */
export async function nextFeedIndex(
  beeUrl: string,
  owner: EthAddress,
  topic: Topic,
  opts: { signal?: AbortSignal; confirmDelayMs?: number } = {},
): Promise<bigint> {
  const base = beeUrl.replace(/\/+$/, '');
  const wait = opts.confirmDelayMs ?? 1000;
  const pause = () => new Promise((r) => setTimeout(r, wait));
  type Look = { kind: 'next'; next: bigint } | { kind: 'empty' } | { kind: 'unclear' };
  const look = async (): Promise<Look> => {
    const res = await fetch(`${base}/feeds/${owner.toHex()}/${topic.toHex()}`, { signal: opts.signal });
    if (res.ok) {
      const next = res.headers.get('swarm-feed-index-next');
      const current = res.headers.get('swarm-feed-index');
      await res.body?.cancel().catch(() => undefined);
      if (next && /^[0-9a-f]{1,16}$/i.test(next)) return { kind: 'next', next: BigInt(`0x${next}`) };
      if (current && /^[0-9a-f]{1,16}$/i.test(current)) return { kind: 'next', next: BigInt(`0x${current}`) + 1n };
      throw new Error('GET /feeds answered without a feed index');
    }
    const err = await failureOf(res, 'GET /feeds');
    if (res.status === 404 && /no update found/i.test(err.message)) return { kind: 'empty' };
    if (res.status === 404 && /lookup (at )?failed/i.test(err.message)) return { kind: 'unclear' };
    throw err;
  };

  let first = await look();
  if (first.kind === 'empty') {
    await pause();
    first = await look();
    if (first.kind === 'empty') return 0n;
  }
  if (first.kind === 'next') return first.next;

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
    await pause();
    if (!(await present(i))) return BigInt(i);
  }
  throw new Error(`the feed lookup fails and ${MAX_PROBE} updates exist: not guessing the next index`);
}

/**
 * Why `index` must not be the next feed update, or undefined. The index never goes down and is
 * never reused: it must not be lower than what this run read before it bought anything, and (when
 * the state file remembers the last update this machine wrote for the same owner and topic) it
 * must be above that one. This is the out-of-band memory that a lagging node cannot fake.
 */
export function feedIndexProblem(o: {
  index: bigint;
  /** What the preflight read, when this check runs again right before the push. */
  preIndex?: bigint;
  last?: PublishState['lastFeed'];
  owner: string;
  topic: string;
}): string | undefined {
  if (o.preIndex !== undefined && o.index < o.preIndex) {
    return `the feed's next index is ${o.index} now, but it was ${o.preIndex} before: a node that lags behind. The index never goes down; not pushing`;
  }
  const l = o.last;
  if (l && l.topic === o.topic && l.owner.toLowerCase() === o.owner.toLowerCase() && /^\d+$/.test(l.index)) {
    const mustBeAtLeast = BigInt(l.index) + 1n;
    if (o.index < mustBeAtLeast) {
      return `this machine already wrote update ${l.index} of the feed (owner ${l.owner}, topic "${l.topic}"), but the node says the next index is ${o.index}: it lags or lost the update. Reusing an index would try to overwrite an update. Wait and retry, or ask another node`;
    }
  }
  return undefined;
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
  const res = await fetch(`${beeUrl.replace(/\/+$/, '')}/feeds/${owner.toHex()}/${topic.toHex()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
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
 * instead of paying again. `--new-batch` is the explicit way past this. `resume` is the command
 * for the recorded batch; for a purchase that was only sent there is no batch id yet.
 */
export function refuseNewBuy(state: PublishState | undefined, resume: string | undefined): string | undefined {
  const b = state?.batch;
  if (!b || b.status === 'done') return undefined;
  if (b.status === 'sent' && !b.batchId) {
    return `a batch purchase was sent (tx ${b.txHash ?? 'unknown'}) and may have been mined; not paying again. Find its batch id from tx ${b.txHash ?? '(see the state file)'} on gnosisscan (the BatchCreated event), then resume with --batch <id>${b.dir ? ` --dir ${b.dir}` : ''} --no-wait. Pass --new-batch to buy another one anyway.`;
  }
  const what = `batch ${b.batchId ?? 'unknown'} was bought and not used up (${b.status})`;
  return `${what}; not paying again. ${resume ? `Resume: ${resume}. ` : ''}Pass --new-batch to buy another one anyway.`;
}

/**
 * The state after `b` is recorded. A purchase that has just been SENT is a new batch: nothing of
 * an earlier record carries over (its batch id would otherwise sit next to the new transaction
 * and a later resume hint could name an old, used batch). Later records of the same run
 * (`bought`, `uploaded`, `done`) merge into it, unless they name a different batch id, which
 * starts a fresh record too.
 */
export function recordBatch(state: PublishState, b: BatchRecord): PublishState {
  if (b.status === 'sent') return { ...state, batch: b };
  const prev = state.batch;
  const sameBatch = prev !== undefined && (b.batchId === undefined || prev.batchId === undefined || prev.batchId === b.batchId);
  return { ...state, batch: sameBatch ? { ...prev, ...b } : b };
}

/** The state after a feed update was sent: the index this machine has used (it never goes back). */
export function recordFeed(state: PublishState, f: { owner: string; topic: string; manifestRef: string; index: bigint }): PublishState {
  return { ...state, lastFeed: { owner: f.owner, topic: f.topic, manifestRef: f.manifestRef, index: String(f.index) } };
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

// ---- reading the published site back ----------------------------------------------------------

/**
 * True for a redirect to a gateway's moderation page (`https://bzz.link/forbidden?hash=<ref>`):
 * api.gateway.ethswarm.org and bzz.link answer HTML of a hash that is not allowlisted that way,
 * while the bytes themselves are fine and served by download.gateway.ethswarm.org.
 */
export function isModerationRedirect(status: number, location: string | null | undefined): boolean {
  return status >= 300 && status < 400 && /\/forbidden(?:[/?#]|$)/i.test(location ?? '');
}

export type ReadVerdict = 'verified' | 'mismatch' | 'moderated' | 'unreachable';
export type ReadResult = { gateway: string; url: string; verdict: ReadVerdict; detail: string };

/**
 * Fetches `url` once and compares it to `want`. A redirect is looked at before it is followed
 * (`redirect: 'manual'`): one to a moderation page is `moderated`, never "other bytes"; another
 * redirect is followed (at most 3 hops). A bad status or a network error is `unreachable`.
 */
export async function readOnce(url: string, want: Uint8Array, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ verdict: ReadVerdict; detail: string }> {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }).catch((e: Error) => e);
    if (res instanceof Error) return { verdict: 'unreachable', detail: res.message };
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (isModerationRedirect(res.status, location)) return { verdict: 'moderated', detail: `HTTP ${res.status} to ${location}` };
      if (!location) return { verdict: 'unreachable', detail: `HTTP ${res.status} without a Location` };
      target = new URL(location, target).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { verdict: 'unreachable', detail: `HTTP ${res.status}` };
    }
    const got = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    return got.equals(Buffer.from(want))
      ? { verdict: 'verified', detail: `${got.length} bytes` }
      : { verdict: 'mismatch', detail: `${got.length} bytes, expected ${want.length}` };
  }
  return { verdict: 'unreachable', detail: 'too many redirects' };
}

/**
 * What the read-back results of one file add up to. Verified by ANY read gateway is verified
 * (the others only warn: a moderated page is "held by gateway moderation (needs allowlisting)",
 * not "other bytes"). With no gateway verifying it: other bytes are an error, a moderation hold
 * is an error (the bytes could not be checked anywhere), and plain unreachable is an error
 * locally but only "unconfirmed" (gateway lag) when `lagTolerant`.
 */
export function judgeReadBack(
  label: string,
  results: ReadResult[],
  lagTolerant: boolean,
): { verified: ReadResult | undefined; error?: string; unconfirmed?: string; warnings: string[] } {
  const verified = results.find((r) => r.verdict === 'verified');
  const warnings = results
    .filter((r) => r.verdict !== 'verified')
    .map((r) =>
      r.verdict === 'moderated'
        ? `${label}: held by gateway moderation (needs allowlisting) at ${r.url} (${r.detail})`
        : r.verdict === 'mismatch'
          ? `${label}: ${r.url} served other bytes (${r.detail})`
          : `${label}: ${r.url} did not answer with the file (${r.detail})`,
    );
  if (verified) return { verified, warnings };
  const where = results.map((r) => r.gateway).join(', ');
  const mismatch = results.find((r) => r.verdict === 'mismatch');
  if (mismatch) {
    return { verified: undefined, error: `${label}: ${mismatch.url} served other bytes than the local file (${mismatch.detail}); no read gateway verified them`, warnings };
  }
  if (results.some((r) => r.verdict === 'moderated')) {
    return { verified: undefined, error: `${label}: held by gateway moderation (needs allowlisting) at ${where}; no read gateway verified the bytes`, warnings };
  }
  const why = `${label}: not reachable through ${where}`;
  return lagTolerant ? { verified: undefined, unconfirmed: why, warnings } : { verified: undefined, error: why, warnings };
}
