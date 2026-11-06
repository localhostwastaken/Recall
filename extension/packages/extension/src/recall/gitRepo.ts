// The .git adapter's capture target (R46, level 1 "hash-anchored"). On a GitHub repository page
// (https://github.com/<owner>/<repo> or .../tree/<branch>) the capture is of GitHub's API answer
// for the branch, https://api.github.com/repos/<owner>/<repo>/branches/<branch>, through the
// ordinary capture pipeline (witness, pinned headers, checks A-C). The notarized answer names a
// commit and its tree; the code is then downloaded from codeload and must hash to that tree.
// Pure parts (no chrome APIs), so they are unit tested; the default-branch lookup takes a fetch.
import { githubBranchApiUrl, type GitHubBranch } from '@recall/evidence';
import { RECALL_DEV } from './build';

/**
 * GitHub's hosts, fixed at build time. A release build: the real GitHub. A dev build (test CA,
 * devnet): the notice fixture plays GitHub (fixtures/notice), and a repository page may be on
 * github.com or github.recall.test (the e2e tests never open the page itself).
 */
export type GitHubHostSet = { web: readonly string[]; api: string; codeload: string };
export const RELEASE_GITHUB_HOSTS: GitHubHostSet = Object.freeze({
  web: Object.freeze(['github.com']),
  api: 'api.github.com',
  codeload: 'codeload.github.com',
});
export const DEV_GITHUB_HOSTS: GitHubHostSet = Object.freeze({
  web: Object.freeze(['github.com', 'github.recall.test']),
  api: 'api.github.recall.test',
  codeload: 'codeload.github.recall.test',
});
export const GITHUB_HOSTS: GitHubHostSet = RECALL_DEV ? DEV_GITHUB_HOSTS : RELEASE_GITHUB_HOSTS;

export type RepoRef = { owner: string; repo: string };
export type RepoTarget = RepoRef & { branch: string };

/** The repository snapshot a pending capture carries (what the publish page is told). */
export type AttachmentSummary = {
  kind: 'git';
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  treeSha: string;
  /** Bytes of the tar.gz. */
  size: number;
  /** sha256 of the tar.gz, 0x + 64 lower-case hex. */
  sha256: `0x${string}`;
  /** Files (blobs) in the tree. */
  files: number;
  contentType: 'application/gzip';
};

/** Most bytes the repository tarball may have (the same cap the web app downloads with). */
export const REPO_MAX_BYTES = 25 * 1024 * 1024;
/** How long the tarball download may take. */
export const REPO_DOWNLOAD_TIMEOUT_MS = 120_000;
/** How long the unnotarized default-branch lookup may take. */
export const DEFAULT_BRANCH_TIMEOUT_MS = 10_000;
/** Storage depth a stamped upload with a repository snapshot needs (~3,800 chunks, 4 per bucket). */
export const ATTACHMENT_DEPTH = 18;

/** Failure copy (popup). */
export const GITHUB_UNREADABLE = "GitHub's answer couldn't be read";
export const SNAPSHOT_MISMATCH = "The repository snapshot doesn't match the commit GitHub reported";

// GitHub's name rules (the same subset @recall/evidence accepts in the notarized answer).
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;

/** github.com paths that are not a user or organisation. */
const RESERVED_OWNERS = new Set([
  'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'customer-stories',
  'dashboard', 'enterprise', 'events', 'explore', 'features', 'github-copilot', 'issues', 'join',
  'login', 'logout', 'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing',
  'pulls', 'readme', 'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors',
  'stars', 'team', 'topics', 'trending', 'users',
]);

export function ownerOk(o: string): boolean {
  return OWNER.test(o) && !RESERVED_OWNERS.has(o.toLowerCase());
}

export function repoOk(r: string): boolean {
  return REPO.test(r) && r !== '.' && r !== '..' && !r.toLowerCase().endsWith('.git');
}

/** A branch name this adapter accepts: a strict subset of git's ref rules. */
export function branchOk(b: string): boolean {
  return (
    BRANCH.test(b) &&
    !b.includes('..') &&
    !b.includes('//') &&
    !b.startsWith('/') &&
    !b.endsWith('/') &&
    !b.startsWith('-') &&
    !b.endsWith('.') &&
    !b.endsWith('.lock')
  );
}

/**
 * The repository a github.com page shows, or null. Only `https://github.com/<o>/<r>` and
 * `https://github.com/<o>/<r>/tree/<branch>` (a trailing slash, a query and a fragment are
 * ignored); the branch may contain '/'. Anything else (issues, blobs, a file path) is not a
 * repository page.
 */
export function parseRepoPage(
  raw: string,
  hosts: GitHubHostSet = GITHUB_HOSTS,
): (RepoRef & { branch?: string }) | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !hosts.web.includes(u.hostname) || u.port !== '' || u.username || u.password) {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, '');
  const m = /^\/([^/]+)\/([^/]+)(?:\/tree\/(.+))?$/.exec(path);
  if (!m) return null;
  const owner = m[1]!;
  let repo = m[2]!;
  if (repo.toLowerCase().endsWith('.git')) repo = repo.slice(0, -4);
  if (!ownerOk(owner) || !repoOk(repo)) return null;
  if (m[3] === undefined) return { owner, repo };
  let branch: string;
  try {
    branch = decodeURIComponent(m[3]);
  } catch {
    return null;
  }
  return branchOk(branch) ? { owner, repo, branch } : null;
}

/** The URL Recall captures for a repository branch. */
export function repoCaptureUrl(t: RepoTarget, hosts: GitHubHostSet = GITHUB_HOSTS): string {
  return githubBranchApiUrl(t, hosts.api);
}

/** The tarball of one commit. */
export function codeloadUrl(t: RepoRef, commitSha: string, hosts: GitHubHostSet = GITHUB_HOSTS): string {
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('the commit id is not 40 hex digits');
  return `https://${hosts.codeload}/${t.owner}/${t.repo}/tar.gz/${commitSha}`;
}

/**
 * The repository's default branch, read once from `GET https://api.github.com/repos/<o>/<r>`
 * (unnotarized: it only picks what to capture; the capture itself is notarized). No cookies.
 */
export async function fetchDefaultBranch(
  r: RepoRef,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  timeoutMs = DEFAULT_BRANCH_TIMEOUT_MS,
): Promise<string> {
  const res = await fetchImpl(`https://${GITHUB_HOSTS.api}/repos/${r.owner}/${r.repo}`, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) throw new Error('GitHub has no public repository with this name');
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate-limiting requests; try again later');
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  const j = (await res.json()) as { default_branch?: unknown; private?: unknown };
  if (j.private === true) throw new Error('the repository is private');
  const b = j.default_branch;
  if (typeof b !== 'string' || !branchOk(b)) throw new Error('GitHub gave no usable default branch');
  return b;
}

/** Whether the notarized answer names exactly this target (owner/repo as GitHub compares them). */
export function branchMatchesTarget(b: GitHubBranch, t: RepoTarget): boolean {
  return (
    b.owner.toLowerCase() === t.owner.toLowerCase() &&
    b.repo.toLowerCase() === t.repo.toLowerCase() &&
    b.branch === t.branch
  );
}

/** "0x" + lower-case hex sha256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<`0x${string}`> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return `0x${Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Reads a response body, counting bytes as they arrive, and aborts once it would pass `max`
 * (a stated Content-Length over the cap fails before reading).
 */
export async function readCappedBody(res: Response, max: number, abort?: () => void): Promise<Uint8Array> {
  const stated = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(stated) && stated > max) {
    abort?.();
    throw new Error(`the repository is too large (over ${Math.round(max / 1024 / 1024)} MB)`);
  }
  if (!res.body) throw new Error('GitHub sent no repository data');
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      abort?.();
      await reader.cancel().catch(() => undefined);
      throw new Error(`the repository is too large (over ${Math.round(max / 1024 / 1024)} MB)`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Default branches looked up this worker's life, by lower-case "owner/repo". */
const defaultBranches = new Map<string, { at: number; branch: string }>();
const DEFAULT_BRANCH_CACHE_MS = 5 * 60_000;

/**
 * The branch to capture for a page: null when the page is not a repository page; the branch in
 * the URL, else the repository's default branch (looked up once, cached a few minutes). Throws
 * when the default branch cannot be read.
 */
export async function resolveRepoTarget(url: string, fetchImpl?: typeof fetch): Promise<RepoTarget | null> {
  const p = parseRepoPage(url);
  if (!p) return null;
  if (p.branch) return { owner: p.owner, repo: p.repo, branch: p.branch };
  const key = `${p.owner}/${p.repo}`.toLowerCase();
  const hit = defaultBranches.get(key);
  if (hit && Date.now() - hit.at < DEFAULT_BRANCH_CACHE_MS) return { owner: p.owner, repo: p.repo, branch: hit.branch };
  const branch = await fetchDefaultBranch(p, fetchImpl);
  defaultBranches.set(key, { at: Date.now(), branch });
  return { owner: p.owner, repo: p.repo, branch };
}
