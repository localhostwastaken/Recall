import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import {
  builtNetOf,
  feedIdentifier,
  feedManifest,
  feedOwnerOf,
  feedTopic,
  feedUpdate,
  isRetryable,
  retryWithBackoff,
  socAddress,
} from '../src/hosting';

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
