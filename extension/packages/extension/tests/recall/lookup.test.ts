import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../src/recall/settings';

const PINNED = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
let settings: Settings;

vi.mock('../../src/recall/offscreen', () => ({ ensureOffscreen: vi.fn(async () => undefined) }));
vi.mock('../../src/recall/settings', async (orig) => ({
  ...(await orig<typeof import('../../src/recall/settings')>()),
  loadSettings: vi.fn(async () => settings),
}));

const { latestVerifiedCapture, resolveWitness, earlierCaptures, witnessForCapture, announcedUrlAllowed } = await import(
  '../../src/recall/lookup'
);
const { loadSettings } = await import('../../src/recall/settings');

const sendMessage = chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
const KEY = `0x${'ab'.repeat(32)}`;

/** `GET <url>/info` answers: url -> signer (missing: unreachable). */
function witnesses(answers: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: URL | string) => {
      const base = String(u).replace(/\/info$/, '');
      if (!(base in answers)) throw new TypeError('connection refused');
      return new Response(JSON.stringify({ signer: answers[base] }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  sendMessage.mockReset();
  settings = {
    net: 'local',
    witnessUrl: 'http://localhost:7047',
    pinnedWitnesses: [PINNED],
    appUrl: 'http://localhost:5173',
  };
});

describe('same-page lookup (service worker side)', () => {
  it('a listing cut short is unknown: no confirmation, upload (R10)', async () => {
    const latest = { entityKey: KEY, bodySha256: KEY, signedAt: '100' };
    sendMessage.mockResolvedValueOnce({ latest, truncated: true });
    expect(await latestVerifiedCapture(KEY)).toBeNull();
    sendMessage.mockResolvedValueOnce({ latest, truncated: false });
    expect(await latestVerifiedCapture(KEY)).toEqual(latest);
    sendMessage.mockResolvedValueOnce({ error: 'arkiv down' });
    expect(await latestVerifiedCapture(KEY)).toBeNull();
  });

  it('the new capture signed time goes to the offscreen check (later claims are skipped there)', async () => {
    sendMessage.mockResolvedValueOnce({ latest: null, truncated: false });
    await latestVerifiedCapture(KEY, 1_793_800_000n);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ want: 'latest', before: '1793800000' });
    sendMessage.mockResolvedValueOnce({ latest: null, truncated: false });
    await latestVerifiedCapture(KEY);
    expect(sendMessage.mock.calls[1][0]).not.toHaveProperty('before');
  });

  it('with no pinned witness nothing can verify, so nothing is asked', async () => {
    settings.pinnedWitnesses = [];
    expect(await latestVerifiedCapture(KEY)).toBeNull();
    const earlier = await earlierCaptures('https://notice.recall.test/notice');
    expect(earlier).toMatchObject({ trusted: false, versions: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('earlier captures carry the timeline link of the canonical address', async () => {
    sendMessage.mockResolvedValueOnce({ versions: 1, confirmations: 0, latest: '1', records: 1, unavailable: 0, incomplete: false });
    const r = await earlierCaptures('https://NOTICE.recall.test/notice#frag');
    expect(r).toMatchObject({ trusted: true, versions: 1 });
    expect('timelineUrl' in r && r.timelineUrl).toMatch(/^http:\/\/localhost:5173\/#\/u\/0x[0-9a-f]{64}$/);
    expect(await earlierCaptures('http://plain.example/')).toEqual({ error: expect.stringMatching(/https/) });
  });
});

describe('witness discovery', () => {
  it('uses the URL the pinned witness announced, before the settings URL', async () => {
    sendMessage.mockResolvedValue({ url: 'https://tunnel.example' });
    witnesses({ 'https://tunnel.example': PINNED, 'http://localhost:7047': PINNED });
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'https://tunnel.example', online: true });
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'recall.offscreen.witnessUrl', witness: PINNED }));
  });

  it('falls back to the settings URL when the announced one is down or answers for another key', async () => {
    sendMessage.mockResolvedValue({ url: 'https://tunnel.example' });
    witnesses({ 'http://localhost:7047': PINNED });
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: true });
    witnesses({ 'https://tunnel.example': OTHER, 'http://localhost:7047': PINNED });
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: true });
  });

  it('offline when no candidate answers as a pinned witness; a bad announced URL is ignored', async () => {
    sendMessage.mockResolvedValue({ url: 'javascript:alert(1)' });
    witnesses({ 'http://localhost:7047': OTHER });
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: false, why: 'wrong_signer' });
    sendMessage.mockRejectedValue(new Error('offscreen gone'));
    witnesses({});
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: false, why: 'unreachable' });
  });

  it('says why a witness is offline: a timeout is the network, a wrong signer is security and wins', async () => {
    // `/info` of the listed URLs times out (as fetch reports it); the others answer for OTHER.
    const timesOut = (...urls: string[]) =>
      vi.fn(async (u: URL | string) => {
        if (urls.includes(String(u).replace(/\/info$/, ''))) throw new DOMException('signal timed out', 'TimeoutError');
        return new Response(JSON.stringify({ signer: OTHER }), { status: 200 });
      });
    // Nothing answers in time: the network.
    sendMessage.mockResolvedValue({ url: null });
    vi.stubGlobal('fetch', timesOut('http://localhost:7047'));
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: false, why: 'timeout' });
    // One candidate timed out, the other answered for a key that is not pinned: a security matter.
    sendMessage.mockResolvedValue({ url: 'https://tunnel.example' });
    vi.stubGlobal('fetch', timesOut('https://tunnel.example'));
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'https://tunnel.example', online: false, why: 'wrong_signer' });
    vi.unstubAllGlobals();
  });

  it('with nothing pinned, the settings URL and any signer (dev default)', async () => {
    settings.pinnedWitnesses = [];
    witnesses({ 'http://localhost:7047': OTHER });
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('an announced URL must be https (plain http only for this machine)', async () => {
    expect(announcedUrlAllowed('https://tunnel.example')).toBe(true);
    expect(announcedUrlAllowed('http://localhost:7047')).toBe(true);
    expect(announcedUrlAllowed('http://127.0.0.1:7047')).toBe(true);
    expect(announcedUrlAllowed('http://witness.example')).toBe(false);
    expect(announcedUrlAllowed('http://192.168.1.5:7047')).toBe(false);
    expect(announcedUrlAllowed('https://user:pw@tunnel.example')).toBe(false);
    expect(announcedUrlAllowed('javascript:alert(1)')).toBe(false);
    // A plain-http announcement elsewhere is never followed, even if it answers as the witness.
    sendMessage.mockResolvedValue({ url: 'http://witness.example' });
    witnesses({ 'http://witness.example': PINNED, 'http://localhost:7047': PINNED });
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: true });
  });
});

describe('the witness for a new capture (fail closed)', () => {
  it('is the resolved one, offline included (an offline result is never cached)', async () => {
    sendMessage.mockResolvedValue({ url: null });
    witnesses({});
    expect(await resolveWitness({ fresh: true })).toEqual({ url: 'http://localhost:7047', online: false, why: 'unreachable' });
    expect(await witnessForCapture()).toEqual({ url: 'http://localhost:7047', online: false, why: 'unreachable' });
  });

  it('when the lookup itself fails, still checks the settings URL against the pinned list', async () => {
    const load = loadSettings as unknown as ReturnType<typeof vi.fn>;
    load.mockRejectedValueOnce(new Error('storage busy'));
    witnesses({ 'http://localhost:7047': OTHER });
    expect(await witnessForCapture()).toEqual({ url: 'http://localhost:7047', online: false });
    load.mockRejectedValueOnce(new Error('storage busy'));
    witnesses({ 'http://localhost:7047': PINNED });
    expect(await witnessForCapture()).toEqual({ url: 'http://localhost:7047', online: true });
    load.mockRejectedValueOnce(new Error('storage busy')).mockRejectedValueOnce(new Error('still busy'));
    expect(await witnessForCapture()).toEqual({ online: false });
  });
});
