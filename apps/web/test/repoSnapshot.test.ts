import { readFileSync } from 'node:fs';
import type { ListedAttachment } from '@recall/net';
import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  attachmentClaimsFit,
  codeFileName,
  computeCode,
  repoUrlHash,
  snapshotDiffers,
  summaryDisagrees,
  type GitHubBranch,
  type RepoSummary,
} from '../src/attachments/git';

vi.mock('../src/wallet', () => ({ isUserRejection: () => false }));
const { chooseSnapshots, MAX_CHECKED } = await import('../src/attachments/useRepoSnapshot');
const { snapshotBadge } = await import('../src/components/RepoSnapshot');
vi.mock('../src/settings', () => ({ getSettings: () => ({}), defaultSettings: () => ({}), isSharedOrigin: () => false }));
const { ATTACHMENT_DEPTH, DEPTH, depthFor } = await import('../src/storage/buy');

// The evidence package's vector: `git archive` of a small repo whose tree is TINY_TREE.
const tiny = new Uint8Array(readFileSync(new URL('../../../packages/evidence/test/vectors/git/tiny.tar.gz', import.meta.url)));
const TINY_TREE = '39d1e9a33a4ead57af6666b9b8ed933e8c567aa8';
const COMMIT = 'a'.repeat(40);
const h = (c: string) => `0x${c.repeat(64)}` as Hex;

const branch: GitHubBranch = { owner: 'Acme', repo: 'Tool', branch: 'main', commitSha: COMMIT, treeSha: TINY_TREE };
const parent = { captureKey: h('1'), branch };

async function setup() {
  const computed = await computeCode(tiny);
  const record: ListedAttachment = {
    entityKey: h('9'),
    owner: '0x0000000000000000000000000000000000000001',
    creator: '0x0000000000000000000000000000000000000001',
    expiresAtBlock: 1n,
    parentCaptureKey: parent.captureKey,
    urlHash: repoUrlHash(branch),
    sha256: computed.sha256,
    kind: 'git',
    commitSha: COMMIT,
    treeSha: TINY_TREE,
    proofLevel: 1,
    evidenceRef: h('2'),
    batchId: h('3'),
    size: BigInt(tiny.length),
    contentType: 'application/gzip',
  };
  return { computed, record };
}

describe('repository snapshot (R46)', () => {
  it('recomputes the tree and the file hash of a tarball', async () => {
    const c = await computeCode(tiny);
    expect(c.treeSha).toBe(TINY_TREE);
    expect(c.files).toBe(11);
    expect(c.size).toBe(tiny.length);
    expect(c.sha256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is hash-anchored only when the code, the notarized commit and the record all agree', async () => {
    const { computed, record } = await setup();
    expect(attachmentClaimsFit(record, parent)).toBe(true);
    expect(snapshotDiffers(record, parent, computed)).toEqual([]);
    // Code whose tree is not the notarized one.
    expect(snapshotDiffers(record, { ...parent, branch: { ...branch, treeSha: 'b'.repeat(40) } }, computed)[0]).toMatch(/^code/);
    // A record that names other bytes, another parent, another commit or size.
    expect(snapshotDiffers({ ...record, sha256: h('4') }, parent, computed)).toEqual(['file hash']);
    expect(snapshotDiffers({ ...record, parentCaptureKey: h('5') }, parent, computed)).toEqual(['parent capture']);
    expect(snapshotDiffers({ ...record, commitSha: 'c'.repeat(40) }, parent, computed)).toEqual(['commit']);
    expect(snapshotDiffers({ ...record, size: 1n }, parent, computed)).toEqual(['size']);
    expect(snapshotDiffers({ ...record, kind: 'zip' }, parent, computed)).toEqual(['kind']);
  });

  it('does not download records that cannot describe this capture', async () => {
    const { record } = await setup();
    expect(attachmentClaimsFit({ ...record, parentCaptureKey: h('5') }, parent)).toBe(false);
    expect(attachmentClaimsFit({ ...record, treeSha: 'b'.repeat(40) }, parent)).toBe(false);
    expect(attachmentClaimsFit({ ...record, urlHash: h('6') }, parent)).toBe(false);
    expect(attachmentClaimsFit({ ...record, size: 26n * 1024n * 1024n }, parent)).toBe(false);
    expect(attachmentClaimsFit({ ...record, evidenceRef: '0x12' as Hex }, parent)).toBe(false);
  });

  it("checks the capture creator's records first, so other accounts can't crowd them out", async () => {
    const { record } = await setup();
    const OWNER = '0x00000000000000000000000000000000000000Aa' as const;
    const other = (n: number): ListedAttachment => ({
      ...record,
      entityKey: h(String(n)),
      creator: '0x0000000000000000000000000000000000000bad',
      evidenceRef: `0x${String(n).repeat(64)}` as Hex,
    });
    const mine = { ...record, entityKey: h('f'), creator: OWNER.toLowerCase() as `0x${string}`, evidenceRef: h('e') };
    // Six records by another account come first in Arkiv's order, then the creator's own, plus a
    // copy of the creator's record (same tarball) written earlier by someone else.
    const copy = { ...mine, entityKey: h('d'), creator: other(1).creator };
    const rows = [copy, other(2), other(3), other(4), other(5), other(6), other(7), mine];
    const chosen = chooseSnapshots(rows, parent, OWNER);
    expect(chosen).toHaveLength(MAX_CHECKED);
    expect(chosen[0]).toEqual({ record: mine, own: true });
    expect(chosen.slice(1).every((c) => !c.own)).toBe(true);
    expect(chosen.some((c) => c.record === copy)).toBe(false); // the creator's copy wins the tarball
    // Without a known creator nothing is "own", and Arkiv's order is kept.
    expect(chooseSnapshots(rows, parent, null).map((c) => c.own)).toEqual([false, false, false, false, false]);
  });

  it("shows another account's failing record as a neutral note, the creator's as a failure", () => {
    const mismatch = { phase: 'mismatch' as const, differs: ['code'] };
    expect(snapshotBadge({ own: false, state: mismatch })).toEqual({ status: 'unavailable', label: 'Not used' });
    expect(snapshotBadge({ own: true, state: mismatch }).status).toBe('fail');
    expect(snapshotBadge({ own: false, state: { phase: 'checking' } }).status).toBe('pending');
  });

  it("refuses an extension summary that disagrees with the page's own facts", () => {
    const s: RepoSummary = {
      kind: 'git',
      owner: 'acme',
      repo: 'tool',
      branch: 'main',
      commitSha: COMMIT,
      treeSha: TINY_TREE,
      size: 1000,
      sha256: h('7'),
      files: 3,
      contentType: 'application/gzip',
    };
    expect(summaryDisagrees(s, branch)).toBeNull();
    expect(summaryDisagrees(s, null)).toMatch(/GitHub branch/);
    expect(summaryDisagrees({ ...s, commitSha: 'b'.repeat(40) }, branch)).toMatch(/commit/);
    expect(summaryDisagrees({ ...s, treeSha: 'b'.repeat(40) }, branch)).toMatch(/tree/);
    expect(summaryDisagrees({ ...s, branch: 'dev' }, branch)).toMatch(/branch/);
    expect(summaryDisagrees({ ...s, repo: 'other' }, branch)).toMatch(/repository/);
    expect(summaryDisagrees({ ...s, size: 30 * 1024 * 1024 }, branch)).toMatch(/larger/);
    expect(summaryDisagrees({ ...s, contentType: 'text/html' }, branch)).toMatch(/tar\.gz/);
    expect(summaryDisagrees({ ...s, sha256: 'nope' }, branch)).toMatch(/hash/);
  });

  it('buys depth 18 only for a capture that asks for it', () => {
    expect(depthFor(18)).toBe(ATTACHMENT_DEPTH);
    expect(depthFor(undefined)).toBe(DEPTH);
    expect(depthFor(19)).toBe(DEPTH);
    expect(codeFileName({ repo: 'a/b c', commitSha: COMMIT })).toBe('a_b_c-aaaaaaa.tar.gz');
  });
});
