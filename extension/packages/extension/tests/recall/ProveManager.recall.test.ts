import { beforeEach, describe, expect, it, vi } from 'vitest';

// Recall changes to the vendored ProveManager: the witness's signed `attestation`
// survives `session_completed`, and the build-time dev CA becomes `root_certs`.

const DEV_CERTS = [[0x30, 0x82, 0x01, 0x02]];
vi.mock('../../src/recall/build', () => ({ DEV_ROOT_CERTS: DEV_CERTS, RECALL_DEV: true }));

const mockWorkerApi = {
  init: vi.fn().mockResolvedValue(undefined),
  createProver: vi.fn().mockResolvedValue('prover-0'),
  setupProver: vi.fn().mockResolvedValue(undefined),
  setupProverRelay: vi.fn().mockResolvedValue(undefined),
  freeProver: vi.fn().mockResolvedValue(undefined),
};
vi.mock('comlink', () => ({ wrap: () => mockWorkerApi, proxy: (f: unknown) => f }));
vi.stubGlobal(
  'Worker',
  class {
    addEventListener = vi.fn();
    postMessage = vi.fn();
  },
);

/** A fake witness: registers the session, then completes it with `completion`. */
let completion: Record<string, unknown> = {};
class FakeWitnessSocket {
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }
  send(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.type === 'register') {
      setTimeout(() => {
        this.onmessage?.({ data: JSON.stringify({ type: 'session_registered', sessionId: 's-1' }) });
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(completion) }), 0);
      }, 0);
    }
  }
  close() {
    this.readyState = 3;
  }
}
vi.stubGlobal('WebSocket', FakeWitnessSocket);

const { ProveManager } = await import('../../src/offscreen/ProveManager/index');

const ATTESTATION = {
  message: { serverName: 'notice.recall.test', connTime: '1', signedAt: '2' },
  signature: '0x' + 'ab'.repeat(65),
  signer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
};

describe('ProveManager (Recall)', () => {
  beforeEach(() => {
    mockWorkerApi.createProver.mockClear();
    mockWorkerApi.setupProver.mockClear();
  });

  it('keeps the witness attestation from session_completed', async () => {
    completion = { type: 'session_completed', results: [{ type: 'RECALL_ATTESTATION', value: '{}' }], attestation: ATTESTATION };
    const pm = new ProveManager();
    const proverId = await pm.createProver('notice.recall.test', 'http://localhost:7047', 65536, 4096, {});
    expect(mockWorkerApi.setupProver).toHaveBeenCalledWith(proverId, 'ws://localhost:7047/verifier?sessionId=s-1');
    const response = await pm.getResponse(proverId, 5);
    expect(response).toEqual({ results: completion.results, attestation: ATTESTATION });
  });

  it('passes the build-time dev CA as root_certs', async () => {
    const pm = new ProveManager();
    await pm.createProver('notice.recall.test', 'http://localhost:7047');
    expect(mockWorkerApi.createProver.mock.calls[0][0].root_certs).toEqual(DEV_CERTS);

    await pm.createProverRelay('notice.recall.test', () => {});
    expect(mockWorkerApi.createProver.mock.calls[1][0].root_certs).toEqual(DEV_CERTS);
  });
});
