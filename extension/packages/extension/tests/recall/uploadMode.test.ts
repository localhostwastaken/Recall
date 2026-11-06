// The free upload mode (R13, spec D11's demo-day fallback): the evidence goes to a gateway's own
// free storage (POST /bytes), no batch is taken from the pool and the record carries the
// all-zero batch id.
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { encodeEvidence, type EvidenceFile } from '@recall/evidence';
import { uploadEvidence } from '../../src/recall/swarmUpload';
import {
  FREE_BATCH_ID,
  UPLOAD_TIMEOUT_MS,
  uploadIsPlanned,
  type OffscreenUpload,
} from '../../src/recall/uploadParts';

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
const batch = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const candidates = [
  { batchId: batch(1), depth: 17, startBlock: '10' },
  { batchId: batch(2), depth: 17, startBlock: '10' },
];

const freeReq: OffscreenUpload = {
  type: 'recall.offscreen.upload',
  id: 'job',
  mode: 'free',
  evidence,
  candidates: [],
  uploadUrl: 'https://gateway.example.org',
  gnosisRpcUrl: 'http://rpc',
  waitMs: 5_000,
};

/** Everything a stamped upload would touch: any call to one of these in free mode is a bug. */
function stampedTools() {
  return {
    fetch: vi.fn(),
    blockNumber: vi.fn(),
    batchTtl: vi.fn(),
    upload: vi.fn(),
  };
}

describe('uploadIsPlanned', () => {
  it('stamped mode needs a batch in the pool', () => {
    expect(uploadIsPlanned('stamped', 0)).toBe(false);
    expect(uploadIsPlanned('stamped', 1)).toBe(true);
  });
  it('free mode needs no batch', () => {
    expect(uploadIsPlanned('free', 0)).toBe(true);
    expect(uploadIsPlanned('free', 5)).toBe(true);
  });
});

describe('free upload mode', () => {
  it('the free batch id is 32 zero bytes', () => {
    expect(FREE_BATCH_ID).toBe(`0x${'0'.repeat(64)}`);
  });

  it('uploads the encoded evidence through uploadFree and reports the zero batch id', async () => {
    const tools = stampedTools();
    const uploadFree = vi.fn(async () => `0x${'AB'.repeat(32)}` as Hex);
    const r = await uploadEvidence(freeReq, { ...tools, uploadFree });
    expect(r).toEqual({
      ok: true,
      batchId: FREE_BATCH_ID,
      evidenceRef: `0x${'ab'.repeat(32)}`,
      updates: [],
    });
    expect(uploadFree).toHaveBeenCalledTimes(1);
    const [bytes, url] = uploadFree.mock.calls[0] as unknown as [Uint8Array, string];
    expect(Buffer.from(bytes).equals(Buffer.from(encodeEvidence(evidence)))).toBe(true);
    expect(url).toBe('https://gateway.example.org');
    // No stamper, no chain read, no Bee batch list: nothing of the pool path ran.
    for (const [name, fn] of Object.entries(tools)) expect(fn, name).not.toHaveBeenCalled();
  });

  it('leaves the pool alone even when batches are offered: no update for any batch', async () => {
    const tools = stampedTools();
    const uploadFree = vi.fn(async () => `0x${'cd'.repeat(32)}` as Hex);
    const r = await uploadEvidence({ ...freeReq, candidates }, { ...tools, uploadFree });
    expect(r).toMatchObject({ ok: true, batchId: FREE_BATCH_ID, updates: [] });
    for (const fn of Object.values(tools)) expect(fn).not.toHaveBeenCalled();
  });

  it('never needs or uses a stamp key', async () => {
    const uploadFree = vi.fn(async () => `0x${'ef'.repeat(32)}` as Hex);
    // A request that carries one anyway is not an error, but the key is not touched.
    const r = await uploadEvidence({ ...freeReq, stampKey: generatePrivateKey() }, { ...stampedTools(), uploadFree });
    expect(r.ok).toBe(true);
  });

  it('a failed upload is a failure of the attempt, with the reason and no batch updates', async () => {
    const uploadFree = vi.fn(async () => {
      throw new Error('free upload failed: 503');
    });
    const r = await uploadEvidence(freeReq, { ...stampedTools(), uploadFree });
    expect(r).toEqual({
      ok: false,
      code: 'failed',
      error: 'the upload to Swarm failed: free upload failed: 503',
      updates: [],
    });
  });

  it('refuses a reference that is not 32 bytes of hex', async () => {
    const uploadFree = vi.fn(async () => '0x1234' as Hex);
    const r = await uploadEvidence(freeReq, { ...stampedTools(), uploadFree });
    expect(r).toMatchObject({ ok: false, code: 'failed', updates: [] });
  });

  it('gives up when the gateway does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      const uploadFree = vi.fn(() => new Promise<Hex>(() => undefined));
      const result = uploadEvidence(freeReq, { ...stampedTools(), uploadFree });
      await vi.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS + 1_000);
      expect(await result).toMatchObject({ ok: false, code: 'failed', error: expect.stringMatching(/did not finish/), updates: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at once when the capture was cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const uploadFree = vi.fn();
    const r = await uploadEvidence(freeReq, { ...stampedTools(), uploadFree }, ctl.signal);
    expect(r).toMatchObject({ ok: false, code: 'failed', error: 'upload cancelled' });
    expect(uploadFree).not.toHaveBeenCalled();
  });

  it('a stamped request still needs its stamp key (the default mode is unchanged)', async () => {
    const r = await uploadEvidence(
      { ...freeReq, mode: 'stamped', candidates },
      { fetch: vi.fn(), blockNumber: async () => 500n, batchTtl: async () => 10_000_000n, upload: vi.fn(), uploadFree: vi.fn() },
    );
    expect(r).toMatchObject({ ok: false });
  });
});
