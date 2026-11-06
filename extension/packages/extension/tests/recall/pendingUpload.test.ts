import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import type { EvidenceFile } from '@recall/evidence';

// The upload of a pending capture (R44, capture first): started by the publish tab, never
// twice, and a failure keeps the capture. Offscreen document, pool, stamp key and settings stubbed.
const settings = { uploadMode: 'stamped' as 'stamped' | 'free', net: 'local' };
vi.mock('../../src/recall/settings', async (orig) => ({
  ...(await orig<typeof import('../../src/recall/settings')>()),
  loadSettings: vi.fn(async () => ({ ...settings, pinnedWitnesses: [], appUrl: 'http://localhost:5173' })),
}));
vi.mock('../../src/recall/offscreen', () => ({ ensureOffscreen: vi.fn(async () => undefined) }));
type B = { batchId: Hex; depth: number; used: boolean; usable: boolean; startBlock: string; addedAt: number; stamper?: [number, number][] };
const pool: { value: B[] } = { value: [] };
/** Like the real pool: an upload's updates (used, heights) are stored. */
const applyBatchUpdates = vi.fn(async (updates: { batchId: Hex; used?: boolean; stamper?: [number, number][] }[]) => {
  for (const u of updates) {
    const b = pool.value.find((x) => x.batchId === u.batchId);
    if (b) Object.assign(b, u.used ? { used: true } : {}, u.stamper ? { stamper: u.stamper } : {});
  }
});
vi.mock('../../src/recall/pool', () => ({
  loadPool: vi.fn(async () => pool.value.map((b) => ({ ...b }))),
  applyBatchUpdates: (u: unknown) => applyBatchUpdates(u as never),
}));
/** Lifetimes on Gnosis, per batch (seconds); a batch not listed has 10 days. */
const ttls = new Map<string, bigint | null>();
vi.mock('../../src/recall/batchChain', () => ({
  lastPrice: vi.fn(async () => 1n),
  ttlSeconds: vi.fn(async (_pub: unknown, batchId: string) => (ttls.has(batchId) ? ttls.get(batchId)! : 10n * 86_400n)),
}));
vi.mock('../../src/recall/stamp', () => ({ stampKey: vi.fn(async () => `0x${'9'.repeat(64)}`) }));

/** chrome.storage.local as an in-memory area. */
const local = new Map<string, unknown>();
(chrome.storage as unknown as { local: object }).local = {
  get: async (k: string | null) =>
    k === null ? Object.fromEntries(local) : local.has(k) ? { [k]: structuredClone(local.get(k)) } : {},
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
  },
  remove: async (k: string | string[]) => {
    for (const key of Array.isArray(k) ? k : [k]) local.delete(key);
  },
};

const { uploadPending, onPendingUploadResult, pendingAnswer, clearTtlCache, UPLOAD_BUSY } = await import(
  '../../src/recall/pendingUpload'
);
const { savePending, discardPending, readPending, UPLOAD_LOST_AFTER_MS } = await import('../../src/recall/pending');
const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
const uploads = () =>
  sendMessage.mock.calls.filter(([m]) => (m as { type?: string })?.type === 'recall.offscreen.upload');

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
  signer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  transcript: { sent: 'YWJj', recv: 'ZGVm' },
  meta: { capturedUrl: 'https://notice.recall.test/notice', size: 3 },
} as EvidenceFile;
const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const CID = 'c'.repeat(32);
const batch = (n: number): B => ({ batchId: id(n), depth: 17, used: false, usable: true, startBlock: '1', addedAt: n });
/** The id of the n-th upload sent to the offscreen document (`<captureId>.<attempt>`). */
const sentId = (n = 0) => (uploads()[n]![0] as { id: string }).id;

beforeEach(async () => {
  local.clear();
  ttls.clear();
  clearTtlCache();
  pool.value = [batch(1)];
  settings.uploadMode = 'stamped';
  applyBatchUpdates.mockClear();
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ accepted: true });
  await savePending({ captureId: CID, kind: 'capture', evidence, bodySha256: id(9), createdAt: Date.now() });
});

describe('a pending capture is uploaded only when the publish tab asks (R44)', () => {
  it('is kept without an upload: getPending says none, and offers what the pool and settings allow', async () => {
    expect(await pendingAnswer(CID)).toMatchObject({
      captureId: CID,
      kind: 'capture',
      upload: { status: 'none' },
      storage: 'ok',
      uploadMode: 'stamped',
    });
    pool.value = [];
    expect(await pendingAnswer(CID)).toMatchObject({ storage: 'empty' });
    expect(await pendingAnswer('d'.repeat(32))).toEqual({ error: 'no pending capture with this id' });
  });

  it('starts one stamped upload with the pool batch; a second request while it runs starts nothing', async () => {
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading', mode: 'stamped' });
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0][0]).toMatchObject({ mode: 'stamped', candidates: [{ batchId: id(1) }] });
    expect(sentId()).toMatch(new RegExp(`^${CID}\\.[0-9a-f]{12}$`));
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading', mode: 'stamped' });
    expect(await uploadPending(CID, 'free')).toMatchObject({ error: expect.stringMatching(/free storage is turned off/) });
    expect(uploads()).toHaveLength(1);
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'uploading', mode: 'stamped' } });
  });

  it('after success it reports the reference and never uploads again', async () => {
    await uploadPending(CID, 'stamped');
    const updates = [{ batchId: id(1), used: true }];
    await onPendingUploadResult(sentId(), { ok: true, batchId: id(1), evidenceRef: id(7), updates });
    expect(applyBatchUpdates).toHaveBeenCalledWith(updates);
    expect(await pendingAnswer(CID)).toMatchObject({
      evidenceRef: id(7),
      batchId: id(1),
      upload: { status: 'uploaded', evidenceRef: id(7), batchId: id(1) },
    });
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploaded', evidenceRef: id(7), batchId: id(1) });
    expect(uploads()).toHaveLength(1);
  });

  it('a failure keeps the capture, its reason and the chosen storage; "try again" uploads again', async () => {
    settings.uploadMode = 'free';
    await uploadPending(CID, 'free');
    await onPendingUploadResult(sentId(), { ok: false, code: 'failed', error: 'the upload to Swarm failed: 500', updates: [] });
    expect(await pendingAnswer(CID)).toMatchObject({
      evidence,
      upload: { status: 'failed', reason: 'the upload to Swarm failed: 500', mode: 'free' },
    });
    expect(await uploadPending(CID, 'free')).toEqual({ status: 'uploading', mode: 'free' });
    expect(uploads()).toHaveLength(2);
  });

  it("an older attempt's late result never ends a newer attempt", async () => {
    await uploadPending(CID, 'stamped');
    const first = sentId(0);
    // The first attempt was lost; a second one runs.
    const rec = await readPending(CID);
    await savePending({ ...rec!, upload: { ...(rec!.upload as never as object), at: Date.now() - UPLOAD_LOST_AFTER_MS - 1 } as never });
    clearTtlCache(); // a new service worker: nothing in flight in memory
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading', mode: 'stamped' });
    const second = sentId(1);
    expect(second).not.toBe(first);
    await onPendingUploadResult(first, { ok: false, code: 'failed', error: 'late failure', updates: [] });
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'uploading' } });
    await onPendingUploadResult(first, { ok: true, batchId: id(1), evidenceRef: id(5), updates: [] });
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'uploading' } });
    await onPendingUploadResult(second, { ok: true, batchId: id(1), evidenceRef: id(7), updates: [] });
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'uploaded', evidenceRef: id(7) } });
  });

  it('two captures never upload at once, and never share a batch or its stamp heights', async () => {
    const OTHER = 'f'.repeat(32);
    pool.value = [batch(1), batch(2)];
    await savePending({ captureId: OTHER, kind: 'capture', evidence, bodySha256: id(9), createdAt: Date.now() });
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading', mode: 'stamped' });
    // While the first runs, the second is refused (its pool view would be stale).
    expect(await uploadPending(OTHER, 'stamped')).toEqual({ error: UPLOAD_BUSY });
    expect(uploads()).toHaveLength(1);
    // The first used batch 1 and stamped some slots.
    await onPendingUploadResult(sentId(0), {
      ok: true,
      batchId: id(1),
      evidenceRef: id(7),
      updates: [{ batchId: id(1), used: true, stamper: [[3, 1]] }],
    });
    expect(await uploadPending(OTHER, 'stamped')).toEqual({ status: 'uploading', mode: 'stamped' });
    const second = uploads()[1]![0] as { candidates: { batchId: Hex }[] };
    expect(second.candidates.map((c) => c.batchId)).toEqual([id(2)]);
    // A failed first attempt leaves the batch unused, but the second reads its stored heights.
    local.clear();
    clearTtlCache();
    pool.value = [batch(1)];
    sendMessage.mockClear();
    await savePending({ captureId: CID, kind: 'capture', evidence, bodySha256: id(9), createdAt: Date.now() });
    await savePending({ captureId: OTHER, kind: 'capture', evidence, bodySha256: id(9), createdAt: Date.now() });
    await uploadPending(CID, 'stamped');
    await onPendingUploadResult(sentId(0), {
      ok: false,
      code: 'failed',
      error: 'the upload to Swarm failed: 500',
      updates: [{ batchId: id(1), stamper: [[3, 2]] }],
    });
    await uploadPending(OTHER, 'stamped');
    expect((uploads()[1]![0] as { candidates: { stamper?: unknown }[] }).candidates[0]!.stamper).toEqual([[3, 2]]);
  });

  it('a batch with less than 2 days left is not storage', async () => {
    ttls.set(id(1), 86_400n);
    expect(await pendingAnswer(CID)).toMatchObject({ storage: 'empty' });
    clearTtlCache();
    ttls.set(id(1), null);
    expect(await uploadPending(CID, 'stamped')).toEqual({ error: 'the extension has no storage batch to upload with' });
    clearTtlCache();
    ttls.delete(id(1));
    expect(await pendingAnswer(CID)).toMatchObject({ storage: 'ok' });
  });

  it('an upload that never reported back is lost after a while, and may start again', async () => {
    await uploadPending(CID, 'stamped');
    const rec = await readPending(CID);
    await savePending({ ...rec!, upload: { status: 'uploading', mode: 'stamped', at: Date.now() - UPLOAD_LOST_AFTER_MS - 1, attempt: 'old' } });
    clearTtlCache(); // a new service worker: nothing in flight in memory
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'failed', reason: 'the upload did not finish', mode: 'stamped' } });
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading', mode: 'stamped' });
    expect(uploads()).toHaveLength(2);
  });

  it('a late result never brings back a discarded capture (the pool still learns)', async () => {
    await uploadPending(CID, 'stamped');
    expect(await discardPending(CID)).toEqual({ ok: true });
    await onPendingUploadResult(sentId(), { ok: true, batchId: id(1), evidenceRef: id(7), updates: [{ batchId: id(1), used: true }] });
    expect(await readPending(CID)).toBeNull();
    expect(applyBatchUpdates).toHaveBeenCalled();
  });

  it('refuses with no batch, for a confirmation, for a bad mode or id; free mode needs the setting', async () => {
    pool.value = [];
    expect(await uploadPending(CID, 'stamped')).toEqual({ error: 'the extension has no storage batch to upload with' });
    expect(await uploadPending(CID, 'cheap')).toMatchObject({ error: expect.any(String) });
    expect(await uploadPending(CID.toUpperCase(), 'stamped')).toEqual({ error: 'no pending capture with this id' });
    const conf = 'e'.repeat(32);
    await savePending({ captureId: conf, kind: 'confirmation', evidence, captureKey: id(3), since: '1', bodySha256: id(9), createdAt: Date.now() });
    settings.uploadMode = 'free';
    expect(await uploadPending(conf, 'free')).toEqual({ error: 'a confirmation needs no upload' });
    expect(uploads()).toHaveLength(0);
    // Free mode: no batch, no stamp key.
    expect(await uploadPending(CID, 'free')).toEqual({ status: 'uploading', mode: 'free' });
    const msg = uploads()[0][0] as Record<string, unknown>;
    expect(msg).toMatchObject({ mode: 'free', candidates: [] });
    expect(msg.stampKey).toBeUndefined();
  });

  it('an uploader that does not start is a failure the tab can retry', async () => {
    sendMessage.mockResolvedValueOnce(undefined);
    expect(await uploadPending(CID, 'stamped')).toMatchObject({ error: expect.stringMatching(/could not start/) });
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'failed' } });
  });
});
