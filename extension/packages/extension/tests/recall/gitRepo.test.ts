// The .git adapter in the extension (R46): the repository page, the capture URL, the code
// snapshot, and the upload of the evidence plus the snapshot.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { gitTreeFromTarGz, type EvidenceFile } from '@recall/evidence';
import {
  DEV_GITHUB_HOSTS,
  RELEASE_GITHUB_HOSTS,
  SNAPSHOT_MISMATCH,
  codeloadUrl,
  fetchDefaultBranch,
  parseRepoPage,
  repoCaptureUrl,
  sha256Hex,
} from '../../src/recall/gitRepo';
import { repoSnapshot, type OffscreenRepoSnapshot } from '../../src/recall/repoSnapshot';
import { CODE_CHECK_STEP, DOWNLOAD_STEP, jobSteps, repoSubline } from '../../src/recall/captureView';
import { pendingUploadState, type PendingRecord } from '../../src/recall/pending';
import { uploadEvidence } from '../../src/recall/swarmUpload';
import { FREE_BATCH_ID, type OffscreenUpload } from '../../src/recall/uploadParts';

const tiny = new Uint8Array(
  readFileSync(path.resolve(__dirname, '../../../../../packages/evidence/test/vectors/git/tiny.tar.gz')),
);
const R = RELEASE_GITHUB_HOSTS;

describe('parseRepoPage', () => {
  it('reads a repository page and a branch page (the branch may contain "/")', () => {
    expect(parseRepoPage('https://github.com/permissionlesstech/bitchat', R)).toEqual({
      owner: 'permissionlesstech',
      repo: 'bitchat',
    });
    expect(parseRepoPage('https://github.com/o/r/?tab=readme#top', R)).toEqual({ owner: 'o', repo: 'r' });
    expect(parseRepoPage('https://github.com/o/r.git', R)).toEqual({ owner: 'o', repo: 'r' });
    expect(parseRepoPage('https://github.com/o/r/tree/main', R)).toEqual({ owner: 'o', repo: 'r', branch: 'main' });
    expect(parseRepoPage('https://github.com/o/r/tree/feature/x-1', R)).toEqual({
      owner: 'o',
      repo: 'r',
      branch: 'feature/x-1',
    });
  });

  it('refuses everything else', () => {
    for (const u of [
      'http://github.com/o/r',
      'https://github.com:8443/o/r',
      'https://gist.github.com/o/r',
      'https://github.com/o',
      'https://github.com/o/r/issues',
      'https://github.com/o/r/blob/main/README.md',
      'https://github.com/settings/profile',
      'https://github.com/-o/r',
      'https://github.com/o/r/tree/a..b',
      'https://github.com/o/r/tree/x.lock',
      'https://github.com/o/r/tree/%2Fmain',
      'https://github.com/o/r/tree/a%20b',
      'https://github.recall.test/o/r',
      'not a url',
    ]) {
      expect(parseRepoPage(u, R), u).toBeNull();
    }
  });

  it('a dev build also accepts the fixture page host', () => {
    expect(parseRepoPage('https://github.recall.test/recall-fixture/demo', DEV_GITHUB_HOSTS)).toEqual({
      owner: 'recall-fixture',
      repo: 'demo',
    });
  });
});

describe('capture and download URLs', () => {
  it('captures the GitHub API answer for the branch, downloads codeload', () => {
    expect(repoCaptureUrl({ owner: 'o', repo: 'r', branch: 'main' }, R)).toBe(
      'https://api.github.com/repos/o/r/branches/main',
    );
    expect(repoCaptureUrl({ owner: 'o', repo: 'r', branch: 'main' }, DEV_GITHUB_HOSTS)).toBe(
      'https://api.github.recall.test/repos/o/r/branches/main',
    );
    expect(codeloadUrl({ owner: 'o', repo: 'r' }, 'a'.repeat(40), R)).toBe(
      `https://codeload.github.com/o/r/tar.gz/${'a'.repeat(40)}`,
    );
    expect(() => codeloadUrl({ owner: 'o', repo: 'r' }, 'main', R)).toThrow();
  });
});

describe('fetchDefaultBranch', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reads default_branch without cookies', async () => {
    const f = answer(200, { default_branch: 'main' });
    await expect(fetchDefaultBranch({ owner: 'o', repo: 'r' }, f)).resolves.toBe('main');
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(init.credentials).toBe('omit');
  });

  it('fails on a missing repository or a branch name it does not accept', async () => {
    await expect(fetchDefaultBranch({ owner: 'o', repo: 'r' }, answer(404, {}))).rejects.toThrow(/no public repository/);
    await expect(fetchDefaultBranch({ owner: 'o', repo: 'r' }, answer(200, { default_branch: 'a..b' }))).rejects.toThrow();
    await expect(fetchDefaultBranch({ owner: 'o', repo: 'r' }, answer(200, {}))).rejects.toThrow();
  });
});

describe('popup copy', () => {
  it('adds the download and code-check steps for a repository', () => {
    const s = jobSteps({ step: 4, repo: true, lookupPlanned: true });
    expect(s.labels.slice(-2)).toEqual([DOWNLOAD_STEP, CODE_CHECK_STEP]);
    expect(s.labels[s.current]).toBe(DOWNLOAD_STEP);
    expect(jobSteps({ step: 5, repo: true }).current).toBe(4);
    expect(jobSteps({ step: 2 }).labels).not.toContain(DOWNLOAD_STEP);
    expect(repoSubline('main')).toBe("branch main · notarizes GitHub's commit, then checks the code");
  });
});

describe('repoSnapshot (offscreen)', () => {
  const { treeSha, files } = gitTreeFromTarGz(tiny);
  const req: OffscreenRepoSnapshot = {
    type: 'recall.offscreen.repoSnapshot',
    id: 'job',
    captureId: 'a'.repeat(32),
    owner: 'o',
    repo: 'r',
    commitSha: 'c'.repeat(40),
    treeSha,
  };
  const serve = (body: Uint8Array, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(body as Uint8Array<ArrayBuffer>, { status: 200, headers })) as unknown as typeof fetch;

  it('keeps the bytes when their tree is the notarized one', async () => {
    const store = vi.fn(async () => undefined);
    const f = serve(tiny);
    const r = await repoSnapshot(req, new AbortController().signal, { fetch: f, store });
    expect(r).toEqual({ ok: true, size: tiny.length, sha256: await sha256Hex(tiny), files });
    expect(store).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe(`https://codeload.github.com/o/r/tar.gz/${'c'.repeat(40)}`);
    expect(init.credentials).toBe('omit');
  });

  it('keeps nothing when the tree differs', async () => {
    const store = vi.fn(async () => undefined);
    const r = await repoSnapshot({ ...req, treeSha: 'f'.repeat(40) }, new AbortController().signal, {
      fetch: serve(tiny),
      store,
    });
    expect(r).toEqual({ ok: false, error: SNAPSHOT_MISMATCH });
    expect(store).not.toHaveBeenCalled();
  });

  it('refuses a download over 25 MB before reading it', async () => {
    const store = vi.fn(async () => undefined);
    const r = await repoSnapshot(req, new AbortController().signal, {
      fetch: serve(tiny, { 'content-length': String(26 * 1024 * 1024) }),
      store,
    });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
    expect(store).not.toHaveBeenCalled();
  });
});

const WITNESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const evidence: EvidenceFile = {
  schema: 'recall.evidence.v1',
  statement: {
    serverName: 'api.github.com',
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
  meta: { capturedUrl: 'https://api.github.com/repos/o/r/branches/main', size: 3 },
};

describe('pending upload state with a repository snapshot', () => {
  const base: PendingRecord = {
    captureId: 'a'.repeat(32),
    kind: 'capture',
    evidence,
    bodySha256: `0x${'9'.repeat(64)}`,
    createdAt: 1,
    attachment: {
      kind: 'git',
      owner: 'o',
      repo: 'r',
      branch: 'main',
      commitSha: 'c'.repeat(40),
      treeSha: 'd'.repeat(40),
      size: 10,
      sha256: `0x${'e'.repeat(64)}`,
      files: 2,
      contentType: 'application/gzip',
    },
    needsDepth: 18,
  };
  it('is uploaded only once the snapshot is on Swarm too', () => {
    const ev = { evidenceRef: `0x${'1'.repeat(64)}` as Hex, batchId: `0x${'2'.repeat(64)}` as Hex };
    expect(pendingUploadState({ ...base, ...ev }).status).toBe('none');
    expect(pendingUploadState({ ...base, ...ev, attachmentRef: `0x${'3'.repeat(64)}` })).toEqual({
      status: 'uploaded',
      ...ev,
      attachmentRef: `0x${'3'.repeat(64)}`,
    });
  });
});

describe('uploadEvidence with a repository snapshot', () => {
  const snap = new Uint8Array([1, 2, 3, 4, 5]);
  const attachment = { captureId: 'a'.repeat(32), size: snap.length, sha256: '' };
  const freeReq = async (): Promise<OffscreenUpload> => ({
    type: 'recall.offscreen.upload',
    id: 'job',
    mode: 'free',
    evidence,
    candidates: [],
    uploadUrl: 'https://gateway.example.org',
    gnosisRpcUrl: 'http://rpc',
    waitMs: 5_000,
    attachment: { ...attachment, sha256: await sha256Hex(snap) },
  });

  it('free: uploads the evidence, then the snapshot, both through the gateway', async () => {
    let n = 0;
    const uploadFree = vi.fn(async () => `0x${String(++n).repeat(64)}` as Hex);
    const r = await uploadEvidence(await freeReq(), { uploadFree, loadAttachment: async () => snap });
    expect(r).toEqual({
      ok: true,
      batchId: FREE_BATCH_ID,
      evidenceRef: `0x${'1'.repeat(64)}`,
      attachmentRef: `0x${'2'.repeat(64)}`,
      updates: [],
    });
    expect((uploadFree.mock.calls[1] as unknown as [Uint8Array])[0]).toBe(snap);
  });

  it('fails closed when the kept bytes are gone or changed', async () => {
    const uploadFree = vi.fn(async () => `0x${'1'.repeat(64)}` as Hex);
    const gone = await uploadEvidence(await freeReq(), { uploadFree, loadAttachment: async () => null });
    expect(gone).toMatchObject({ ok: false, error: expect.stringMatching(/no longer in the extension/) });
    const changed = await uploadEvidence(await freeReq(), {
      uploadFree,
      loadAttachment: async () => new Uint8Array([9, 9, 9, 9, 9]),
    });
    expect(changed).toMatchObject({ ok: false, error: expect.stringMatching(/does not match/) });
    expect(uploadFree).not.toHaveBeenCalled();
  });

  it('stamped: both files go into the same batch, one stamper', async () => {
    const batchId = `0x${'7'.repeat(64)}` as Hex;
    const stamps: unknown[] = [];
    let n = 0;
    const upload = vi.fn(async (_b: Uint8Array, o: { stamper: { stamp(a: Uint8Array): unknown } }) => {
      const a = new Uint8Array(32);
      a[31] = ++n;
      stamps.push(o.stamper.stamp(a));
      return `0x${String(n).repeat(64)}` as Hex;
    });
    const req: OffscreenUpload = {
      ...(await freeReq()),
      mode: 'stamped',
      stampKey: generatePrivateKey(),
      candidates: [{ batchId, depth: 18, startBlock: '10' }],
    };
    const r = await uploadEvidence(req, {
      fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
      blockNumber: async () => 500n,
      batchTtl: async () => 10n ** 9n,
      upload: upload as never,
      uploadMany: upload as never,
      loadAttachment: async () => snap,
    });
    expect(r).toMatchObject({
      ok: true,
      batchId,
      evidenceRef: `0x${'1'.repeat(64)}`,
      attachmentRef: `0x${'2'.repeat(64)}`,
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(stamps).toHaveLength(2);
  });
});
