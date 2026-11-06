import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createWalletClient, custom, encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import {
  Bee,
  DEFAULT_FEED_TOPIC,
  HttpError,
  builtNetOf,
  feedIdentifier,
  feedManifest,
  feedOwnerOf,
  feedTopic,
  feedUpdate,
  isClientError,
  isRetryable,
  nextFeedIndex,
  parseRetryAfter,
  pushChunk,
  pushFeedUpdate,
  refuseNewBuy,
  resumeCommand,
  retryWithBackoff,
  socAddress,
  type PublishState,
} from '../src/hosting';
import { QUOTE_TOLERANCE_PERCENT, Stamper, buyBatch } from '../src/index';

// Public, worthless test key (the first Hardhat account).
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const noWait = async () => undefined;

describe('retryWithBackoff', () => {
  it('retries a failing call and returns the first success', async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await retryWithBackoff(
      'push',
      async () => {
        if (++calls < 3) throw new Error('connection reset');
        return 'ok';
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 2000]); // backoff grows between the tries
  });

  it('gives up after three tries and says so', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        'push of chunk ab12',
        async () => {
          calls++;
          throw new Error('boom');
        },
        { sleep: noWait },
      ),
    ).rejects.toThrow('push of chunk ab12 failed after 3 tries: boom');
    expect(calls).toBe(3);
  });

  it('does not repeat an answer that cannot change (4xx), but does repeat 429 and 5xx', async () => {
    const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
    expect(isRetryable(http(400))).toBe(false);
    expect(isRetryable(http(402))).toBe(false);
    expect(isRetryable(http(404))).toBe(false);
    expect(isRetryable(http(429))).toBe(true);
    expect(isRetryable(http(503))).toBe(true);
    expect(isRetryable(new Error('fetch failed'))).toBe(true); // no status: network trouble
    let calls = 0;
    await expect(
      retryWithBackoff(
        'push',
        async () => {
          calls++;
          throw http(400);
        },
        { sleep: noWait },
      ),
    ).rejects.toThrow('push failed: HTTP 400');
    expect(calls).toBe(1);
  });

  it('gives every attempt a fresh time limit and treats a timeout as a failure to retry', async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const out = await retryWithBackoff(
      'push',
      (signal) => {
        signals.push(signal);
        if (++calls === 1) {
          // A hung request: only the time limit ends it.
          return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Request aborted'))));
        }
        return Promise.resolve('ok');
      },
      { timeoutMs: 30, sleep: noWait },
    );
    expect(out).toBe('ok');
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0].aborted).toBe(true);
  });
});

describe('feed helpers', () => {
  const { owner } = feedOwnerOf(KEY);
  const topic = feedTopic('recall-test');

  it('derives the update identifier and chunk address the way Bee does', () => {
    const index0 = new Uint8Array(8);
    const index1 = new Uint8Array(8);
    index1[7] = 1;
    const id0 = keccak256(Buffer.concat([topic.toUint8Array(), index0]), 'bytes');
    expect(hex(feedIdentifier(topic, 0n).toUint8Array())).toBe(hex(id0));
    expect(hex(feedIdentifier(topic, 1n).toUint8Array())).toBe(
      hex(keccak256(Buffer.concat([topic.toUint8Array(), index1]), 'bytes')),
    );
    const address = keccak256(Buffer.concat([id0, owner.toUint8Array()]), 'bytes');
    expect(hex(socAddress(feedIdentifier(topic, 0n), owner).toUint8Array())).toBe(hex(address));
  });

  it('lays an update out as timestamp then reference', () => {
    const reference = new Uint8Array(32).fill(0xab);
    const u = feedUpdate(owner, topic, 3n, reference, 1_700_000_000);
    expect(u.index).toBe(3n);
    expect(u.payload).toHaveLength(40);
    expect(new DataView(u.payload.buffer, u.payload.byteOffset).getBigUint64(0, false)).toBe(1_700_000_000n);
    expect(hex(u.payload.subarray(8))).toBe('ab'.repeat(32));
    expect(() => feedUpdate(owner, topic, 0n, new Uint8Array(31))).toThrow('32-byte');
  });

  it('builds a feed manifest that is the same on every run (its reference is the feed address)', async () => {
    const refOf = async (t: ReturnType<typeof feedTopic>) => {
      const { reference } = await feedManifest(owner, t).core.saveRecursively(async () => undefined);
      return hex(reference);
    };
    const a = await refOf(topic);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await refOf(topic)).toBe(a);
    expect(await refOf(feedTopic('another'))).not.toBe(a);
  });
});

describe('builtNetOf', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const site = (js: string | undefined): string => {
    const d = mkdtempSync(join(tmpdir(), 'recall-built-'));
    dirs.push(d);
    writeFileSync(join(d, 'index.html'), '<html></html>');
    if (js !== undefined) {
      mkdirSync(join(d, 'assets'));
      writeFileSync(join(d, 'assets', 'index-abc.js'), js);
    }
    return d;
  };

  it('reads the network a bundle was built for', () => {
    expect(builtNetOf(site('x();function Bx(){return"live"==="local"?"local":"live"}y()'))).toBe('live');
    expect(builtNetOf(site('function Bx(){return"local"==="local"?"local":"live"}'))).toBe('local');
  });

  it('says nothing when the bundle does not show it', () => {
    expect(builtNetOf(site('console.log(1)'))).toBeUndefined();
    expect(builtNetOf(site(undefined))).toBeUndefined();
  });
});

// ---- throwaway HTTP node ------------------------------------------------------------------
type Req = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer };
type Reply = { status: number; body?: string; headers?: Record<string, string> };
const servers: Server[] = [];
afterEach(() => {
  for (const sv of servers.splice(0)) sv.close();
});
async function node(handler: (r: Req) => Reply): Promise<{ url: string; seen: Req[] }> {
  const seen: Req[] = [];
  const sv = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const r: Req = { method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers, body: Buffer.concat(parts) };
      seen.push(r);
      const reply = handler(r);
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.body ?? '');
    });
  });
  servers.push(sv);
  await new Promise<void>((r) => sv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(sv.address() as AddressInfo).port}`, seen };
}
const json = (status: number, message: string): Reply => ({ status, body: JSON.stringify({ code: status, message }) });

describe('nextFeedIndex', () => {
  const { owner } = feedOwnerOf(KEY);
  const topic = feedTopic('probe-test');
  const chunkOf = (i: number) => socAddress(feedIdentifier(topic, BigInt(i)), owner).toHex();
  const lookup = (r: Req) => r.url.startsWith('/feeds/');
  const opts = { confirmDelayMs: 0 };

  it('takes the node\'s answer when the lookup works', async () => {
    const n = await node(() => ({ status: 200, headers: { 'swarm-feed-index': '0000000000000002', 'swarm-feed-index-next': '0000000000000003' } }));
    expect(await nextFeedIndex(n.url, owner, topic, opts)).toBe(3n);
    expect(n.seen).toHaveLength(1);
  });

  it('accepts a 404 only as "no update found" for an empty feed, without probing', async () => {
    const n = await node(() => json(404, 'no update found'));
    expect(await nextFeedIndex(n.url, owner, topic, opts)).toBe(0n);
    expect(n.seen).toHaveLength(1);
  });

  it('refuses any other 404 and a 500 instead of guessing 0', async () => {
    const other = await node(() => json(404, 'feed not found'));
    await expect(nextFeedIndex(other.url, owner, topic, opts)).rejects.toMatchObject({ status: 404 });
    const broken = await node(() => json(500, 'internal error'));
    await expect(nextFeedIndex(broken.url, owner, topic, opts)).rejects.toBeInstanceOf(HttpError);
    await expect(nextFeedIndex(broken.url, owner, topic, opts)).rejects.toMatchObject({ status: 500 });
    expect(other.seen).toHaveLength(1); // no probing after a message that is not the ambiguous one
  });

  it('probes the update chunks when Bee 2.8 answers "lookup at failed", and stops at the first missing index', async () => {
    const have = new Set([chunkOf(0), chunkOf(1)]);
    const n = await node((r) => {
      if (lookup(r)) return json(404, 'lookup at failed');
      const addr = r.url.replace('/chunks/', '');
      return have.has(addr) ? { status: 200, body: 'chunk' } : json(500, 'read chunk failed');
    });
    expect(await nextFeedIndex(n.url, owner, topic, opts)).toBe(2n);
  });

  it('does not take a lagging node\'s single miss for an empty feed: a second look must agree', async () => {
    let asked0 = 0;
    const n = await node((r) => {
      if (lookup(r)) return json(404, 'lookup at failed');
      const addr = r.url.replace('/chunks/', '');
      if (addr === chunkOf(0)) return ++asked0 === 1 ? json(500, 'read chunk failed') : { status: 200, body: 'chunk' }; // arrives late
      return json(500, 'read chunk failed');
    });
    expect(await nextFeedIndex(n.url, owner, topic, opts)).toBe(1n);
    expect(asked0).toBe(2);
  });

  it('an empty feed is index 0 once both looks miss', async () => {
    const n = await node((r) => (lookup(r) ? json(404, 'lookup at failed') : json(500, 'read chunk failed')));
    expect(await nextFeedIndex(n.url, owner, topic, opts)).toBe(0n);
  });

  it('throws when the probe itself gets a node error', async () => {
    const n = await node((r) => (lookup(r) ? json(404, 'lookup at failed') : json(503, 'busy')));
    await expect(nextFeedIndex(n.url, owner, topic, opts)).rejects.toMatchObject({ status: 503 });
  });
});

describe('pushChunk and retry policy', () => {
  it('sends the stamp as the swarm-postage-stamp header, and a failure carries Retry-After', async () => {
    const stamper = Stamper.fromBlank(KEY, `0x${'cd'.repeat(32)}`, 17);
    const chunk = new Uint8Array(8 + 5);
    const envelope = stamper.stamp(new Uint8Array(32).fill(7));
    const ok = await node(() => ({ status: 201, body: '{"reference":"' + '00'.repeat(32) + '"}' }));
    await pushChunk(ok.url, envelope, chunk);
    expect(ok.seen[0].method).toBe('POST');
    expect(ok.seen[0].url).toBe('/chunks');
    expect(ok.seen[0].headers['swarm-postage-stamp']).toMatch(/^[0-9a-f]{226}$/); // batch 32 + index 8 + ts 8 + sig 65 bytes
    expect(ok.seen[0].headers['swarm-deferred-upload']).toBe('false');
    expect(ok.seen[0].body).toHaveLength(chunk.length);

    const busy = await node(() => ({ status: 429, headers: { 'retry-after': '7' }, body: '{"message":"slow down"}' }));
    const err = await pushChunk(busy.url, envelope, chunk).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 7000 });
  });

  it('honours Retry-After as a floor for the wait, and a custom retryable rule', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await retryWithBackoff(
      'push',
      async () => {
        if (++calls === 1) throw new HttpError('HTTP 429', 429, 7000);
        if (calls === 2) throw new HttpError('HTTP 400 invalid stamp', 400); // a fresh batch the gateway does not know yet
        return 'ok';
      },
      {
        tries: 6,
        backoffMs: [1000, 2000, 4000],
        sleep: async (ms) => void waits.push(ms),
        retryable: (e) => isRetryable(e) || isClientError(e),
      },
    );
    expect(out).toBe('ok');
    expect(waits).toEqual([7000, 2000]); // Retry-After beats the 1 s backoff; the 2 s backoff beats nothing
  });

  it('parses Retry-After in seconds and as a date, capped at a minute', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('9999')).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())!).toBeGreaterThan(3000);
  });
});

describe('the feed update is what bee-js makeFeedWriter().uploadReference sends', () => {
  it('same request path, signature and body for the same owner, topic, index, time and reference', async () => {
    const { signer, owner } = feedOwnerOf(KEY);
    const topic = feedTopic(DEFAULT_FEED_TOPIC);
    const reference = new Uint8Array(32).fill(0x5a);
    const at = 1_700_000_000;
    const batch = `0x${'ab'.repeat(32)}`;
    const reply = (): Reply => ({ status: 201, body: `{"reference":"${'00'.repeat(32)}"}` });

    const theirs = await node(reply);
    await new Bee(theirs.url).feed.makeWriter(topic, signer).uploadReference(batch, reference, { at, index: 4 });
    const mine = await node(reply);
    const update = feedUpdate(owner, topic, 4n, reference, at);
    const envelope = Stamper.fromBlank(KEY, batch as Hex, 17).stamp(update.address.toUint8Array());
    await pushFeedUpdate(new Bee(mine.url), signer, envelope, update);

    const [a, b] = [theirs.seen[0], mine.seen[0]];
    expect(a.method).toBe('POST');
    expect(b.url).toBe(a.url); // /soc/<owner>/<identifier>?sig=<signature>
    expect(b.body.equals(a.body)).toBe(true); // span + timestamp + reference
    expect(b.headers['swarm-postage-stamp']).toBeDefined(); // client-made stamp instead of a batch id
    expect(a.headers['swarm-postage-batch-id']).toBe(batch.slice(2));
  });

  it('uses the topic the Swarm docs use by default', () => {
    expect(DEFAULT_FEED_TOPIC).toBe('website');
    expect(feedTopic(DEFAULT_FEED_TOPIC).toHex()).toBe(keccak256(toHex('website')).slice(2));
  });
});

describe('the live purchase safety rails', () => {
  const batch = (over: Partial<NonNullable<PublishState['batch']>>): PublishState => ({
    batch: { status: 'bought', batchId: `0x${'ab'.repeat(32)}`, dir: '/site dir', at: '2026-11-06T00:00:00Z', ...over },
  });

  it('refuses a second purchase while a paid-for batch is unfinished, and tells how to resume', () => {
    const resume = resumeCommand({ net: 'live', batchId: `0x${'ab'.repeat(32)}`, dir: '/site dir', feedTopic: 'website' });
    expect(resume).toBe(`pnpm publish:swarm --net live --batch 0x${'ab'.repeat(32)} --dir '/site dir' --no-wait --feed --feed-topic website`);
    for (const status of ['sent', 'bought', 'uploaded'] as const) {
      const why = refuseNewBuy(batch({ status, txHash: '0x12' }), resume);
      expect(why, status).toContain('not paying again');
      expect(why).toContain('--new-batch');
      expect(why).toContain(resume);
    }
    expect(refuseNewBuy(batch({ status: 'sent', txHash: '0x12' }), undefined)).toContain('0x12');
  });

  it('allows a purchase after a finished publish or with no record', () => {
    expect(refuseNewBuy(batch({ status: 'done' }), undefined)).toBeUndefined();
    expect(refuseNewBuy({}, undefined)).toBeUndefined();
    expect(refuseNewBuy(undefined, undefined)).toBeUndefined();
  });

  it('isClientError is true only for a 4xx status', () => {
    expect(isClientError(new HttpError('x', 402))).toBe(true);
    expect(isClientError(new HttpError('x', 503))).toBe(false);
    expect(isClientError(new Error('network'))).toBe(false);
  });

  // buyBatch re-reads the price: a re-quote more than 10% above what the person was shown sends nothing.
  const priceNode = (price: bigint) => {
    const methods: string[] = [];
    const wallet = createWalletClient({
      account: privateKeyToAccount(KEY),
      chain: gnosis,
      transport: custom({
        async request({ method }: { method: string }) {
          methods.push(method);
          if (method === 'eth_call') return encodeAbiParameters([{ type: 'uint64' }], [price]); // lastPrice()
          throw new Error(`stop: ${method}`);
        },
      }),
    });
    return { wallet, methods };
  };
  const total = (price: bigint, days: number, depth: number) => (price * BigInt(17280 * days) + 1n) * 2n ** BigInt(depth);

  it('buyBatch aborts when the price rose more than the tolerance, before any transaction', async () => {
    expect(QUOTE_TOLERANCE_PERCENT).toBe(10n);
    const { wallet, methods } = priceNode(1000n);
    const now = total(1000n, 30, 18);
    const quoted = (now * 100n) / 111n; // the price now is 111% of the quote
    await expect(buyBatch(wallet, { owner: wallet.account!.address, depth: 18, days: 30, quotedTotal: quoted })).rejects.toThrow(
      /price rose.*nothing was sent/,
    );
    expect(methods.every((m) => m === 'eth_call')).toBe(true);
  });

  it('buyBatch goes on when the price is within the tolerance (it reaches the approval)', async () => {
    const { wallet, methods } = priceNode(1000n);
    const quoted = (total(1000n, 30, 18) * 100n) / 105n; // 105% of the quote
    const err = await buyBatch(wallet, { owner: wallet.account!.address, depth: 18, days: 30, quotedTotal: quoted }).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/price rose/);
    expect(methods.some((m) => m !== 'eth_call')).toBe(true); // it moved on to sending the approval
  });
});
