// The .git adapter, level 1 ("hash-anchored"), ruling R46. A notarized GitHub API response names
// a branch's commit C and tree T; the repository tarball of C is then accepted only if the git
// tree hash recomputed from its files equals T. Pure TypeScript (fflate, @noble/hashes): runs in
// the browser, the extension and Node alike.
import { Gunzip } from 'fflate';
import { sha1 } from '@noble/hashes/legacy';

/** A git object id as git and GitHub print it: 40 lower-case hex digits, no 0x. */
export type GitSha = string;

export type GitTree = {
  /** The root tree id, as `git rev-parse <commit>^{tree}` prints it. */
  treeSha: GitSha;
  /** Number of blobs: regular files and symlinks. */
  files: number;
  /** Total size of those blobs in bytes (a symlink's blob is its target). */
  bytes: number;
};

export type GitTarLimits = {
  /** Most entries (files, links, directories) an archive may hold. */
  maxEntries: number;
  /** Most bytes the archive may inflate to (zip-bomb guard). */
  maxUncompressedBytes: number;
};

export const GIT_TAR_LIMITS: Readonly<GitTarLimits> = Object.freeze({
  maxEntries: 200_000,
  maxUncompressedBytes: 300 * 1024 * 1024,
});

const SHA_RE = /^[0-9a-f]{40}$/;
const utf8 = new TextEncoder();
// ignoreBOM: keep a leading U+FEFF in a name. By default TextDecoder drops it, so a name field
// "EF BB BF main.ts" would hash as "main.ts" while a system tar extracts a different file name.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

let crcTable: Uint32Array | undefined;
function crc32(b: Uint8Array): number {
  const t = (crcTable ??= (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const le32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

/**
 * Inflates ONE gzip member, in small input steps so a bomb is stopped near the limit, not after
 * it. Refuses reserved header flags, a second member, and any byte after the first member: the
 * member's CRC-32 and length trailer must be the last 8 bytes of the input (fflate checks
 * neither, and would skip a few trailing bytes).
 */
function gunzipCapped(gz: Uint8Array, max: number): Uint8Array {
  if (gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b || gz[2] !== 8) throw new Error('not a gzip stream');
  if (gz[3]! & 0xe0) throw new Error('the gzip header has reserved flags set');
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  const g = new Gunzip((chunk, final) => {
    total += chunk.length;
    if (total > max) throw new Error(`archive inflates past the ${max}-byte limit`);
    chunks.push(chunk);
    if (final) ended = true;
  });
  g.onmember = () => {
    throw new Error('a multi-member gzip (or bytes after the first gzip member) is not supported');
  };
  const STEP = 16 * 1024; // deflate expands at most ~1032x, so one step yields at most ~17 MB
  // every data push is non-final, so fflate inspects whatever follows the first member
  for (let i = 0; i < gz.length; i += STEP) g.push(gz.subarray(i, Math.min(i + STEP, gz.length)), false);
  g.push(new Uint8Array(0), true);
  if (!ended) throw new Error('not a complete gzip stream');
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  if (le32(gz, gz.length - 4) !== total % 2 ** 32 || le32(gz, gz.length - 8) !== crc32(out)) {
    throw new Error('the gzip trailer does not match the data (corrupt, or bytes after the first gzip member)');
  }
  return out;
}

/** A NUL-terminated header field as raw bytes. */
function field(h: Uint8Array, at: number, len: number): Uint8Array {
  const f = h.subarray(at, at + len);
  const nul = f.indexOf(0);
  return nul < 0 ? f : f.subarray(0, nul);
}

function text(b: Uint8Array, what: string): string {
  try {
    return strictUtf8.decode(b);
  } catch {
    throw new Error(`${what} is not valid UTF-8`);
  }
}

function octal(h: Uint8Array, at: number, len: number, what: string): number {
  if (h[at]! & 0x80) {
    // GNU base-256: big-endian binary in the rest of the field
    let n = 0;
    for (let i = at + 1; i < at + len; i++) n = n * 256 + h[i]!;
    if (h[at] !== 0x80 || !Number.isSafeInteger(n)) throw new Error(`tar ${what} is out of range`);
    return n;
  }
  const s = String.fromCharCode(...h.subarray(at, at + len)).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]*$/.test(s)) throw new Error(`tar ${what} field is not octal`);
  return s === '' ? 0 : parseInt(s, 8);
}

function checksumOk(h: Uint8Array): boolean {
  const stored = octal(h, 148, 8, 'checksum');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === stored;
}

/**
 * pax keys that may appear; they cannot change which bytes land in which file beyond `path`,
 * `linkpath` and `size`, which this parser honours like every reader. Anything else (sparse
 * files, xattrs, charsets, vendor keys) is refused rather than interpreted one way here and
 * another way by a system tar.
 */
const PAX_KEYS = new Set(['path', 'linkpath', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'size', 'comment']);

/** pax extended header records: "<len> <key>=<value>\n", len counting the whole record. */
function parsePax(data: Uint8Array, global: boolean): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    const lenText = sp < 0 ? '' : String.fromCharCode(...data.subarray(at, sp));
    const len = /^[1-9][0-9]{0,8}$/.test(lenText) ? Number(lenText) : NaN;
    if (!(len > 0) || at + len > data.length || data[at + len - 1] !== 0x0a) throw new Error('malformed pax record');
    const rec = text(data.subarray(sp + 1, at + len - 1), 'pax record');
    const eq = rec.indexOf('=');
    if (eq <= 0) throw new Error('malformed pax record');
    const k = rec.slice(0, eq);
    const v = rec.slice(eq + 1);
    if (global && k !== 'comment') throw new Error(`pax global header key "${k}" is not supported`);
    if (!PAX_KEYS.has(k)) throw new Error(`unsupported pax key "${k}"`);
    if (out.has(k)) throw new Error(`pax key "${k}" appears twice`);
    if ((k === 'path' || k === 'linkpath') && v.includes('\0')) throw new Error(`pax ${k} contains a NUL byte`);
    out.set(k, v);
    at += len;
  }
  return out;
}

type Blob = { kind: 'blob'; mode: '100644' | '100755' | '120000'; sha: Uint8Array; size: number };
type Dir = { kind: 'dir'; children: Map<string, Blob | Dir> };

function blobSha(data: Uint8Array): Uint8Array {
  return sha1.create().update(utf8.encode(`blob ${data.length}\0`)).update(data).digest();
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function treeSha(d: Dir, path: string, isRoot: boolean): Uint8Array {
  if (!isRoot && d.children.size === 0) {
    // git never stores an empty directory; git archive writes a submodule (gitlink) as one
    throw new Error(`"${path}" is an empty directory: a submodule (gitlink), which is not supported`);
  }
  const entries = [...d.children].map(([name, node]) => {
    const nameBytes = utf8.encode(name);
    const sortKey = node.kind === 'dir' ? utf8.encode(name + '/') : nameBytes;
    const sha = node.kind === 'dir' ? treeSha(node, path ? `${path}/${name}` : name, false) : node.sha;
    const mode = node.kind === 'dir' ? '40000' : node.mode;
    return { sortKey, line: [utf8.encode(`${mode} `), nameBytes, new Uint8Array([0]), sha] };
  });
  entries.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  const parts = entries.flatMap((e) => e.line);
  const len = parts.reduce((n, p) => n + p.length, 0);
  const h = sha1.create().update(utf8.encode(`tree ${len}\0`));
  for (const p of parts) h.update(p);
  return h.digest();
}

/**
 * Recomputes the git tree id of a repository tarball (`git archive`, as served by GitHub's
 * codeload): blobs are sha1("blob <len>\0" + data) with mode 100755 if any exec bit is set,
 * else 100644, and 120000 for a symlink (its target is the data); trees are sorted with
 * directories compared as "name/". The archive's single top-level folder is stripped.
 *
 * Throws (never guesses) on: a submodule (an empty directory), a hard link, a device or FIFO,
 * an unknown entry type, a path with "..", "." or an empty segment or an absolute path, a
 * duplicate path, a corrupt or truncated archive, more than `maxEntries` entries, or more than
 * `maxUncompressedBytes` once inflated.
 */
export function gitTreeFromTarGz(bytes: Uint8Array, limits: Partial<GitTarLimits> = {}): GitTree {
  const { maxEntries, maxUncompressedBytes } = { ...GIT_TAR_LIMITS, ...limits };
  const t = gunzipCapped(bytes, maxUncompressedBytes);

  const root: Dir = { kind: 'dir', children: new Map() };
  const explicitDirs = new Set<string>();
  let top: string | undefined;
  let entries = 0;
  let files = 0;
  let total = 0;
  let pax: Map<string, string> | undefined;
  let gnuName: string | undefined;
  let gnuLink: string | undefined;

  let at = 0;
  for (;;) {
    if (at + 512 > t.length) throw new Error('tar archive is truncated (no end-of-archive block)');
    const h = t.subarray(at, at + 512);
    if (h.every((b) => b === 0)) {
      // the end: two zero blocks, then only zero padding (other readers would go on reading)
      const rest = t.subarray(at);
      if (rest.length < 1024) throw new Error('the tar archive does not end with two zero blocks');
      if (!rest.every((b) => b === 0)) throw new Error('the tar archive has data after the end-of-archive zero blocks');
      break;
    }
    if (!checksumOk(h)) throw new Error(`tar header checksum mismatch at byte ${at}`);
    const magic = String.fromCharCode(...h.subarray(257, 265));
    const ustar = magic === 'ustar\x0000';
    if (!ustar && magic !== 'ustar  \0') throw new Error(`unsupported tar header format at byte ${at}`);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]!);
    let size = octal(h, 124, 12, 'size');
    const dataAt = at + 512;
    const paxSize = type !== 'x' && type !== 'g' && type !== 'L' && type !== 'K' ? pax?.get('size') : undefined;
    if (paxSize !== undefined) {
      if (!/^[0-9]{1,15}$/.test(paxSize)) throw new Error('pax size is not a number');
      size = Number(paxSize);
    }
    if (dataAt + size > t.length) throw new Error('tar archive is truncated (an entry runs past the end)');
    const data = t.subarray(dataAt, dataAt + size);
    at = dataAt + Math.ceil(size / 512) * 512;

    const pending = pax !== undefined || gnuName !== undefined || gnuLink !== undefined;
    if (type === 'g') {
      // pax global header: git archive puts the commit id there as a comment
      if (pending) throw new Error('a pax global header between an extended header and its entry');
      parsePax(data, true);
      continue;
    }
    if (type === 'x') {
      if (pax) throw new Error('two pax extended headers for one entry');
      pax = parsePax(data, false);
      continue;
    }
    if (type === 'L' || type === 'K') {
      const v = text(field(data, 0, data.length), 'GNU long name');
      if (v.includes('\0') || v === '') throw new Error('malformed GNU long name');
      if (type === 'L') {
        if (gnuName !== undefined) throw new Error('two GNU long names for one entry');
        gnuName = v;
      } else {
        if (gnuLink !== undefined) throw new Error('two GNU long link names for one entry');
        gnuLink = v;
      }
      continue;
    }
    if (pax?.has('path') && gnuName !== undefined) throw new Error('an entry has both a pax path and a GNU long name');
    if (pax?.has('linkpath') && gnuLink !== undefined) {
      throw new Error('an entry has both a pax linkpath and a GNU long link name');
    }

    // a real entry: resolve its name and link target, then clear the extended headers
    let name = text(field(h, 0, 100), 'tar entry name');
    const prefix = ustar ? text(field(h, 345, 155), 'tar name prefix') : '';
    if (prefix) name = `${prefix}/${name}`;
    name = pax?.get('path') ?? gnuName ?? name;
    const linkField = text(field(h, 157, 100), 'tar link name');
    const hasLink = linkField !== '' || pax?.has('linkpath') === true || gnuLink !== undefined;
    const link = pax?.get('linkpath') ?? gnuLink ?? linkField;
    pax = gnuName = gnuLink = undefined;

    if (++entries > maxEntries) throw new Error(`archive has more than ${maxEntries} entries`);

    switch (type) {
      case '0':
      case '2':
      case '5':
        break;
      case '1':
        throw new Error(`"${name}" is a hard link, which a git archive never contains`);
      case '3':
      case '4':
        throw new Error(`"${name}" is a device file`);
      case '6':
        throw new Error(`"${name}" is a FIFO`);
      default:
        throw new Error(`"${name}" has an unsupported tar entry type "${type}"`);
    }
    if (type !== '2' && hasLink) throw new Error(`"${name}" is not a symlink but has a link name`);
    if (type !== '0' && size !== 0) throw new Error(`"${name}" is a directory or symlink with data`);

    if (name.startsWith('/')) throw new Error(`invalid path "${name}" (absolute)`);
    const segs = (type === '5' ? name.replace(/\/$/, '') : name).split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..' || s.includes('\0'))) {
      throw new Error(`invalid path "${name}"`);
    }
    if (top === undefined) top = segs[0];
    if (segs[0] !== top) throw new Error(`the archive has more than one top-level folder ("${top}", "${segs[0]}")`);
    if (segs.length === 1) {
      if (type !== '5') throw new Error(`"${name}" is outside the top-level folder`);
      if (explicitDirs.has('')) throw new Error(`duplicate path "${name}"`);
      explicitDirs.add('');
      continue;
    }
    const parts = segs.slice(1);
    const rel = parts.join('/');

    let d = root;
    for (const p of parts.slice(0, -1)) {
      const next = d.children.get(p);
      if (next?.kind === 'blob') throw new Error(`path conflict: "${rel}" is under a file`);
      if (next) d = next;
      else {
        const nd: Dir = { kind: 'dir', children: new Map() };
        d.children.set(p, nd);
        d = nd;
      }
    }
    const leaf = parts[parts.length - 1]!;
    const existing = d.children.get(leaf);
    if (type === '5') {
      if (explicitDirs.has(rel)) throw new Error(`duplicate path "${rel}"`);
      if (existing?.kind === 'blob') throw new Error(`duplicate path "${rel}" (file and directory)`);
      explicitDirs.add(rel);
      if (!existing) d.children.set(leaf, { kind: 'dir', children: new Map() });
      continue;
    }
    if (existing?.kind === 'dir') throw new Error(`path conflict: "${rel}" is a file and a directory`);
    if (existing) throw new Error(`duplicate path "${rel}"`);
    const blobData = type === '2' ? utf8.encode(link) : data;
    if (type === '2' && link === '') throw new Error(`symlink "${rel}" has no target`);
    const mode = type === '2' ? '120000' : octal(h, 100, 8, 'mode') & 0o111 ? '100755' : '100644';
    d.children.set(leaf, { kind: 'blob', mode, sha: blobSha(blobData), size: blobData.length });
    files++;
    total += blobData.length;
  }
  if (pax || gnuName !== undefined || gnuLink !== undefined) {
    throw new Error('an extended header is not followed by an entry');
  }
  if (top === undefined) throw new Error('the archive is empty');
  return { treeSha: hex(treeSha(root, '', true)), files, bytes: total };
}

// ---------------------------------------------------------------------------------------------
// The notarized GitHub API response: GET https://api.github.com/repos/<o>/<r>/branches/<b>

export type GitHubBranch = { owner: string; repo: string; branch: string; commitSha: GitSha; treeSha: GitSha };
export type GitHubHosts = { apiHost?: string };

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const REPO = '[A-Za-z0-9._-]{1,100}';
const BRANCH = '[A-Za-z0-9._/-]{1,255}';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A branch name this adapter accepts: a strict subset of git's ref rules. */
function branchOk(b: string): boolean {
  return (
    new RegExp(`^${BRANCH}$`).test(b) &&
    !b.includes('..') &&
    !b.includes('//') &&
    !b.startsWith('/') &&
    !b.endsWith('/') &&
    !b.startsWith('-') &&
    !b.endsWith('.') &&
    !b.endsWith('.lock')
  );
}
const repoOk = (r: string) => r !== '.' && r !== '..';

function apiPath(apiHost: string, tail: string): RegExp {
  return new RegExp(`^https://${escapeRe(apiHost.toLowerCase())}/repos/(${OWNER})/(${REPO})/${tail}$`);
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Record<string, unknown>;
};
const sha = (v: unknown, what: string): GitSha => {
  if (typeof v !== 'string' || !SHA_RE.test(v)) throw new Error(`${what} is not a 40-hex git id`);
  return v;
};
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Reads the commit and tree ids from the body of GitHub's "get a branch" response, strictly:
 * both ids must be 40 lower-case hex digits; owner and repo come from `_links.self` and/or
 * `commit.url` (at least one; all present must agree, and with `name`, `commit.sha` and the tree
 * URL). Throws on anything else. `apiHost` is api.github.com except for the devnet fixture.
 */
export function parseGitHubBranch(body: Uint8Array | string, hosts: GitHubHosts = {}): GitHubBranch {
  const apiHost = hosts.apiHost ?? 'api.github.com';
  const json: unknown = JSON.parse(typeof body === 'string' ? body : text(body, 'the response body'));
  const j = obj(json, 'the response');
  const branch = j.name;
  if (typeof branch !== 'string' || !branchOk(branch)) throw new Error('the branch name is missing or not supported');
  const commit = obj(j.commit, 'commit');
  const commitSha = sha(commit.sha, 'commit.sha');
  const inner = obj(commit.commit, 'commit.commit');
  const tree = obj(inner.tree, 'commit.commit.tree');
  const treeSha = sha(tree.sha, 'commit.commit.tree.sha');

  const named: { owner: string; repo: string }[] = [];
  const links = j._links === undefined ? undefined : obj(j._links, '_links');
  if (links?.self !== undefined) {
    const m = typeof links.self === 'string' ? apiPath(apiHost, `branches/(${BRANCH})`).exec(links.self) : null;
    if (!m) throw new Error('_links.self is not this API host\'s branch URL');
    if (m[3] !== branch) throw new Error('_links.self names another branch');
    named.push({ owner: m[1]!, repo: m[2]! });
  }
  if (commit.url !== undefined) {
    const m = typeof commit.url === 'string' ? apiPath(apiHost, '(?:commits)/([0-9a-f]{40})').exec(commit.url) : null;
    if (!m) throw new Error('commit.url is not this API host\'s commit URL');
    if (m[3] !== commitSha) throw new Error('commit.url names another commit');
    named.push({ owner: m[1]!, repo: m[2]! });
  }
  if (named.length === 0) throw new Error('neither _links.self nor commit.url names the repository');
  const { owner, repo } = named[0]!;
  if (named.some((n) => !sameName(n.owner, owner) || !sameName(n.repo, repo))) {
    throw new Error('_links.self and commit.url name different repositories');
  }
  if (tree.url !== undefined) {
    const m = typeof tree.url === 'string' ? apiPath(apiHost, 'git/trees/([0-9a-f]{40})').exec(tree.url) : null;
    if (!m || m[3] !== treeSha || !sameName(m[1]!, owner) || !sameName(m[2]!, repo)) {
      throw new Error('commit.commit.tree.url disagrees with the tree id or repository');
    }
  }
  if (!repoOk(repo)) throw new Error('invalid repository name');
  return { owner, repo, branch, commitSha, treeSha };
}

/**
 * The GitHub branch a verified capture proves, or null. The captured URL must be exactly
 * `https://<apiHost>/repos/<o>/<r>/branches/<b>` (no query, no trailing slash), the response a
 * 200 with a JSON content type, and the JSON (see `parseGitHubBranch`) must name the same
 * owner/repo (case-insensitively, as GitHub treats them) and exactly the same branch.
 */
export function githubBranchFromFacts(
  facts: { canonicalUrl: string; body: Uint8Array; httpStatus: number; contentType?: string },
  hosts: GitHubHosts = {},
): GitHubBranch | null {
  const apiHost = hosts.apiHost ?? 'api.github.com';
  if (facts.httpStatus !== 200) return null;
  if (!/^application\/json\s*(;|$)/i.test(facts.contentType ?? '')) return null;
  const m = apiPath(apiHost, `branches/(${BRANCH})`).exec(facts.canonicalUrl);
  if (!m || !branchOk(m[3]!)) return null;
  let b: GitHubBranch;
  try {
    b = parseGitHubBranch(facts.body, { apiHost });
  } catch {
    return null;
  }
  if (!sameName(b.owner, m[1]!) || !sameName(b.repo, m[2]!) || b.branch !== m[3]) return null;
  return b;
}

/** The API URL to capture for a branch. */
export function githubBranchApiUrl(b: { owner: string; repo: string; branch: string }, apiHost = 'api.github.com'): string {
  return `https://${apiHost}/repos/${b.owner}/${b.repo}/branches/${b.branch}`;
}

/** GitHub's tarball of one commit (`git archive` with a "<repo>-<sha>/" folder). */
export function codeloadTarGzUrl(c: { owner: string; repo: string; commitSha: GitSha }, host = 'codeload.github.com'): string {
  if (!SHA_RE.test(c.commitSha)) throw new Error('commitSha is not a 40-hex git id');
  return `https://${host}/${c.owner}/${c.repo}/tar.gz/${c.commitSha}`;
}
