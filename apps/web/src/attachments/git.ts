// The .git adapter on the web side (R46, level 1 "hash-anchored"). A capture of GitHub's
// "get a branch" API response names commit C and tree T; the repository tarball of C is accepted
// only when the git tree hash recomputed from its files equals T. Nothing here trusts the
// extension or an Arkiv record: the branch comes from the page's own verified facts, and the
// tarball is downloaded and recomputed in this browser.
import { gitTreeFromTarGz, githubBranchFromFacts, urlHash, type GitHubBranch, type GitTree, type VerifiedFacts } from '@recall/evidence';
import { ATTACHMENT_MAX_DOWNLOAD_BYTES, attachmentMatches, isFreeBatch, swarmRootOf, type ListedAttachment } from '@recall/net';
import type { Hex } from 'viem';
import { getNetName } from '../defaults';

export type { GitHubBranch };

export const GIT_CONTENT_TYPE = 'application/gzip';
/** Largest tarball the app downloads (the same cap as the extension's). */
export const CODE_MAX_BYTES = ATTACHMENT_MAX_DOWNLOAD_BYTES;
/** Batch depth an upload with a repository tarball needs (about 3,800 chunks for 15 MB). */
export const CODE_DEPTH = 18;

const GIT_ID = /^[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** The fixture host of GitHub's API on the local devnet. */
export const DEVNET_GITHUB_API_HOST = 'api.github.recall.test';

/**
 * The GitHub API host a capture must name: api.github.com on the live networks, the fixture host
 * on the local devnet. It follows the app's network (build-time), never user input.
 */
export function githubApiHost(): string {
  try {
    return getNetName() === 'local' ? DEVNET_GITHUB_API_HOST : 'api.github.com';
  } catch {
    return 'api.github.com';
  }
}

/** The GitHub branch a verified capture proves, or null (see githubBranchFromFacts). */
export function repoOf(facts: VerifiedFacts | null | undefined, apiHost = githubApiHost()): GitHubBranch | null {
  if (!facts) return null;
  return githubBranchFromFacts(facts, { apiHost });
}

/** The repository's address, lower-cased (GitHub treats owner and repo case-insensitively). */
export const repoUrl = (b: { owner: string; repo: string }): string => `https://github.com/${b.owner}/${b.repo}`.toLowerCase();
/** `urlHash` of an attachment record: the hash of the repository's address. */
export const repoUrlHash = (b: { owner: string; repo: string }): Hex => urlHash(repoUrl(b));

/** What the extension says about the tarball it holds for a pending capture (contract R46). */
export type RepoSummary = {
  kind: 'git';
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  treeSha: string;
  size: number;
  sha256: Hex;
  files: number;
  contentType: string;
};

/**
 * Whether the extension's summary agrees with the branch the page itself verified: null when it
 * does, else why not. Every field is checked for shape too, since the summary is the extension's word.
 */
export function summaryDisagrees(summary: unknown, branch: GitHubBranch | null): string | null {
  if (!branch) return "this capture isn't a verified GitHub branch response";
  const s = summary as Partial<RepoSummary> | null;
  if (!s || typeof s !== 'object') return 'the repository details are missing';
  if (s.kind !== 'git') return 'the attachment is not a git repository';
  const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  if (!same(s.owner, branch.owner) || !same(s.repo, branch.repo)) return 'it names another repository';
  if (s.branch !== branch.branch) return 'it names another branch';
  if (typeof s.commitSha !== 'string' || !GIT_ID.test(s.commitSha) || s.commitSha !== branch.commitSha) return 'it names another commit';
  if (typeof s.treeSha !== 'string' || !GIT_ID.test(s.treeSha) || s.treeSha !== branch.treeSha) return 'it names another tree';
  if (typeof s.sha256 !== 'string' || !HASH.test(s.sha256)) return 'the file hash is not valid';
  if (typeof s.size !== 'number' || !Number.isSafeInteger(s.size) || s.size <= 0) return 'the file size is not valid';
  if (s.size > CODE_MAX_BYTES) return `the code is larger than ${Math.round(CODE_MAX_BYTES / 1024 / 1024)} MB`;
  if (typeof s.files !== 'number' || !Number.isSafeInteger(s.files) || s.files < 0) return 'the file count is not valid';
  if (s.contentType !== GIT_CONTENT_TYPE) return 'the file is not a .tar.gz';
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<Hex> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return `0x${Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** What this browser computed from a downloaded tarball. */
export type CodeComputed = { treeSha: string; files: number; sha256: Hex; size: number };

type TreeReply = { ok: true; tree: GitTree } | { ok: false; error: string };

/**
 * gitTreeFromTarGz in a Web Worker (a copy of the bytes goes there; the caller keeps its own).
 * A tarball the parser refuses throws its error; only when the worker itself can't run does the
 * main thread compute it instead (same function, same result).
 */
async function treeOf(bytes: Uint8Array): Promise<GitTree> {
  if (typeof Worker === 'undefined') return gitTreeFromTarGz(bytes);
  let worker: Worker;
  try {
    const { default: TreeWorker } = await import('./tree.worker?worker');
    worker = new TreeWorker();
  } catch {
    return gitTreeFromTarGz(bytes);
  }
  const reply = await new Promise<TreeReply | null>((resolve) => {
    worker.onmessage = (e: MessageEvent<TreeReply>) => resolve(e.data);
    worker.onerror = () => resolve(null);
    worker.postMessage(bytes);
  }).finally(() => worker.terminate());
  if (!reply) return gitTreeFromTarGz(bytes);
  if (!reply.ok) throw new Error(reply.error);
  return reply.tree;
}

/** Recomputes the tree hash and the file hash of a tarball; throws when it can't be read unambiguously. */
export async function computeCode(bytes: Uint8Array): Promise<CodeComputed> {
  const tree = await treeOf(bytes);
  return { treeSha: tree.treeSha, files: tree.files, sha256: await sha256Hex(bytes), size: bytes.length };
}

const bare = (ref: string) => ref.replace(/^0x/, '').toLowerCase();

/**
 * Downloads a tarball from the download gateways with progress, at most CODE_MAX_BYTES. For a
 * stamped upload the Swarm root of the bytes must equal the reference (a gateway can't swap
 * them); a free upload (all-zero batch) can't be root-checked, so its bytes are bound by the
 * file hash and the recomputed tree instead (every caller checks both).
 */
export async function downloadCode(
  ref: string,
  batchId: string,
  urls: string[],
  opts: { signal?: AbortSignal; onProgress?: (received: number, total: number | null) => void } = {},
): Promise<{ bytes: Uint8Array; rootVerified: boolean }> {
  if (!HASH.test(ref)) throw new Error('invalid Swarm reference');
  const checkRoot = !isFreeBatch(batchId);
  const errors: string[] = [];
  for (const url of urls) {
    opts.signal?.throwIfAborted();
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/bytes/${bare(ref)}`, { signal: opts.signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        errors.push(`${url}: ${res.status}`);
        continue;
      }
      const bytes = await readCapped(res, CODE_MAX_BYTES, opts.onProgress);
      if (!checkRoot) return { bytes, rootVerified: false };
      if ((await swarmRootOf(bytes)) === bare(ref)) return { bytes, rootVerified: true };
      errors.push(`${url}: the bytes do not hash to the reference`);
    } catch (e) {
      if (opts.signal?.aborted) throw new Error('download aborted');
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`the code could not be downloaded: ${errors.join('; ') || 'no download gateway'}`);
}

async function readCapped(res: Response, max: number, onProgress?: (received: number, total: number | null) => void): Promise<Uint8Array> {
  const statedRaw = res.headers.get('content-length');
  const stated = statedRaw === null ? NaN : Number(statedRaw);
  const total = Number.isFinite(stated) && stated > 0 ? stated : null;
  if (total !== null && total > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`the file is over the ${Math.round(max / 1024 / 1024)} MB limit`);
  }
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > max) throw new Error(`the file is over the ${Math.round(max / 1024 / 1024)} MB limit`);
    onProgress?.(b.length, total);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`the file is over the ${Math.round(max / 1024 / 1024)} MB limit`);
    }
    chunks.push(value);
    onProgress?.(size, total);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The parent capture as this page verified it. */
export type VerifiedParent = { captureKey: Hex; branch: GitHubBranch };

/**
 * Whether an attachment record can describe this capture at all, from its own fields (before
 * anything is downloaded): kind, level, parent, repository, commit and tree must agree.
 */
export function attachmentClaimsFit(record: ListedAttachment, parent: VerifiedParent): boolean {
  if (!HASH.test(record.evidenceRef) || !HASH.test(record.batchId)) return false;
  if (record.size <= 0n || record.size > BigInt(CODE_MAX_BYTES)) return false;
  return (
    attachmentMatches(record, {
      parentCaptureKey: parent.captureKey,
      urlHash: repoUrlHash(parent.branch),
      sha256: record.sha256,
      commitSha: parent.branch.commitSha,
      treeSha: parent.branch.treeSha,
      size: record.size,
    }).length === 0
  );
}

/**
 * The record-page verdict for one attachment, from bytes this browser downloaded: the
 * recomputed tree must equal the notarized one, and the record must agree with everything
 * computed (R13-style). An empty list means "hash-anchored".
 */
export function snapshotDiffers(record: ListedAttachment, parent: VerifiedParent, computed: CodeComputed): string[] {
  const differs: string[] = [];
  if (computed.treeSha !== parent.branch.treeSha) differs.push('code (its tree is not the commit GitHub reported)');
  for (const d of attachmentMatches(record, {
    parentCaptureKey: parent.captureKey,
    urlHash: repoUrlHash(parent.branch),
    sha256: computed.sha256,
    commitSha: parent.branch.commitSha,
    treeSha: computed.treeSha,
    size: computed.size,
  })) {
    if (!differs.includes(d)) differs.push(d);
  }
  return differs;
}

/** `<repo>-<commit7>.tar.gz`, safe as a file name. */
export const codeFileName = (b: { repo: string; commitSha: string }): string =>
  `${b.repo.replace(/[^A-Za-z0-9._-]/g, '_')}-${b.commitSha.slice(0, 7)}.tar.gz`;
