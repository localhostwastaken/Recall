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
const pool: { value: unknown[] } = { value: [] };
const applyBatchUpdates = vi.fn(async () => undefined);
vi.mock('../../src/recall/pool', () => ({
  loadPool: vi.fn(async () => pool.value),
  applyBatchUpdates: (u: unknown) => applyBatchUpdates(u as never),
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

const { uploadPending, onPendingUploadResult, pendingAnswer } = await import('../../src/recall/pendingUpload');
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
const batch = { batchId: id(1), depth: 17, used: false, usable: true, startBlock: '1', addedAt: 1 };

beforeEach(async () => {
  local.clear();
  pool.value = [batch];
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
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading' });
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0][0]).toMatchObject({ id: CID, mode: 'stamped', candidates: [{ batchId: id(1) }] });
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading' });
    expect(await uploadPending(CID, 'free')).toMatchObject({ error: expect.stringMatching(/free storage is turned off/) });
    expect(uploads()).toHaveLength(1);
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'uploading' } });
  });

  it('after success it reports the reference and never uploads again', async () => {
    await uploadPending(CID, 'stamped');
    const updates = [{ batchId: id(1), used: true }];
    await onPendingUploadResult(CID, { ok: true, batchId: id(1), evidenceRef: id(7), updates });
    expect(applyBatchUpdates).toHaveBeenCalledWith(updates);
    expect(await pendingAnswer(CID)).toMatchObject({
      evidenceRef: id(7),
      batchId: id(1),
      upload: { status: 'uploaded', evidenceRef: id(7), batchId: id(1) },
    });
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploaded', evidenceRef: id(7), batchId: id(1) });
    expect(uploads()).toHaveLength(1);
  });

  it('a failure keeps the capture and its reason; "try again" uploads again', async () => {
    await uploadPending(CID, 'stamped');
    await onPendingUploadResult(CID, { ok: false, code: 'failed', error: 'the upload to Swarm failed: 500', updates: [] });
    expect(await pendingAnswer(CID)).toMatchObject({
      evidence,
      upload: { status: 'failed', reason: 'the upload to Swarm failed: 500' },
    });
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading' });
    expect(uploads()).toHaveLength(2);
  });

  it('an upload that never reported back is lost after a while, and may start again', async () => {
    await uploadPending(CID, 'stamped');
    const rec = await readPending(CID);
    await savePending({ ...rec!, upload: { status: 'uploading', mode: 'stamped', at: Date.now() - UPLOAD_LOST_AFTER_MS - 1 } });
    expect(await pendingAnswer(CID)).toMatchObject({ upload: { status: 'failed', reason: 'the upload did not finish' } });
    expect(await uploadPending(CID, 'stamped')).toEqual({ status: 'uploading' });
    expect(uploads()).toHaveLength(2);
  });

  it('a late result never brings back a discarded capture (the pool still learns)', async () => {
    await uploadPending(CID, 'stamped');
    expect(await discardPending(CID)).toEqual({ ok: true });
    await onPendingUploadResult(CID, { ok: true, batchId: id(1), evidenceRef: id(7), updates: [{ batchId: id(1), used: true }] });
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
    expect(await uploadPending(CID, 'free')).toEqual({ status: 'uploading' });
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
