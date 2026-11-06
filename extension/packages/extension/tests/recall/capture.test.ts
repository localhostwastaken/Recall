import { beforeEach, describe, expect, it, vi } from 'vitest';

// captureUrl with a fake ProveManager: the orchestration only, no wasm or witness.

const fake = {
  initFails: 0,
  inits: 0,
  sent: new Uint8Array([1]),
  recv: new Uint8Array([2]),
  headers: undefined as Record<string, string> | undefined,
  cleanedUp: [] as string[],
};

vi.mock('../../src/recall/build', () => ({ RECALL_DEV: true, DEV_ROOT_CERTS: undefined }));
vi.mock('../../src/offscreen/ProveManager', () => ({
  ProveManager: class {
    async init() {
      fake.inits++;
      if (fake.initFails > 0) {
        fake.initFails--;
        throw new Error('wasm init failed');
      }
    }
    async newProver() {
      return 'prover-1';
    }
    async openSession() {
      return 'ws://witness/verifier?sessionId=s-1';
    }
    async setupProver() {}
    getSessionId() {
      return 's-1';
    }
    async sendRequest(_id: string, _proxy: string, req: { headers: Record<string, string> }) {
      fake.headers = req.headers;
    }
    getSentBytes() {
      return fake.sent;
    }
    getRecvBytes() {
      return fake.recv;
    }
    async computeReveal() {
      throw new Error('not reached in these tests');
    }
    async witnessError() {
      return null;
    }
    async abort() {}
    async cleanupProver(id: string) {
      fake.cleanedUp.push(id);
    }
  },
}));

const { captureUrl, proveManager, TRANSCRIPT_UNAVAILABLE } =
  await import('../../src/recall/capture');
const { CAPTURE_USER_AGENT } = await import('../../src/recall/captureParts');

// The size pre-check is not under test here: fetch fails, which the pre-check treats as ok.
vi.stubGlobal(
  'fetch',
  vi.fn(async () => {
    throw new TypeError('offline');
  }),
);

describe('captureUrl', () => {
  beforeEach(() => {
    fake.sent = new Uint8Array([1]);
    fake.recv = new Uint8Array([2]);
    fake.cleanedUp = [];
  });

  it('retries the prover init after a failed one (the failure is not cached)', async () => {
    fake.initFails = 1;
    const before = fake.inits;
    await expect(proveManager()).rejects.toThrow('wasm init failed');
    await expect(proveManager()).resolves.toBeDefined();
    expect(fake.inits - before).toBe(2);
  });

  it('fails clearly when the transcript is unavailable, instead of building evidence', async () => {
    fake.recv = new Uint8Array();
    const r = await captureUrl('https://notice.recall.test/notice', {
      witnessUrl: 'http://localhost:7047',
    });
    expect(r).toEqual({ error: TRANSCRIPT_UNAVAILABLE, code: 'failed' });
    expect(TRANSCRIPT_UNAVAILABLE).toBe('capture failed: transcript unavailable');
    expect(fake.cleanedUp).toEqual(['prover-1']);
    // R26: the request carried the fixed User-Agent.
    expect(fake.headers?.['User-Agent']).toBe(CAPTURE_USER_AGENT);
  });
});
