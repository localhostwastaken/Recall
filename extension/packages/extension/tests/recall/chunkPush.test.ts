// The parallel stamped upload of a repository snapshot (R46): bounded concurrency, every chunk
// stamped once and pushed once, retries re-send the same stamp, the root goes last.
import { describe, expect, it } from 'vitest';
import { Stamper } from '@ethersphere/bee-js';
import { generatePrivateKey } from 'viem/accounts';
import { swarmRootOf } from '@recall/net/swarm';
import { PushError, retryablePush, uploadStampedConcurrent, type PushFn } from '../../src/recall/chunkPush';

const BATCH = '7'.repeat(64);
/** Deterministic, non-repeating test bytes (a small LCG). */
function bytesOf(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function counting(stamper: Stamper) {
  let stamps = 0;
  return {
    stamper: {
      stamp(a: Uint8Array) {
        stamps++;
        return stamper.stamp(a);
      },
    },
    stamps: () => stamps,
  };
}

describe('uploadStampedConcurrent', () => {
  it('keeps at most 12 pushes in flight and pushes every chunk exactly once, root last', async () => {
    const data = bytesOf(4096 * 120 + 17); // 121 data chunks + intermediates + root
    const s = counting(Stamper.fromBlank(generatePrivateKey().slice(2), BATCH, 18));
    let inFlight = 0;
    let peak = 0;
    const pushed: string[] = [];
    const push: PushFn = async (_url, _stamp, chunk) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      pushed.push(Buffer.from(chunk).toString('hex'));
      inFlight--;
    };
    const progress: number[] = [];
    const ref = await uploadStampedConcurrent(data, {
      uploadUrl: 'http://bee',
      stamper: s.stamper,
      push,
      onProgress: (done) => progress.push(done),
    });
    expect(ref).toBe(`0x${await swarmRootOf(data)}`);
    expect(peak).toBeLessThanOrEqual(12);
    expect(peak).toBeGreaterThan(1);
    expect(new Set(pushed).size).toBe(pushed.length); // no chunk twice
    expect(s.stamps()).toBe(pushed.length); // one stamp per chunk
    expect(progress.at(-1)).toBe(pushed.length);
  });

  it('retries with the same stamp (no new slot), honours Retry-After, and retries a 4xx before the first success', async () => {
    const data = bytesOf(4096 * 5);
    const s = counting(Stamper.fromBlank(generatePrivateKey().slice(2), BATCH, 18));
    const seen = new Map<string, string[]>();
    let calls = 0;
    const waits: number[] = [];
    const push: PushFn = async (_url, stamp, chunk) => {
      const k = Buffer.from(chunk).toString('hex');
      seen.set(k, [...(seen.get(k) ?? []), stamp]);
      calls++;
      if (calls === 1) throw new PushError('POST /chunks: HTTP 402', 402); // fresh batch, before any success
      if (calls === 3) throw new PushError('POST /chunks: HTTP 429', 429, 3_000);
    };
    await uploadStampedConcurrent(data, {
      uploadUrl: 'http://bee',
      stamper: s.stamper,
      push,
      concurrency: 1,
      sleep: async (ms) => void waits.push(ms),
    });
    for (const stamps of seen.values()) expect(new Set(stamps).size).toBe(1);
    expect(s.stamps()).toBe(seen.size);
    expect(waits).toContain(3_000);
  });

  it('a 4xx after chunks were accepted stops the upload with that status, stamping nothing further', async () => {
    const data = bytesOf(4096 * 40);
    const s = counting(Stamper.fromBlank(generatePrivateKey().slice(2), BATCH, 18));
    let calls = 0;
    const push: PushFn = async () => {
      if (++calls === 5) throw new PushError('POST /chunks: HTTP 400', 400);
    };
    await expect(
      uploadStampedConcurrent(data, { uploadUrl: 'http://bee', stamper: s.stamper, push, concurrency: 2 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(s.stamps()).toBeLessThan(10);
  });

  it('retry policy', () => {
    expect(retryablePush(new PushError('x', 400), false)).toBe(true);
    expect(retryablePush(new PushError('x', 400), true)).toBe(false);
    expect(retryablePush(new PushError('x', 429), true)).toBe(true);
    expect(retryablePush(new PushError('x', 503), true)).toBe(true);
    expect(retryablePush(new Error('network'), true)).toBe(true);
  });
});

describe('identical chunks', () => {
  it('are stamped and pushed once', async () => {
    const data = new Uint8Array(4096 * 10); // ten identical zero chunks
    const s = counting(Stamper.fromBlank(generatePrivateKey().slice(2), BATCH, 18));
    const pushed: string[] = [];
    const ref = await uploadStampedConcurrent(data, {
      uploadUrl: 'http://bee',
      stamper: s.stamper,
      push: async (_u, _s, c) => void pushed.push(Buffer.from(c).toString('hex')),
    });
    expect(ref).toBe(`0x${await swarmRootOf(data)}`);
    expect(new Set(pushed).size).toBe(pushed.length);
    expect(s.stamps()).toBe(pushed.length);
  });
});
