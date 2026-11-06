import { beforeEach, describe, expect, it, vi } from 'vitest';

// The capture job, with the witness lookup, offscreen document, pool and storage stubbed.
const witnessForCapture = vi.fn();
vi.mock('../../src/recall/lookup', () => ({
  witnessForCapture: () => witnessForCapture(),
  latestVerifiedCapture: vi.fn(async () => null),
  openApproveTab: vi.fn(async () => undefined),
}));
vi.mock('../../src/recall/offscreen', () => ({ ensureOffscreen: vi.fn(async () => undefined) }));
vi.mock('../../src/recall/pool', () => ({ loadPool: vi.fn(async () => []), applyBatchUpdates: vi.fn() }));
vi.mock('../../src/recall/stamp', () => ({ stampKey: vi.fn() }));
vi.mock('../../src/recall/settings', async (orig) => ({
  ...(await orig<typeof import('../../src/recall/settings')>()),
  loadSettings: vi.fn(async () => ({
    net: 'local',
    witnessUrl: 'http://localhost:7047',
    pinnedWitnesses: ['0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'],
    appUrl: 'http://localhost:5173',
  })),
}));

/** chrome.storage.session as an in-memory area. */
const session = new Map<string, unknown>();
(chrome.storage as unknown as { session: object }).session = {
  get: async (k: string) => (session.has(k) ? { [k]: structuredClone(session.get(k)) } : {}),
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) session.set(k, structuredClone(v));
  },
  remove: async (k: string) => void session.delete(k),
};

const { startCapture, captureForTest, readCaptureState, clearFinishedCapture } = await import(
  '../../src/recall/job'
);
const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
const offscreenCaptures = () =>
  sendMessage.mock.calls.filter(([m]) => (m as { type?: string })?.type === 'recall.offscreen.capture');

beforeEach(() => {
  session.clear();
  witnessForCapture.mockReset();
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ accepted: true });
});

describe('starting a capture (fail closed on the witness)', () => {
  it('a witness that failed its signer check is never used: the capture ends "witness offline"', async () => {
    witnessForCapture.mockResolvedValue({ url: 'http://localhost:7047', online: false });
    await startCapture('https://notice.recall.test/notice');
    expect(await readCaptureState()).toMatchObject({
      status: 'error',
      code: 'witness_offline',
      error: 'the witness is offline',
    });
    expect(offscreenCaptures()).toHaveLength(0);
  });

  it('a witness whose /info timed out ends as a network failure, not "witness offline"', async () => {
    witnessForCapture.mockResolvedValue({ url: 'http://localhost:7047', online: false, why: 'timeout' });
    await startCapture('https://notice.recall.test/notice');
    expect(await readCaptureState()).toMatchObject({ status: 'error', code: 'network' });
    expect(offscreenCaptures()).toHaveLength(0);
    // A wrong signer stays "witness offline": it is never worded as a connection problem.
    session.clear();
    witnessForCapture.mockResolvedValue({ url: 'http://localhost:7047', online: false, why: 'wrong_signer' });
    await startCapture('https://notice.recall.test/notice');
    expect(await readCaptureState()).toMatchObject({ status: 'error', code: 'witness_offline' });
  });

  it('no witness URL at all: witness offline too', async () => {
    witnessForCapture.mockResolvedValue({ online: false });
    await startCapture('https://notice.recall.test/notice');
    expect(await readCaptureState()).toMatchObject({ status: 'error', code: 'witness_offline' });
    expect(offscreenCaptures()).toHaveLength(0);
  });

  it('captureForTest reports the same refusal', async () => {
    witnessForCapture.mockResolvedValue({ url: 'http://localhost:7047', online: false });
    expect(await captureForTest('https://notice.recall.test/notice')).toEqual({
      error: 'the witness is offline',
      code: 'witness_offline',
    });
  });

  it('an online witness: the prover starts against the URL that passed the check', async () => {
    witnessForCapture.mockResolvedValue({ url: 'https://tunnel.example', online: true });
    await startCapture('https://notice.recall.test/notice');
    expect(offscreenCaptures()).toHaveLength(1);
    expect(offscreenCaptures()[0][0]).toMatchObject({ witnessUrl: 'https://tunnel.example' });
    // Witnesses are pinned, so the steps include the same-page check.
    expect(await readCaptureState()).toMatchObject({ status: 'running', step: 1, lookupPlanned: true });
  });
});

describe('a capture published or discarded in the Recall tab', () => {
  const KEY = 'recall.capture';
  const done = (upload: Record<string, unknown>) => ({
    id: 'job1',
    url: 'https://notice.recall.test/notice',
    startedAt: 1,
    status: 'done',
    finishedAt: 2,
    evidence: {},
    checks: {},
    upload,
  });
  const CID = 'a'.repeat(32);

  it('clears the popup result of that capture, so the popup goes back to idle', async () => {
    session.set(KEY, done({ status: 'pending', captureId: CID }));
    await clearFinishedCapture(CID);
    expect(session.has(KEY)).toBe(false);
    session.set(KEY, done({ status: 'confirmation', captureId: CID, captureKey: '0x03', since: '1' }));
    await clearFinishedCapture(CID);
    expect(session.has(KEY)).toBe(false);
  });

  it('leaves any other result alone (another capture, a running job, a failure)', async () => {
    const other = done({ status: 'pending', captureId: 'b'.repeat(32) });
    session.set(KEY, other);
    await clearFinishedCapture(CID);
    expect(session.get(KEY)).toEqual(other);
    const failed = done({ status: 'failed', error: 'x' });
    session.set(KEY, failed);
    await clearFinishedCapture(CID);
    expect(session.get(KEY)).toEqual(failed);
    const running = { id: 'job2', url: 'u', startedAt: Date.now(), status: 'running', step: 1 };
    session.set(KEY, running);
    await clearFinishedCapture(CID);
    expect(session.get(KEY)).toEqual(running);
  });
});
