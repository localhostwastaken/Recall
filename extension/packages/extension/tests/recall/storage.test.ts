// Stamp key, batch pool, pending records and the upload that follows a capture.
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { encodeEvidence, type EvidenceFile } from '@recall/evidence';
import { STAMP_KEY, stampAddress, stampKey, type KeyArea } from '../../src/recall/stamp';
import {
  POOL_KEY,
  decodeStamperState,
  encodeStamperState,
  parsePool,
  unusedBatches,
  type PoolBatch,
} from '../../src/recall/poolState';
import {
  addBatches,
  batchProblem,
  parseBatchIds,
  recordUpload,
  type BatchInfo,
} from '../../src/recall/pool';
import {
  PENDING_PREFIX,
  markPublished,
  newCaptureId,
  readPending,
  savePending,
  type PendingRecord,
} from '../../src/recall/pending';
import { canonicalEvidence, uploadGate } from '../../src/recall/uploadParts';
import { pickUsable, uploadEvidence } from '../../src/recall/swarmUpload';
import {
  CAPTURE_HELPER,
  CAPTURE_HELPER_NO_STORAGE,
  jobSteps,
  uploadCopy,
} from '../../src/recall/captureView';
import type { CheckSummary } from '../../src/recall/jobState';

/** An in-memory chrome.storage area. */
function memArea(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...init };
  return {
    data,
    get: vi.fn(async (k: string) => (k in data ? { [k]: data[k] } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => void Object.assign(data, items)),
    remove: vi.fn(async (k: string) => void delete data[k]),
  };
}

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

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

  it('reads an existing key and replaces only a malformed one', async () => {
    const key = generatePrivateKey();
    expect(await stampKey(memArea({ [STAMP_KEY]: key }))).toBe(key);
    const broken = memArea({ [STAMP_KEY]: 'nope' });
    expect(await stampKey(broken)).not.toBe('nope');
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

describe('pool state', () => {
  it('round-trips sparse stamper state', () => {
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
  });

  it('drops malformed stored batches and lists unused ones oldest first', () => {
    const ok = (n: number, addedAt: number, used = false) => ({
      batchId: id(n),
      depth: 17,
      used,
      usable: false,
      startBlock: '10',
      addedAt,
    });
    const pool = parsePool([
      ok(1, 30),
      ok(2, 10),
      ok(3, 5, true),
      { ...ok(4, 1), depth: 20 },
      { ...ok(5, 1), batchId: '0x12' },
      { ...ok(6, 1), stamper: [[70000, 1]] },
      null,
    ]);
    expect(pool.map((b) => b.batchId)).toEqual([id(1), id(2), id(3), id(6)]);
    expect(pool[3].stamper).toBeUndefined();
    expect(unusedBatches(pool).map((b) => b.batchId)).toEqual([id(6), id(2), id(1)]);
    expect(parsePool('nope')).toEqual([]);
  });
});

describe('batch ids and checks', () => {
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
    ttlSeconds: 86_400n,
  };

  it('names the reason a batch is refused (R27)', () => {
    expect(batchProblem(good, stamp)).toBeNull();
    expect(batchProblem({ ...good, depth: 18 }, stamp)).toBeNull();
    expect(batchProblem(null, stamp)).toMatch(/not found/);
    expect(
      batchProblem({ ...good, owner: privateKeyToAddress(generatePrivateKey()) }, stamp),
    ).toMatch(/owner/);
    expect(batchProblem({ ...good, depth: 20 }, stamp)).toMatch(/depth 20/);
    expect(batchProblem({ ...good, bucketDepth: 15 }, stamp)).toMatch(/bucket depth/);
    expect(batchProblem({ ...good, immutable: false }, stamp)).toMatch(/mutable/);
    expect(batchProblem({ ...good, ttlSeconds: null }, stamp)).toMatch(/expired/);
  });

  /** A PostageStamp stand-in: `batches` returns the tuple, the rest is fixed. */
  function fakeChain(batches: Record<string, [Address, number, number, boolean]>, block = 200n) {
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
          if (functionName === 'remainingBalance') return 1_000_000n;
          if (functionName === 'lastPrice') return 100n;
          throw new Error(functionName);
        },
      ),
    } as unknown as PublicClient;
  }

  it('adds checked batches, refuses others, and keeps existing ones', async () => {
    const area = memArea();
    const other = privateKeyToAddress(generatePrivateKey());
    // Created at block 150, now 155: too fresh for Bee yet (accepted, marked).
    const pub = fakeChain(
      {
        [id(1)]: [stamp, 17, 16, true],
        [id(2)]: [other, 17, 16, true],
      },
      155n,
    );
    const r = await addBatches([id(1), id(2), id(3)], { pub, stampAddress: stamp, area, now: 5 });
    expect(r.pool).toEqual([{ batchId: id(1), used: false, usable: false }]);
    expect(r.rejected.map((x) => [x.batchId, x.reason.split(' ')[0]])).toEqual([
      [id(2), 'owner'],
      [id(3), 'batch'],
    ]);
    // 150 + 12 <= 200: Bee should accept stamps by now.
    const pub2 = fakeChain({ [id(4)]: [stamp, 18, 16, true] });
    const again = await addBatches([id(1), id(4)], {
      pub: pub2,
      stampAddress: stamp,
      area,
      now: 6,
    });
    expect(again.pool).toEqual([
      { batchId: id(1), used: false, usable: false },
      { batchId: id(4), used: false, usable: true },
    ]);
    expect((area.data[POOL_KEY] as PoolBatch[])[1]).toMatchObject({ depth: 18, startBlock: '150' });
  });

  it('records stamper state on every attempt and marks a batch used on success', async () => {
    const area = memArea({
      [POOL_KEY]: [
        { batchId: id(1), depth: 17, used: false, usable: false, startBlock: '1', addedAt: 1 },
      ],
    });
    await recordUpload(id(1), { stamper: [[5, 1]], used: false }, area);
    expect((area.data[POOL_KEY] as PoolBatch[])[0]).toMatchObject({
      used: false,
      stamper: [[5, 1]],
    });
    await recordUpload(id(1), { stamper: [[5, 2]], used: true }, area);
    expect((area.data[POOL_KEY] as PoolBatch[])[0]).toMatchObject({
      used: true,
      usable: true,
      stamper: [[5, 2]],
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
  const rec = (captureId: string): PendingRecord => ({
    captureId,
    kind: 'capture',
    evidence,
    evidenceRef: id(7),
    batchId: id(1),
    bodySha256: id(9),
    createdAt: 1,
  });

  it('are read back only by their exact captureId, in their stored key order', async () => {
    const area = memArea();
    const cid = newCaptureId();
    expect(cid).toMatch(/^[0-9a-f]{32}$/);
    await savePending(rec(cid), area);
    expect(typeof area.data[PENDING_PREFIX + cid]).toBe('string');
    const back = await readPending(cid, area);
    expect(back).toEqual(rec(cid));
    expect(Object.keys(back!.evidence.statement)).toEqual(Object.keys(evidence.statement));
    for (const wrong of [cid.toUpperCase(), cid.slice(1), `${cid}0`, newCaptureId(), 7, null]) {
      expect(await readPending(wrong, area)).toBeNull();
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
    // Repeating the same mark is harmless; another key is not.
    expect(await markPublished(cid, id(101), read, area)).toEqual({ ok: true });
    expect(await markPublished(cid, id(102), read, area)).toEqual({ error: expect.any(String) });
    expect(read).toHaveBeenCalledTimes(5);
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
    expect(encodeEvidence(sorted)).not.toEqual(encodeEvidence(evidence));
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

  it("asks Bee first, and the chain only when Bee doesn't share its view", async () => {
    const chain = vi.fn(async () => 1_000n);
    const bee = beeSaying([{ batchID: id(2).slice(2), start: 95 }], 107);
    expect(await pickUsable(candidates, 'http://bee', { fetch: bee, blockNumber: chain })).toEqual(
      candidates[1],
    );
    expect(chain).not.toHaveBeenCalled();
    const notYet = beeSaying([{ batchID: id(2).slice(2), start: 95 }], 106);
    expect(
      await pickUsable(candidates, 'http://bee', { fetch: notYet, blockNumber: chain }),
    ).toBeNull();

    const hidden = vi.fn(async () => json({}, false));
    expect(
      await pickUsable(candidates, 'http://gw', { fetch: hidden, blockNumber: async () => 105n }),
    ).toEqual(candidates[1]);
    expect(
      await pickUsable(candidates, 'http://gw', { fetch: hidden, blockNumber: async () => 101n }),
    ).toBeNull();
  });

  const req = {
    type: 'recall.offscreen.upload' as const,
    id: 'job',
    evidence,
    stampKey: generatePrivateKey(),
    candidates,
    uploadUrl: 'http://bee',
    gnosisRpcUrl: 'http://rpc',
    waitMs: 5_000,
  };

  it('waits for a usable batch, then gives up as not ready', async () => {
    let t = 0;
    const upload = vi.fn();
    const r = await uploadEvidence(req, {
      fetch: vi.fn(async () => json({}, false)),
      blockNumber: async () => 0n,
      upload,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    expect(r).toMatchObject({ ok: false, code: 'not_ready' });
    expect(t).toBeGreaterThanOrEqual(5_000);
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads the encoded evidence with a stamper resumed from the stored state', async () => {
    const seen: { bytes?: Uint8Array; buckets?: Uint32Array } = {};
    const upload = vi.fn(async (bytes: Uint8Array, o: { stamper: { getState(): Uint32Array } }) => {
      seen.bytes = bytes;
      seen.buckets = o.stamper.getState();
      return `0x${'AB'.repeat(32)}` as Hex;
    });
    const r = await uploadEvidence(
      { ...req, candidates: [{ ...candidates[0], stamper: [[9, 1]] }] },
      { fetch: vi.fn(async () => json({}, false)), blockNumber: async () => 500n, upload },
    );
    expect(r).toEqual({
      ok: true,
      batchId: id(1),
      evidenceRef: `0x${'ab'.repeat(32)}`,
      stamper: [[9, 1]],
    });
    expect(seen.bytes).toEqual(encodeEvidence(evidence));
    expect(seen.buckets![9]).toBe(1);

    const failing = vi.fn(async () => {
      throw new Error('bee said no');
    });
    expect(
      await uploadEvidence(req, {
        fetch: vi.fn(async () => json({}, false)),
        blockNumber: async () => 500n,
        upload: failing,
      }),
    ).toMatchObject({
      ok: false,
      code: 'failed',
      error: expect.stringMatching(/bee said no/),
      batchId: id(1),
    });
  });
});

describe('popup copy', () => {
  it('lists the upload step only when an upload is planned', () => {
    expect(jobSteps(false, 2)).toHaveLength(3);
    expect(jobSteps(true, 1)).toEqual([
      'Connecting to the witness',
      'Proving the page with the witness',
      'Checking the witness signature',
      'Uploading evidence to Swarm',
    ]);
    expect(jobSteps(undefined, 4)).toHaveLength(4);
    expect(CAPTURE_HELPER).toBe('Takes about 30 s and about 80 MB of data. Pages up to 64 KB.');
    expect(CAPTURE_HELPER_NO_STORAGE).toMatch(/^No storage left: .*not uploaded/);
  });

  it('says what happened to the evidence', () => {
    expect(
      uploadCopy({ status: 'uploaded', captureId: 'x', evidenceRef: id(1), batchId: id(2) }, false),
    ).toMatchObject({ kind: 'success', title: 'Uploaded. Ready to publish' });
    expect(uploadCopy({ status: 'no_storage' }, false)).toEqual({
      kind: 'error',
      title: 'No storage left',
      body: 'Your prepaid storage is used up. Buy more to keep capturing. Nothing was published.',
      actions: ['buyStorage'],
    });
    expect(uploadCopy({ status: 'no_storage' }, true).actions).toEqual(['uploadNow']);
    expect(uploadCopy({ status: 'skipped', reason: 'check A did not pass' }, true).body).toBe(
      'Check A did not pass, so the evidence was not uploaded. Nothing was published.',
    );
    expect(
      uploadCopy({ status: 'failed', error: 'bee said no.', code: 'not_ready' }, true).title,
    ).toBe('Storage not ready yet');
    expect(uploadCopy({ status: 'failed', error: 'bee said no.' }, true)).toMatchObject({
      title: 'Upload failed',
      body: 'Bee said no. Nothing was published.',
      actions: ['retryUpload', 'copy'],
    });
  });
});
