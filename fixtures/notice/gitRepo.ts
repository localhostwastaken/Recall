// A tiny git repository served the way GitHub serves one, for the .git adapter's devnet tests
// (ruling R46). Built at startup from content/repo: a tar.gz shaped like codeload's
// (`git archive`: a pax global header with the commit id, one "<repo>-<sha>/" folder), the git
// tree id of those files, and a commit id over that tree. Node built-ins only; erasable TS only
// (runs under node --experimental-strip-types).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const FIXTURE_OWNER = 'recall-fixture';
export const FIXTURE_BRANCH = 'main';
/** The honest repository: its tarball hashes to the tree its branch JSON names. */
export const GOOD_REPO = 'demo';
/** Its branch JSON names the honest tree, but its tarball has one file changed. */
export const TAMPERED_REPO = 'tampered';

type FileEntry = { rel: string; data: Buffer; exec: boolean };

export type FixtureRepo = {
  repo: string;
  commitSha: string;
  /** The tree the branch JSON names (always the honest tree). */
  treeSha: string;
  /** The tarball served for `commitSha`. */
  tarGz: Buffer;
};

const sha1 = (...parts: Buffer[]): Buffer => {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
};

function readFiles(root: string, rel = ''): FileEntry[] {
  const out: FileEntry[] = [];
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(path.join(root, r));
    if (st.isDirectory()) out.push(...readFiles(root, r));
    else out.push({ rel: r, data: fs.readFileSync(path.join(root, r)), exec: (st.mode & 0o111) !== 0 });
  }
  return out;
}

/** git's tree id: blobs sha1("blob <len>\0"+data), entries sorted with dirs as "name/". */
export function gitTreeOf(files: FileEntry[]): string {
  type Dir = Map<string, Dir | FileEntry>;
  const root: Dir = new Map();
  for (const f of files) {
    const parts = f.rel.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.has(p)) d.set(p, new Map());
      d = d.get(p) as Dir;
    }
    d.set(parts[parts.length - 1]!, f);
  }
  const hashDir = (d: Dir): Buffer => {
    const rows = [...d].map(([name, node]) => {
      const isDir = node instanceof Map;
      const id = isDir
        ? hashDir(node)
        : sha1(Buffer.from(`blob ${node.data.length}\0`), node.data);
      const mode = isDir ? '40000' : node.exec ? '100755' : '100644';
      return { key: Buffer.from(isDir ? `${name}/` : name), line: Buffer.concat([Buffer.from(`${mode} ${name}\0`), id]) };
    });
    rows.sort((a, b) => Buffer.compare(a.key, b.key));
    const body = Buffer.concat(rows.map((r) => r.line));
    return sha1(Buffer.from(`tree ${body.length}\0`), body);
  };
  return hashDir(root).toString('hex');
}

function commitOf(treeSha: string, message: string): string {
  const who = 'Recall Fixture <fixture@recall.test> 1762387200 +0000';
  const body = Buffer.from(`tree ${treeSha}\nauthor ${who}\ncommitter ${who}\n\n${message}\n`);
  return sha1(Buffer.from(`commit ${body.length}\0`), body).toString('hex');
}

function header(name: string, type: string, mode: number, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`fixture path too long for a plain ustar name: ${name}`);
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  const oct = (at: number, len: number, n: number) => h.write(n.toString(8).padStart(len - 1, '0') + '\0', at, 'latin1');
  oct(100, 8, mode);
  oct(108, 8, 0);
  oct(116, 8, 0);
  oct(124, 12, size);
  oct(136, 12, 1762387200);
  h.fill(0x20, 148, 156);
  h.write(type, 156, 'latin1');
  h.write('ustar\x0000', 257, 'latin1');
  h.write('root', 265, 'latin1');
  h.write('root', 297, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

function paxRecord(key: string, value: string): string {
  const tail = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(tail) + 1;
  while (String(len).length + Buffer.byteLength(tail) !== len) len = String(len).length + Buffer.byteLength(tail);
  return `${len}${tail}`;
}

/** A tar.gz shaped like `git archive --prefix=<top>/` (what GitHub's codeload serves). */
export function tarGzOf(files: FileEntry[], top: string, commitSha: string): Buffer {
  const parts: Buffer[] = [];
  const pax = Buffer.from(paxRecord('comment', commitSha));
  parts.push(header('pax_global_header', 'g', 0o666, pax.length), pad(pax));
  const dirs = new Set<string>();
  parts.push(header(`${top}/`, '5', 0o775, 0));
  for (const f of files) {
    const segs = f.rel.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/');
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(header(`${top}/${d}/`, '5', 0o775, 0));
      }
    }
    parts.push(header(`${top}/${f.rel}`, '0', f.exec ? 0o775 : 0o664, f.data.length), pad(f.data));
  }
  parts.push(Buffer.alloc(1024));
  const raw = Buffer.concat(parts);
  // `git archive` pads to a 10240-byte record
  return zlib.gzipSync(Buffer.concat([raw, Buffer.alloc((10240 - (raw.length % 10240)) % 10240)]));
}

/** The honest and the tampered repository, from the files under `root`. */
export function buildFixtureRepos(root: string): { good: FixtureRepo; tampered: FixtureRepo; tamperedTarGzOfGood: Buffer } {
  const files = readFiles(root);
  if (files.length === 0) throw new Error(`no fixture repository files under ${root}`);
  const treeSha = gitTreeOf(files);
  const goodCommit = commitOf(treeSha, 'fixture');
  const changed = files.map((f, i) =>
    i === 0 ? { ...f, data: Buffer.concat([f.data, Buffer.from('tampered\n')]) } : f,
  );
  const badCommit = commitOf(treeSha, 'fixture whose tarball does not match');
  return {
    good: { repo: GOOD_REPO, commitSha: goodCommit, treeSha, tarGz: tarGzOf(files, `${GOOD_REPO}-${goodCommit}`, goodCommit) },
    tampered: {
      repo: TAMPERED_REPO,
      commitSha: badCommit,
      treeSha,
      tarGz: tarGzOf(changed, `${TAMPERED_REPO}-${badCommit}`, badCommit),
    },
    tamperedTarGzOfGood: tarGzOf(changed, `${GOOD_REPO}-${goodCommit}`, goodCommit),
  };
}

/** The body of GitHub's "get a branch" response, trimmed to the fields Recall reads plus a few more. */
export function branchJson(r: FixtureRepo, apiHost: string): Buffer {
  const base = `https://${apiHost}/repos/${FIXTURE_OWNER}/${r.repo}`;
  const person = { name: 'Recall Fixture', email: 'fixture@recall.test', date: '2025-11-06T00:00:00Z' };
  return Buffer.from(
    JSON.stringify({
      name: FIXTURE_BRANCH,
      commit: {
        sha: r.commitSha,
        commit: {
          author: person,
          committer: person,
          message: 'fixture',
          tree: { sha: r.treeSha, url: `${base}/git/trees/${r.treeSha}` },
          url: `${base}/git/commits/${r.commitSha}`,
          comment_count: 0,
        },
        url: `${base}/commits/${r.commitSha}`,
        html_url: `https://github.com/${FIXTURE_OWNER}/${r.repo}/commit/${r.commitSha}`,
        parents: [],
      },
      _links: { self: `${base}/branches/${FIXTURE_BRANCH}`, html: `https://github.com/${FIXTURE_OWNER}/${r.repo}/tree/${FIXTURE_BRANCH}` },
      protected: false,
    }),
  );
}

/** The body of GitHub's "get a repository" response, only what the extension reads. */
export function repoJson(r: FixtureRepo): Buffer {
  return Buffer.from(
    JSON.stringify({ name: r.repo, full_name: `${FIXTURE_OWNER}/${r.repo}`, default_branch: FIXTURE_BRANCH, private: false }),
  );
}
