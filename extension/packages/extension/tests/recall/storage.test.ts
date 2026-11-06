// Stamp key, batch pool, pending records and the upload that follows a capture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpRequestError,
  RpcRequestError,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { encodeEvidence, type EvidenceFile } from '@recall/evidence';
import { STAMP_KEY, stampAddress, stampKey, type KeyArea } from '../../src/recall/stamp';
import {
  MIN_BATCH_TTL_SECONDS,
  POOL_KEY,
  decodeStamperState,
  encodeStamperState,
  mergeStamperStates,
  parsePool,
  poolView,
  storageState,
  unusedBatches,
  type PoolBatch,
} from '../../src/recall/poolState';
import {
  addBatches,
  applyBatchUpdates,
  batchProblem,
  clearRefusedCache,
  parseBatchIds,
  type BatchInfo,
} from '../../src/recall/pool';
import {
  PENDING_PREFIX,
  PUBLISHED_PREFIX,
  markPublished,
  discardPending,
  newCaptureId,
  prunePending,
  readPending,
  savePending,
  type PendingRecord,
} from '../../src/recall/pending';
import { canonicalEvidence, uploadGate, type OffscreenUpload } from '../../src/recall/uploadParts';
import { postageAbi, ttlSeconds } from '../../src/recall/batchChain';
import { failureKind, pickUsable, ttlReader, uploadEvidence } from '../../src/recall/swarmUpload';
import {
  CAPTURE_HELPER,
  captureHelper,
  jobSteps,
  storageNotice,
  uploadCopy,
} from '../../src/recall/captureView';
import type { CheckSummary } from '../../src/recall/jobState';

/** An in-memory chrome.storage area (`get(null)` reads everything). */
function memArea(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: vi.fn(async (k: string | null) =>
      k === null ? { ...data } : k in data ? { [k]: data[k] } : {},
    ),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
    remove: vi.fn(async (k: string | string[]) => {
      for (const key of Array.isArray(k) ? k : [k]) delete data[key];
    }),
  };
}

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const DAY = 86_400n;

describe('stamp key', () => {
  it('is created once, stored, and stable', async () => {
    const area = memArea();
    const [a, b] = await Promise.all([stampKey(area), stampKey(area)]);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(area.set).toHaveBeenCalledTimes(1);
    expect(area.data[STAMP_KEY]).toBe(a);
    expect(await stampAddress(area)).toBe(privateKeyToAddress(a));
  });

  it('reads an existing key and never replaces a malformed one', async () => {
    const key = generatePrivateKey();
    expect(await stampKey(memArea({ [STAMP_KEY]: key }))).toBe(key);
    const broken = memArea({ [STAMP_KEY]: 'nope' });
    await expect(stampKey(broken)).rejects.toThrow(/malformed/);
    expect(broken.data[STAMP_KEY]).toBe('nope');
    expect(broken.set).not.toHaveBeenCalled();
  });

  it('retries after a failed read', async () => {
    const area: KeyArea = {
      get: vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue({}),
      set: vi.fn(async () => undefined),
    };
    await expect(stampKey(area)).rejects.toThrow('busy');
    await expect(stampKey(area)).resolves.toMatch(/^0x[0-9a-f]{64}$/);
  });
});

const batch = (n: number, over: Partial<PoolBatch> = {}): PoolBatch => ({
  batchId: id(n),
  depth: 17,
  used: false,
  usable: false,
  startBlock: '10',
  addedAt: n,
  ...over,
});

describe('pool state', () => {
  it('round-trips sparse stamper state and merges by the highest bucket', () => {
    const buckets = new Uint32Array(65536);
    buckets[3] = 1;
    buckets[65535] = 2;
    const state = encodeStamperState(buckets);
    expect(state).toEqual([
      [3, 1],
      [65535, 2],
    ]);
    expect(decodeStamperState(state)).toEqual(buckets);
    expect(decodeStamperState(undefined)).toEqual(new Uint32Array(65536));
    expect(
      mergeStamperStates(
        [
          [3, 2],
          [9, 1],
        ],
        [
          [3, 1],
          [5, 1],
        ],
      ),
    ).toEqual([
      [3, 2],
      [5, 1],
      [9, 1],
    ]);
  });

  it('drops malformed stored batches; lists live unused ones in queue order', () => {
    const pool = parsePool([
      batch(1, { addedAt: 30 }),
      batch(2, { addedAt: 10, queuedAt: 40 }),
      batch(3, { used: true }),
      batch(7, { dead: 'batch expired' }),
      { ...batch(4), depth: 20 },
      { ...batch(5), batchId: '0x12' },
      { ...batch(6, { addedAt: 20 }), stamper: [[70000, 1]] },
      null,
    ]);
    expect(pool.map((b) => b.batchId)).toEqual([id(1), id(2), id(3), id(7), id(6)]);
    expect(pool[4].stamper).toBeUndefined();
    // Dead and used never; a demoted batch goes behind the others.
    expect(unusedBatches(pool).map((b) => b.batchId)).toEqual([id(6), id(1), id(2)]);
    expect(poolView(pool).find((b) => b.batchId === id(7))).toEqual({
      batchId: id(7),
      used: false,
      usable: false,
      dead: true,
    });
    expect(parsePool('nope')).toEqual([]);
  });

  it('tells ok, expired and empty storage apart', () => {
    expect(storageState([batch(1), batch(2, { dead: 'x' })])).toBe('ok');
    expect(storageState([batch(1, { used: true }), batch(2, { dead: 'x' })])).toBe('expired');
    expect(storageState([batch(1, { used: true })])).toBe('empty');
    expect(storageState([])).toBe('empty');
  });
});

describe('batch ids and checks', () => {
  beforeEach(() => clearRefusedCache());

  it('accepts only 0x + 64 hex, lower-cased and deduplicated', () => {
    expect(parseBatchIds([id(1).toUpperCase().replace('0X', '0x'), id(1)])).toEqual([id(1)]);
    expect(parseBatchIds([])).toEqual([]);
    expect(parseBatchIds('x')).toEqual({ error: expect.stringMatching(/list of batch ids/) });
    expect(parseBatchIds(['0x12'])).toEqual({ error: expect.stringMatching(/not a batch id/) });
    expect(parseBatchIds(Array.from({ length: 51 }, (_, i) => id(i)))).toEqual({
      error: expect.stringMatching(/at most 50/),
    });
  });

  const stamp = privateKeyToAddress(generatePrivateKey());
  const good: BatchInfo = {
    owner: stamp,
    depth: 17,
    bucketDepth: 16,
    immutable: true,
    startBlock: 100n,
    ttlSeconds: 7n * DAY,
  };

  it('names the reason a batch is refused (R27), including too little time left', () => {
    expect(batchProblem(good, stamp)).toBeNull();
    expect(batchProblem({ ...good, depth: 18 }, stamp)).toBeNull();
    expect(batchProblem({ ...good, ttlSeconds: MIN_BATCH_TTL_SECONDS }, stamp)).toBeNull();
    expect(batchProblem(null, stamp)).toMatch(/not found/);
    expect(
      batchProblem({ ...good, owner: privateKeyToAddress(generatePrivateKey()) }, stamp),
    ).toMatch(/owner/);
    expect(batchProblem({ ...good, depth: 20 }, stamp)).toMatch(/depth 20/);
    expect(batchProblem({ ...good, bucketDepth: 15 }, stamp)).toMatch(/bucket depth/);
    expect(batchProblem({ ...good, immutable: false }, stamp)).toMatch(/mutable/);
    expect(batchProblem({ ...good, ttlSeconds: null }, stamp)).toMatch(/expired/);
    expect(batchProblem({ ...good, ttlSeconds: DAY }, stamp)).toBe(
      'batch has only 1 d 0 h of storage left; needs at least 2 days',
    );
  });

  /**
   * A PostageStamp stand-in: `batches` returns the tuple; price 100 per block, so a
   * balance of 10_000_000 lasts 100_000 blocks (5.8 days) and 1_000_000 lasts 13.9 h.
   */
  function fakeChain(
    batches: Record<string, [Address, number, number, boolean, bigint?]>,
    block = 200n,
  ) {
    return {
      getBlockNumber: vi.fn(async () => block),
      readContract: vi.fn(
        async ({ functionName, args }: { functionName: string; args?: Hex[] }) => {
          if (functionName === 'batches') {
            const b = batches[args![0]];
            return b
              ? [b[0], b[1], b[2], b[3], 1n, 150n]
              : ['0x0000000000000000000000000000000000000000', 0, 0, false, 0n, 0n];
          }
          if (functionName === 'remainingBalance') return batches[args![0]]?.[4] ?? 10_000_000n;
          if (functionName === 'lastPrice') return 100n;
          throw new Error(functionName);
        },
      ),
    } as unknown as PublicClient & { readContract: ReturnType<typeof vi.fn> };
  }
  const calls = (pub: { readContract: ReturnType<typeof vi.fn> }, fn: string) =>
    pub.readContract.mock.calls.filter(([a]) => (a as { functionName: string }).functionName === fn)
      .length;

  it('adds checked batches, refuses others, and keeps existing ones', async () => {
    const area = memArea();
    const other = privateKeyToAddress(generatePrivateKey());
    // Created at block 150, now 155: too fresh for Bee yet (accepted, marked).
    const pub = fakeChain(
      {
        [id(1)]: [stamp, 17, 16, true],
        [id(2)]: [other, 17, 16, true],
        [id(5)]: [stamp, 17, 16, true, 1_000_000n],
        [id(6)]: [stamp, 17, 16, true],
      },
      155n,
    );
    const r = await addBatches([id(1), id(2), id(3), id(5), id(6)], {
      pub,
      stampAddress: stamp,
      area,
      now: 5,
    });
    expect(r.pool).toEqual([
      { batchId: id(1), used: false, usable: false },
      { batchId: id(6), used: false, usable: false },
    ]);
    expect(r.rejected.map((x) => [x.batchId, x.reason.split(' ')[0]])).toEqual([
      [id(2), 'owner'],
      [id(3), 'batch'],
      [id(5), 'batch'],
    ]);
    expect(r.rejected[2].reason).toMatch(/only 13 h of storage left; needs at least 2 days/);
    // The price is read once per call; a foreign batch costs no lifetime read.
    expect(calls(pub, 'lastPrice')).toBe(1);
    expect(calls(pub, 'remainingBalance')).toBe(3);

    // 150 + 12 <= 200: Bee should accept stamps by now.
    const pub2 = fakeChain({ [id(4)]: [stamp, 18, 16, true] });
    const again = await addBatches([id(1), id(4)], {
      pub: pub2,
      stampAddress: stamp,
      area,
      now: 6,
    });
    expect(again.pool.map((b) => [b.batchId, b.usable])).toEqual([
      [id(1), false],
      [id(6), false],
      [id(4), true],
    ]);
    expect((area.data[POOL_KEY] as PoolBatch[])[2]).toMatchObject({ depth: 18, startBlock: '150' });
  });

  it('remembers refusals briefly (no chain reads), but never "not found"', async () => {
    const other = privateKeyToAddress(generatePrivateKey());
    const pub = fakeChain({ [id(2)]: [other, 17, 16, true] });
    const area = memArea();
    await addBatches([id(2), id(3)], { pub, stampAddress: stamp, area, now: 1_000 });
    const before = calls(pub, 'batches');
    const r = await addBatches([id(2), id(3)], { pub, stampAddress: stamp, area, now: 2_000 });
    expect(r.rejected.map((x) => x.batchId)).toEqual([id(2), id(3)]);
    expect(calls(pub, 'batches') - before).toBe(1); // only id(3) read again
    await addBatches([id(2)], { pub, stampAddress: stamp, area, now: 1_000 + 3 * 60_000 });
    expect(calls(pub, 'batches') - before).toBe(2); // expired from the cache
  });

  it('runs one addBatches call at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const pub = fakeChain({ [id(1)]: [stamp, 17, 16, true], [id(2)]: [stamp, 17, 16, true] });
    const read = pub.readContract.getMockImplementation()!;
    pub.readContract.mockImplementation(async (a: { functionName: string; args?: Hex[] }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return read(a);
    });
    const area = memArea();
    await Promise.all([
      addBatches([id(1)], { pub, stampAddress: stamp, area }),
      addBatches([id(2)], { pub, stampAddress: stamp, area }),
    ]);
    expect(peak).toBe(1);
    expect((area.data[POOL_KEY] as PoolBatch[]).map((b) => b.batchId)).toEqual([id(1), id(2)]);
  });

  it('does not remember a refusal that came from an RPC error, and never calls it expired', async () => {
    const pub = fakeChain({ [id(1)]: [stamp, 17, 16, true] });
    const read = pub.readContract.getMockImplementation()!;
    let rpcDown = true;
    pub.readContract.mockImplementation(async (a: { functionName: string; args?: Hex[] }) => {
      if (rpcDown && a.functionName === 'remainingBalance') {
        throw new HttpRequestError({ url: 'http://rpc', status: 429 });
      }
      return read(a);
    });
    const area = memArea();
    const r = await addBatches([id(1)], { pub, stampAddress: stamp, area, now: 1_000 });
    expect(r.pool).toEqual([]);
    expect(r.rejected).toEqual([
      { batchId: id(1), reason: expect.stringMatching(/could not read the batch on Gnosis/) },
    ]);
    expect(r.rejected[0].reason).not.toMatch(/expired/);
    // The RPC is back a second later: the batch is read again (no 2-minute refusal) and joins.
    rpcDown = false;
    const again = await addBatches([id(1)], { pub, stampAddress: stamp, area, now: 2_000 });
    expect(again.rejected).toEqual([]);
    expect(again.pool.map((b) => b.batchId)).toEqual([id(1)]);
  });

  describe('a dead batch that is added again (R32)', () => {
    const dead = (n: number, over: Partial<PoolBatch> = {}) =>
      batch(n, { usable: false, dead: 'batch expired', deadReason: 'expired', ...over });

    it('revives an expired batch once its lifetime is 2 days or more again', async () => {
      const area = memArea({
        [POOL_KEY]: [
          dead(1),
          // Stored by an older build: no deadReason, but the text says it ran out of time.
          {
            ...dead(2),
            deadReason: undefined,
            dead: 'only 1 d 0 h of storage left; needs at least 2 days',
          },
          dead(3, { used: true }),
        ],
      });
      // Topped up: id(1) and id(2) have 5.8 days again (price 100 per block, 10_000_000).
      const pub = fakeChain(
        {
          [id(1)]: [stamp, 17, 16, true],
          [id(2)]: [stamp, 17, 16, true],
          [id(3)]: [stamp, 17, 16, true],
        },
        500n,
      );
      const r = await addBatches([id(1), id(2), id(3)], { pub, stampAddress: stamp, area });
      expect(r.rejected).toEqual([]);
      const pool = area.data[POOL_KEY] as PoolBatch[];
      expect(pool[0]).not.toHaveProperty('dead');
      expect(pool[0]).not.toHaveProperty('deadReason');
      expect(pool[0].usable).toBe(true); // 150 + 12 <= 500
      expect(pool[1]).not.toHaveProperty('dead');
      expect(pool[2]).toMatchObject({ used: true, dead: 'batch expired' }); // used: left alone
      expect(unusedBatches(pool).map((b) => b.batchId)).toEqual([id(1), id(2)]);
      expect(r.pool.map((b) => [b.batchId, b.dead])).toEqual([
        [id(1), undefined],
        [id(2), undefined],
        [id(3), true],
      ]);
    });

    it('keeps a batch dead while its lifetime is still short, without refusing it', async () => {
      const area = memArea({ [POOL_KEY]: [dead(1)] });
      const pub = fakeChain({ [id(1)]: [stamp, 17, 16, true, 1_000_000n] }); // 13 h
      const r = await addBatches([id(1)], { pub, stampAddress: stamp, area });
      expect(r.rejected).toEqual([]);
      expect(r.pool).toEqual([{ batchId: id(1), used: false, usable: false, dead: true }]);
      expect((area.data[POOL_KEY] as PoolBatch[])[0]).toMatchObject({ dead: 'batch expired' });
    });

    it('keeps it dead when the RPC fails, and never revives a full bucket', async () => {
      const full = dead(2, { dead: 'a bucket of this batch is full', deadReason: 'bucket_full' });
      // Stored by an older build: only the text says why.
      const legacyFull = { ...full, batchId: id(3), deadReason: undefined };
      const area = memArea({ [POOL_KEY]: [dead(1), full, legacyFull] });
      const pub = fakeChain({
        [id(1)]: [stamp, 17, 16, true],
        [id(2)]: [stamp, 17, 16, true],
        [id(3)]: [stamp, 17, 16, true],
      });
      const read = pub.readContract.getMockImplementation()!;
      pub.readContract.mockImplementation(async (a: { functionName: string; args?: Hex[] }) => {
        if (a.functionName === 'remainingBalance' && a.args![0] === id(1)) {
          throw new HttpRequestError({ url: 'http://rpc', status: 503 });
        }
        return read(a);
      });
      const r = await addBatches([id(1), id(2), id(3)], { pub, stampAddress: stamp, area });
      expect(r.rejected).toEqual([]);
      expect(r.pool.map((b) => b.dead)).toEqual([true, true, true]);
      const reads = pub.readContract.mock.calls.map(([a]) => (a as { args?: Hex[] }).args?.[0]);
      expect(reads).not.toContain(id(2));
      expect(reads).not.toContain(id(3));
    });

    it('records why an upload killed a batch, and reads old entries by their text', async () => {
      const area = memArea({ [POOL_KEY]: [batch(1), batch(2)] });
      await applyBatchUpdates(
        [
          { batchId: id(1), dead: 'batch expired', deadReason: 'expired' },
          { batchId: id(2), dead: 'a bucket of this batch is full', deadReason: 'bucket_full' },
        ],
        area,
      );
      expect((area.data[POOL_KEY] as PoolBatch[]).map((b) => b.deadReason)).toEqual([
        'expired',
        'bucket_full',
      ]);
      const legacy = parsePool([
        batch(3, { dead: 'batch expired' }),
        batch(4, { dead: 'a bucket of this batch is full' }),
        batch(5),
      ]);
      expect(legacy.map((b) => b.deadReason)).toEqual(['expired', 'bucket_full', undefined]);
    });
  });

  it('stores upload results: merged heights, used, dead, demoted', async () => {
    const area = memArea({
      [POOL_KEY]: [batch(1, { stamper: [[5, 2]] }), batch(2), batch(3)],
    });
    await applyBatchUpdates(
      [
        { batchId: id(1), stamper: [[5, 1]] },
        { batchId: id(2), dead: 'a bucket of this batch is full', stamper: [[7, 2]] },
        { batchId: id(3), demote: true },
      ],
      area,
      99,
    );
    const [a, b, c] = area.data[POOL_KEY] as PoolBatch[];
    expect(a).toMatchObject({ used: false, stamper: [[5, 2]] }); // never lowered
    expect(b).toMatchObject({ dead: 'a bucket of this batch is full', stamper: [[7, 2]] });
    expect(c.queuedAt).toBe(99);
    await applyBatchUpdates([{ batchId: id(1), used: true, stamper: [[6, 1]] }], area);
    expect((area.data[POOL_KEY] as PoolBatch[])[0]).toMatchObject({
      used: true,
      usable: true,
      stamper: [
        [5, 2],
        [6, 1],
      ],
    });
  });
});

const WITNESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const evidence: EvidenceFile = {
  schema: 'recall.evidence.v1',
  statement: {
    serverName: 'notice.recall.test',
    connTime: '1793800900',
    signedAt: '1793800920',
    sentSha256: `0x${'1'.repeat(64)}`,
    recvSha256: `0x${'2'.repeat(64)}`,
    sentLen: 3,
    recvLen: 3,
    tlsVersion: 12,
    nonce: `0x${'4'.repeat(64)}`,
  },
  signature: `0x${'5'.repeat(130)}`,
  signer: WITNESS,
  transcript: { sent: 'YWJj', recv: 'ZGVm' },
  meta: { capturedUrl: 'https://notice.recall.test/notice', size: 3 },
};

describe('pending records', () => {
  const rec = (captureId: string, createdAt = Date.now()): PendingRecord => ({
    captureId,
    kind: 'capture',
    evidence,
    evidenceRef: id(7),
    batchId: id(1),
    bodySha256: id(9),
    createdAt,
  });

  it('are read back only by their exact captureId, in their stored key order', async () => {
    const area = memArea();
    const cid = newCaptureId();
    expect(cid).toMatch(/^[0-9a-f]{32}$/);
    await savePending(rec(cid, 1), area);
    expect(typeof area.data[PENDING_PREFIX + cid]).toBe('string');
    const back = await readPending(cid, area);
    expect(back).toEqual(rec(cid, 1));
    expect(Object.keys(back!.evidence.statement)).toEqual(Object.keys(evidence.statement));
    for (const wrong of [cid.toUpperCase(), cid.slice(1), `${cid}0`, newCaptureId(), 7, null]) {
      expect(await readPending(wrong, area)).toBeNull();
    }
  });

  it('are discarded only by their exact captureId', async () => {
    const area = memArea();
    const cid = newCaptureId();
    await savePending(rec(cid, Date.now()), area);
    for (const wrong of [cid.toUpperCase(), cid.slice(1), `${cid}0`, newCaptureId(), 7, null]) {
      expect(await discardPending(wrong, area)).toEqual({
        error: 'no pending capture with this id',
      });
    }
    expect(await readPending(cid, area)).not.toBeNull();
    expect(await discardPending(cid, area)).toEqual({ ok: true });
    expect(await readPending(cid, area)).toBeNull();
    expect(await discardPending(cid, area)).toEqual({ error: 'no pending capture with this id' });
  });

  it('still saves the record when pruning old ones fails', async () => {
    const area = memArea();
    area.get.mockImplementation(async (k: string | null) => {
      if (k === null) throw new Error('storage busy');
      return k in area.data ? { [k]: area.data[k] } : {};
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const cid = newCaptureId();
      await expect(savePending(rec(cid, 1), area)).resolves.toBeUndefined();
      expect(await readPending(cid, area)).toEqual(rec(cid, 1));
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it('are marked published only when the Arkiv record matches', async () => {
    const area = memArea();
    const cid = newCaptureId();
    await savePending(rec(cid), area);
    const read = vi.fn();

    read.mockResolvedValueOnce({ kind: 'capture', bodySha256: id(9), evidenceRef: id(8) });
    expect(await markPublished(cid, id(100), read, area)).toEqual({
      error: expect.stringMatching(/evidenceRef does not match/),
    });
    read.mockResolvedValueOnce({ kind: 'capture', bodySha256: id(10), evidenceRef: id(7) });
    expect(await markPublished(cid, id(100), read, area)).toEqual({
      error: expect.stringMatching(/bodySha256 does not match/),
    });
    read.mockResolvedValueOnce({ kind: 'confirmation', bodySha256: id(9), captureKey: id(7) });
    expect(await markPublished(cid, id(100), read, area)).toEqual({
      error: expect.stringMatching(/confirmation/),
    });
    read.mockResolvedValueOnce({ error: 'no entity' });
    expect(await markPublished(cid, id(100), read, area)).toEqual({
      error: expect.stringMatching(/could not be read/),
    });
    expect(await markPublished(cid, 'nope', read, area)).toEqual({ error: expect.any(String) });
    expect(await readPending(cid, area)).not.toBeNull();

    read.mockResolvedValueOnce({ kind: 'capture', bodySha256: id(9), evidenceRef: id(7) });
    expect(await markPublished(cid, id(101), read, area)).toEqual({ ok: true });
    expect(await readPending(cid, area)).toBeNull();
    expect(area.data[PUBLISHED_PREFIX + cid]).toMatchObject({ entityKey: id(101) });
    // Repeating the same mark is harmless; another key is not.
    expect(await markPublished(cid, id(101), read, area)).toEqual({ ok: true });
    expect(await markPublished(cid, id(102), read, area)).toEqual({ error: expect.any(String) });
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('keep at most 20, none older than 7 days, and drop old tombstones', async () => {
    const now = 10 * 86_400_000;
    const ids = Array.from({ length: 23 }, () => newCaptureId());
    const area = memArea({
      [PUBLISHED_PREFIX + 'a'.repeat(32)]: { entityKey: id(1), at: now - 8 * 86_400_000 },
      [PUBLISHED_PREFIX + 'b'.repeat(32)]: { entityKey: id(2), at: now - 1_000 },
      'recall.settings': { keep: true },
    });
    // 22 recent records (oldest first) and one 8 days old.
    for (let i = 0; i < 22; i++)
      area.data[PENDING_PREFIX + ids[i]] = JSON.stringify(rec(ids[i], now - 1_000 + i));
    area.data[PENDING_PREFIX + ids[22]] = JSON.stringify(rec(ids[22], now - 8 * 86_400_000));
    await prunePending(area, now);
    const left = Object.keys(area.data).filter((k) => k.startsWith(PENDING_PREFIX));
    expect(left.sort()).toEqual(
      ids
        .slice(2, 22)
        .map((i) => PENDING_PREFIX + i)
        .sort(),
    );
    expect(area.data[PUBLISHED_PREFIX + 'a'.repeat(32)]).toBeUndefined();
    expect(area.data[PUBLISHED_PREFIX + 'b'.repeat(32)]).toBeDefined();
    expect(area.data['recall.settings']).toEqual({ keep: true });
  });
});

describe('upload gate', () => {
  const ok = { status: 'pass' as const, detail: '' };
  const checks = (over: Partial<CheckSummary> = {}): CheckSummary => ({
    A: ok,
    B: ok,
    C: { status: 'warn', detail: 'unknown witness' },
    facts: {
      canonicalUrl: 'https://notice.recall.test/notice',
      serverName: 'notice.recall.test',
      httpStatus: 200,
      signedAt: '1',
      witness: WITNESS,
      bodySha256: id(9),
      bodySize: 3,
    },
    ...over,
  });
  const url = 'https://notice.recall.test/notice';

  it('uploads when A and B passed and C did not fail', () => {
    expect(uploadGate(checks(), url)).toEqual({ ok: true });
    expect(uploadGate(checks({ C: ok }), url)).toEqual({ ok: true });
    // The same page, written differently.
    expect(uploadGate(checks(), 'https://NOTICE.recall.test./notice#top')).toEqual({ ok: true });
  });

  it('refuses failed checks and a different page', () => {
    const fail = { status: 'fail' as const, detail: '' };
    expect(uploadGate(checks({ A: fail }), url)).toEqual({
      ok: false,
      reason: 'check A did not pass',
    });
    expect(uploadGate(checks({ B: { status: 'warn', detail: '' } }), url)).toMatchObject({
      ok: false,
    });
    expect(uploadGate(checks({ C: fail }), url)).toMatchObject({ ok: false });
    expect(uploadGate(checks({ facts: undefined }), url)).toMatchObject({ ok: false });
    expect(uploadGate(checks(), 'https://notice.recall.test/other')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/the witness saw/),
    });
  });

  it('canonical evidence encodes the same whatever its key order', () => {
    const sorted = JSON.parse(
      JSON.stringify(evidence, (_k, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      ),
    ) as EvidenceFile;
    // encodeEvidence itself writes one fixed key order now (packages/evidence).
    expect(encodeEvidence(sorted)).toEqual(encodeEvidence(evidence));
    expect(encodeEvidence(canonicalEvidence(sorted))).toEqual(
      encodeEvidence(canonicalEvidence(evidence)),
    );
    expect(canonicalEvidence(evidence)).toEqual(evidence);
  });
});

describe('offscreen upload', () => {
  const candidates = [
    { batchId: id(1), depth: 17, startBlock: '100' },
    { batchId: id(2), depth: 17, startBlock: '90' },
  ];
  const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
  const beeSaying = (batches: { batchID: string; start: number }[], block: number) =>
    vi.fn(async (u: string) => (u.endsWith('/batches') ? json({ batches }) : json({ block })));
  const hidden = vi.fn(async () => json({}, false));
  const longTtl = async () => 7n * DAY;

  it("asks Bee first, and the chain only when Bee doesn't share its view", async () => {
    const chain = vi.fn(async () => 1_000n);
    const bee = beeSaying([{ batchID: id(2).slice(2), start: 95 }], 107);
    expect(
      (
        await pickUsable(candidates, 'http://bee', {
          fetch: bee,
          blockNumber: chain,
          batchTtl: longTtl,
        })
      ).pick,
    ).toEqual(candidates[1]);
    expect(chain).not.toHaveBeenCalled();
    const notYet = beeSaying([{ batchID: id(2).slice(2), start: 95 }], 106);
    expect(
      (
        await pickUsable(candidates, 'http://bee', {
          fetch: notYet,
          blockNumber: chain,
          batchTtl: longTtl,
        })
      ).pick,
    ).toBeNull();
    const at = (block: bigint) =>
      pickUsable(candidates, 'http://gw', {
        fetch: hidden,
        blockNumber: async () => block,
        batchTtl: longTtl,
      });
    expect((await at(105n)).pick).toEqual(candidates[1]);
    expect((await at(101n)).pick).toBeNull();
  });

  it('a gateway without /chainstate: the chain decides and /batches is never downloaded', async () => {
    // The public gateway: /chainstate 404, /batches a bare ~2 MB list of every batch.
    const gw = vi.fn(async (u: string) =>
      u.endsWith('/chainstate') ? json('Not Found', false) : json([]),
    );
    const r = await pickUsable(candidates, 'https://gw', {
      fetch: gw,
      blockNumber: async () => 105n,
      batchTtl: longTtl,
    });
    expect(r.pick).toEqual(candidates[1]);
    expect(gw.mock.calls.map(([u]) => u)).toEqual(['https://gw/chainstate']);
    // A node that shares /chainstate may still list batches as a bare array.
    const bare = vi.fn(async (u: string) =>
      u.endsWith('/batches')
        ? json([{ batchID: id(2).slice(2), start: 95 }])
        : json({ block: 107 }),
    );
    const chain = vi.fn(async () => 0n);
    expect(
      (
        await pickUsable(candidates, 'http://bee', {
          fetch: bare,
          blockNumber: chain,
          batchTtl: longTtl,
        })
      ).pick,
    ).toEqual(candidates[1]);
    expect(chain).not.toHaveBeenCalled();
  });

  it('re-checks each lifetime on chain and reports expired or short batches dead', async () => {
    const ttl = vi.fn(async (b: Hex) => (b === id(1) ? DAY : b === id(2) ? null : 7n * DAY));
    const three = [...candidates, { batchId: id(3), depth: 17, startBlock: '80' }];
    const cache = new Map();
    const r = await pickUsable(
      three,
      'http://gw',
      { fetch: hidden, blockNumber: async () => 500n, batchTtl: ttl },
      cache,
    );
    expect(r.pick?.batchId).toBe(id(3));
    expect(r.dead).toEqual([
      { batchId: id(1), reason: 'only 1 d 0 h of storage left; needs at least 2 days' },
      { batchId: id(2), reason: 'batch expired' },
    ]);
    // Read once per attempt.
    await pickUsable(
      three,
      'http://gw',
      { fetch: hidden, blockNumber: async () => 500n, batchTtl: ttl },
      cache,
    );
    expect(ttl).toHaveBeenCalledTimes(3);
    // An RPC failure is not a death sentence: skipped this round only.
    const flaky = await pickUsable(candidates, 'http://gw', {
      fetch: hidden,
      blockNumber: async () => 500n,
      batchTtl: async () => {
        throw new Error('rpc down');
      },
    });
    expect(flaky).toEqual({ pick: null, dead: [], unreadable: 2 });
  });

  describe('reading a lifetime from Gnosis (R32)', () => {
    const revertData = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }],
      errorName: 'Error',
      args: ['batch does not exist or expired'],
    });
    const rpcError = (code: number, message: string, data?: Hex) =>
      new RpcRequestError({ body: {}, url: 'http://rpc', error: { code, message, data } });
    /** What an RPC node answers when PostageStamp.remainingBalance reverts. */
    const revert = () =>
      rpcError(3, 'execution reverted: batch does not exist or expired', revertData);
    /** A real viem client over a canned provider; `remaining` returns the balance or throws. */
    const clientWith = (remaining: () => bigint) =>
      createPublicClient({
        transport: custom(
          {
            async request({ method, params }) {
              if (method !== 'eth_call') throw new Error(method);
              const { functionName } = decodeFunctionData({
                abi: postageAbi,
                data: (params as [{ data: Hex }])[0].data,
              });
              if (functionName === 'lastPrice') {
                return encodeFunctionResult({ abi: postageAbi, functionName, result: 100n });
              }
              if (functionName === 'remainingBalance') {
                return encodeFunctionResult({ abi: postageAbi, functionName, result: remaining() });
              }
              throw new Error(functionName);
            },
          },
          { retryCount: 0 },
        ),
      }) as PublicClient;
    const failing = (err: unknown) =>
      clientWith(() => {
        throw err;
      });
    /** Transport and node trouble: none of it says anything about the batch. */
    const transportErrors: [string, unknown][] = [
      ['rate limited', new HttpRequestError({ url: 'http://rpc', status: 429 })],
      ['a server error', new HttpRequestError({ url: 'http://rpc', status: 503 })],
      ['no network', new TypeError('fetch failed')],
      ['a limit error', rpcError(-32005, 'rate limit exceeded')],
      ['an internal error without data', rpcError(-32603, 'Internal error')],
    ];

    it('reads the lifetime, and maps only a contract revert to "no lifetime"', async () => {
      expect(
        await ttlSeconds(
          clientWith(() => 1_000_000n),
          id(1),
          100n,
        ),
      ).toBe(10_000n * 5n);
      expect(await ttlSeconds(failing(revert()), id(1), 100n)).toBeNull();
      expect(
        await ttlSeconds(
          clientWith(() => 0n),
          id(1),
          100n,
        ),
      ).toBeNull();
      for (const [name, err] of transportErrors) {
        await expect(ttlSeconds(failing(err), id(1), 100n), name).rejects.toThrow();
      }
    });

    it('kills a batch on a revert, but an RPC error is only "unreadable" (not dead)', async () => {
      const at = (pub: PublicClient) =>
        pickUsable(candidates, 'http://gw', {
          fetch: hidden,
          blockNumber: async () => 500n,
          batchTtl: ttlReader(pub),
        });
      expect(await at(failing(revert()))).toEqual({
        pick: null,
        dead: [
          { batchId: id(1), reason: 'batch expired' },
          { batchId: id(2), reason: 'batch expired' },
        ],
        unreadable: 0,
      });
      for (const [name, err] of transportErrors) {
        expect(await at(failing(err)), name).toEqual({ pick: null, dead: [], unreadable: 2 });
      }
      expect((await at(clientWith(() => 10_000_000n))).pick).toEqual(candidates[0]);
    });

    it('ends an attempt on RPC errors without marking any batch dead', async () => {
      let t = 0;
      const upload = vi.fn();
      const r = await uploadEvidence(req, {
        fetch: hidden,
        blockNumber: async () => 500n,
        batchTtl: ttlReader(failing(new HttpRequestError({ url: 'http://rpc', status: 429 }))),
        upload,
        sleep: async (ms) => void (t += ms),
        now: () => t,
      });
      expect(r).toEqual({
        ok: false,
        code: 'failed',
        error: expect.stringMatching(/could not be checked on Gnosis/),
        updates: [],
      });
      expect(upload).not.toHaveBeenCalled();
    });
  });

  it('classifies failures by what they say about the batch', () => {
    expect(failureKind(new Error('Stamper#stamp bucket is full'))).toBe('bucket_full');
    expect(failureKind(Object.assign(new Error('Bad Request'), { status: 400 }))).toBe('rejected');
    expect(failureKind(Object.assign(new Error('x'), { response: { status: 422 } }))).toBe(
      'rejected',
    );
    expect(failureKind(Object.assign(new Error('x'), { status: 429 }))).toBe('transient');
    expect(failureKind(Object.assign(new Error('x'), { status: 503 }))).toBe('transient');
    expect(failureKind(new Error('fetch failed'))).toBe('transient');
  });

  const req: OffscreenUpload = {
    type: 'recall.offscreen.upload',
    id: 'job',
    evidence,
    stampKey: generatePrivateKey(),
    candidates,
    uploadUrl: 'http://bee',
    gnosisRpcUrl: 'http://rpc',
    waitMs: 5_000,
  };
  const ready = { fetch: hidden, blockNumber: async () => 500n, batchTtl: longTtl };
  /** A 32-byte chunk address in bucket `b` (its first two bytes). */
  const addrIn = (b: number, n = 0) => {
    const a = new Uint8Array(32);
    a[0] = b >> 8;
    a[1] = b & 0xff;
    a[31] = n;
    return a;
  };

  it('waits for a usable batch, then gives up as not ready', async () => {
    let t = 0;
    const upload = vi.fn();
    const r = await uploadEvidence(req, {
      fetch: hidden,
      blockNumber: async () => 0n,
      batchTtl: longTtl,
      upload,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    expect(r).toMatchObject({ ok: false, code: 'not_ready', updates: [] });
    expect(t).toBeGreaterThanOrEqual(5_000);
    expect(upload).not.toHaveBeenCalled();
  });

  it('reports no storage when every batch is dead', async () => {
    const r = await uploadEvidence(req, { ...ready, batchTtl: async () => null, upload: vi.fn() });
    expect(r).toEqual({
      ok: false,
      code: 'no_storage',
      error: expect.any(String),
      updates: [
        { batchId: id(1), dead: 'batch expired', deadReason: 'expired' },
        { batchId: id(2), dead: 'batch expired', deadReason: 'expired' },
      ],
    });
  });

  it('uploads the encoded evidence with a stamper resumed from the stored state', async () => {
    const seen: { bytes?: Uint8Array } = {};
    const upload = vi.fn(
      async (bytes: Uint8Array, o: { stamper: { stamp(a: Uint8Array): unknown } }) => {
        seen.bytes = bytes;
        o.stamper.stamp(addrIn(9));
        return `0x${'AB'.repeat(32)}` as Hex;
      },
    );
    const r = await uploadEvidence(
      { ...req, candidates: [{ ...candidates[0], stamper: [[9, 1]] }] },
      { ...ready, upload },
    );
    expect(r).toEqual({
      ok: true,
      batchId: id(1),
      evidenceRef: `0x${'ab'.repeat(32)}`,
      updates: [{ batchId: id(1), stamper: [[9, 2]], used: true }],
    });
    expect(seen.bytes).toEqual(encodeEvidence(evidence));
  });

  it('falls through to the next batch when a bucket is full (and marks that batch dead)', async () => {
    const upload = vi.fn(
      async (_b: Uint8Array, o: { stamper: { stamp(a: Uint8Array): unknown } }) => {
        o.stamper.stamp(addrIn(9));
        return `0x${'cd'.repeat(32)}` as Hex;
      },
    );
    // Batch 1's bucket 9 already holds 2 stamps, the most depth 17 allows.
    const r = await uploadEvidence(
      { ...req, candidates: [{ ...candidates[0], stamper: [[9, 2]] }, candidates[1]] },
      { ...ready, upload },
    );
    expect(r).toMatchObject({ ok: true, batchId: id(2) });
    expect(r.updates).toEqual([
      {
        batchId: id(1),
        stamper: [[9, 2]],
        dead: 'a bucket of this batch is full',
        deadReason: 'bucket_full',
      },
      { batchId: id(2), stamper: [[9, 1]], used: true },
    ]);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('falls through on a node refusal, but stops on a passing failure (both demoted)', async () => {
    const refusing = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Payment Required'), { status: 402 }))
      .mockResolvedValueOnce(`0x${'ef'.repeat(32)}`);
    const r = await uploadEvidence(req, { ...ready, upload: refusing });
    expect(r).toMatchObject({ ok: true, batchId: id(2) });
    expect(r.updates[0]).toEqual({ batchId: id(1), stamper: [], demote: true });

    const down = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const t = await uploadEvidence(req, { ...ready, upload: down });
    expect(t).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringMatching(/fetch failed/),
    });
    expect(t.updates).toEqual([{ batchId: id(1), stamper: [], demote: true }]);
    expect(down).toHaveBeenCalledTimes(1); // the next batch waits for the next attempt
  });

  describe('a node that refuses the upload on every batch (R32)', () => {
    const four = [1, 2, 3, 4].map((n) => ({ batchId: id(n), depth: 17, startBlock: '10' }));
    /** Stamps the first chunk (taking a slot), then the node answers `statuses[call]`. */
    const refusing = (...statuses: (number | 'ok')[]) => {
      let call = 0;
      return vi.fn(async (_b: Uint8Array, o: { stamper: { stamp(a: Uint8Array): unknown } }) => {
        o.stamper.stamp(addrIn(9));
        const status = statuses[Math.min(call++, statuses.length - 1)];
        if (status === 'ok') return `0x${'ef'.repeat(32)}` as Hex;
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      });
    };

    it('stops after two batches when both get the same status, and kills none', async () => {
      const upload = refusing(403);
      const r = await uploadEvidence({ ...req, candidates: four }, { ...ready, upload });
      expect(r).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringMatching(/storage node refused the upload \(status 403\)/i),
      });
      expect(upload).toHaveBeenCalledTimes(2);
      expect(r.updates).toEqual([
        { batchId: id(1), stamper: [[9, 1]], demote: true },
        { batchId: id(2), stamper: [[9, 1]], demote: true },
      ]);
      expect(r.updates.some((u) => 'dead' in u)).toBe(false);
    });

    it('also stops after two batches when the statuses differ', async () => {
      const upload = refusing(402, 413);
      const r = await uploadEvidence({ ...req, candidates: four }, { ...ready, upload });
      expect(r).toMatchObject({ ok: false, code: 'failed' });
      expect(r.ok ? '' : r.error).toMatch(/402/);
      expect(r.ok ? '' : r.error).toMatch(/413/);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(r.updates.map((u) => [u.batchId, u.demote, 'dead' in u])).toEqual([
        [id(1), true, false],
        [id(2), true, false],
      ]);
    });

    it('still succeeds on the second batch after one refusal', async () => {
      const upload = refusing(402, 'ok');
      const r = await uploadEvidence({ ...req, candidates: four }, { ...ready, upload });
      expect(r).toMatchObject({ ok: true, batchId: id(2) });
      expect(upload).toHaveBeenCalledTimes(2);
      expect(r.updates).toEqual([
        { batchId: id(1), stamper: [[9, 1]], demote: true },
        { batchId: id(2), stamper: [[9, 1]], used: true },
      ]);
    });
  });

  describe('a timed-out upload', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    it('stamps nothing more once the attempt has ended', async () => {
      let release!: () => void;
      let lateStamp: unknown = 'not tried';
      const upload = vi.fn(
        async (_b: Uint8Array, o: { stamper: { stamp(a: Uint8Array): unknown } }) => {
          o.stamper.stamp(addrIn(3));
          await new Promise<void>((r) => (release = r));
          try {
            o.stamper.stamp(addrIn(4));
            lateStamp = 'stamped';
          } catch (e) {
            lateStamp = (e as Error).message;
          }
          return `0x${'aa'.repeat(32)}` as Hex;
        },
      );
      const pending = uploadEvidence({ ...req, candidates: [candidates[0]] }, { ...ready, upload });
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await pending;
      expect(r).toMatchObject({ ok: false, code: 'failed', error: expect.stringMatching(/60 s/) });
      expect(r.updates).toEqual([{ batchId: id(1), stamper: [[3, 1]], demote: true }]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(lateStamp).toBe('upload stopped');
    });
  });
});

describe('popup copy', () => {
  it('lists the upload step only when an upload is planned', () => {
    expect(jobSteps({ uploadPlanned: false, step: 2 }).labels).toHaveLength(3);
    expect(jobSteps({ uploadPlanned: true, step: 1 }).labels).toEqual([
      'Connecting to the witness',
      'Proving the page with the witness',
      'Checking the witness signature',
      'Uploading evidence to Swarm',
      'Opening the approval tab',
    ]);
    expect(jobSteps({ step: 4 })).toEqual({ labels: expect.any(Array), current: 3 });
  });

  it('warns about missing or expired storage before a capture', () => {
    expect(CAPTURE_HELPER).toBe('Takes about 30 s and about 80 MB of data. Pages up to 64 KB.');
    expect(captureHelper('ok')).toBe(CAPTURE_HELPER);
    expect(captureHelper('empty')).toMatch(/^No storage left: .*not uploaded/);
    expect(captureHelper('expired')).toMatch(/^Storage expired: .*not uploaded/);
    expect(storageNotice('ok')).toBeNull();
    expect(storageNotice('empty')?.title).toBe('No storage left');
    expect(storageNotice('expired')).toEqual({
      title: 'Storage expired',
      body: 'Buy more in the Recall app.',
    });
  });

  it('says what happened to the evidence', () => {
    expect(
      uploadCopy(
        { status: 'uploaded', captureId: 'x', evidenceRef: id(1), batchId: id(2) },
        'empty',
      ),
    ).toMatchObject({ kind: 'success', title: 'Evidence uploaded' });
    expect(uploadCopy({ status: 'no_storage' }, 'empty')).toEqual({
      kind: 'error',
      title: 'No storage left',
      body: 'Your prepaid storage is used up. Buy more to keep capturing. Nothing was published.',
      actions: ['buyStorage'],
    });
    expect(uploadCopy({ status: 'no_storage' }, 'expired')).toEqual({
      kind: 'error',
      title: 'Storage expired',
      body: 'Buy more in the Recall app. Nothing was published.',
      actions: ['buyStorage'],
    });
    expect(uploadCopy({ status: 'no_storage' }, 'ok').actions).toEqual(['uploadNow']);
    expect(uploadCopy({ status: 'skipped', reason: 'check A did not pass' }, 'ok').body).toBe(
      'Check A did not pass, so the evidence was not uploaded. Nothing was published.',
    );
    expect(
      uploadCopy({ status: 'failed', error: 'bee said no.', code: 'not_ready' }, 'ok').title,
    ).toBe('Storage not ready yet');
    expect(uploadCopy({ status: 'failed', error: 'bee said no.' }, 'ok')).toMatchObject({
      title: 'Upload failed',
      body: 'Bee said no. Nothing was published.',
      actions: ['retryUpload', 'copy'],
    });
  });
});
