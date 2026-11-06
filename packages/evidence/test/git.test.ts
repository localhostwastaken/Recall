import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  GIT_TAR_LIMITS,
  codeloadTarGzUrl,
  gitTreeFromTarGz,
  githubBranchApiUrl,
  githubBranchFromFacts,
  parseGitHubBranch,
} from '../src/git';
import { paxData, tar, tgz, type TarEntry } from './tar';

const vec = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./vectors/git/${name}`, import.meta.url)));

// tiny.tar.gz is `git archive --format=tar.gz --prefix=x/ HEAD` of a repo with an exec file,
// a symlink, an empty file, nested dirs, "foo/" vs "foo.txt" vs "foo-bar" (sort order), a
// non-ASCII name, a path long enough for the ustar prefix field and a 120-char name (pax
// "path" record). `git rev-parse HEAD^{tree}` printed TINY_TREE; `git ls-tree -r -l` has 11
// blobs with 101 bytes in all.
const TINY_TREE = '39d1e9a33a4ead57af6666b9b8ed933e8c567aa8';

const dir = (name: string): TarEntry => ({ name, type: '5' });
const file = (name: string, data: string, mode = 0o664): TarEntry => ({ name, data, mode });

describe('gitTreeFromTarGz', () => {
  it("reproduces git's own tree hash of a git archive", () => {
    expect(gitTreeFromTarGz(vec('tiny.tar.gz'))).toEqual({ treeSha: TINY_TREE, files: 11, bytes: 101 });
  });

  it('a changed byte in a file gives a different tree hash', () => {
    const raw = gunzipSync(vec('tiny.tar.gz'));
    const text = new TextDecoder('latin1').decode(raw);
    const at = text.indexOf('echo hi');
    expect(at).toBeGreaterThan(0);
    const tampered = raw.slice();
    tampered[at + 6] = 'o'.charCodeAt(0);
    const got = gitTreeFromTarGz(gzipSync(tampered));
    expect(got.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(got.treeSha).not.toBe(TINY_TREE);
  });

  it('maps any exec bit to 100755 and none to 100644 (hashes from real git)', () => {
    expect(gitTreeFromTarGz(tgz([dir('x/'), file('x/a.txt', 'top\n', 0o775)])).treeSha).toBe(
      'f9d519d24333a7af545bf50605a21ac1a60a9b15',
    );
    expect(gitTreeFromTarGz(tgz([dir('x/'), file('x/a.txt', 'top\n', 0o744)])).treeSha).toBe(
      'f9d519d24333a7af545bf50605a21ac1a60a9b15',
    );
    expect(gitTreeFromTarGz(tgz([dir('x/'), file('x/a.txt', 'top\n', 0o664)])).treeSha).toBe(
      'fe60f368c29bea04121661f02bd2d51cf6a147ff',
    );
  });

  it('reads long names from a pax "path" record and from a GNU "L" entry alike', () => {
    // real git: d/<150 x "L">.txt = "hello\n" and a.txt = "top\n"
    const want = '2a6c1968843b788b70a6dd8b9ef26db1308b0af7';
    const long = `x/d/${'L'.repeat(150)}.txt`;
    const pax = tgz([
      dir('x/'),
      file('x/a.txt', 'top\n'),
      dir('x/d/'),
      { name: 'PaxHeader', type: 'x', data: paxData({ path: long }) },
      file('x/d/truncated-name', 'hello\n'),
    ]);
    const gnu = tgz([
      dir('x/'),
      file('x/a.txt', 'top\n'),
      { name: '././@LongLink', type: 'L', data: long + '\0', magic: 'gnu' },
      { ...file('x/d/other-truncated', 'hello\n'), magic: 'gnu' },
    ]);
    expect(gitTreeFromTarGz(pax).treeSha).toBe(want);
    expect(gitTreeFromTarGz(gnu).treeSha).toBe(want);
  });

  it('keeps a leading UTF-8 BOM in a name, prefix, link name or GNU long name (a system tar does)', () => {
    const treeOrError = (b: Uint8Array): string => {
      try {
        return gitTreeFromTarGz(b).treeSha;
      } catch (e) {
        return String(e);
      }
    };
    const BOM = '﻿';
    const honest = gitTreeFromTarGz(tgz([dir('x/'), dir('x/src/'), file('x/src/main.ts', 'ok\n')])).treeSha;
    // name field "EF BB BF main.ts" under the prefix "x/src"
    const inName = tgz([dir('x/'), dir('x/src/'), { name: `${BOM}main.ts`, prefix: 'x/src', data: 'ok\n' }]);
    expect(treeOrError(inName)).not.toBe(honest);
    // the same file, its prefix field starting with a BOM
    const inPrefix = tgz([dir('x/'), dir('x/src/'), { name: 'main.ts', prefix: `${BOM}x/src`, data: 'ok\n' }]);
    expect(treeOrError(inPrefix)).not.toBe(honest);
    // a GNU long name starting with a BOM
    const inLong = tgz([
      dir('x/'),
      dir('x/src/'),
      { name: '././@LongLink', type: 'L', data: `${BOM}x/src/main.ts\0`, magic: 'gnu' },
      { ...file('x/src/other', 'ok\n'), magic: 'gnu' },
    ]);
    expect(treeOrError(inLong)).not.toBe(honest);
    // a symlink target starting with a BOM is a different blob
    const link = (target: string) =>
      gitTreeFromTarGz(tgz([dir('x/'), { name: 'x/l', type: '2', linkname: target, mode: 0o777 }])).treeSha;
    expect(link(`${BOM}main.ts`)).not.toBe(link('main.ts'));
  });

  it('works without an explicit top-level directory entry and skips pax global headers', () => {
    const t = tgz([
      { name: 'pax_global_header', type: 'g', data: paxData({ comment: 'f'.repeat(40) }) },
      file('x/a.txt', 'top\n'),
    ]);
    expect(gitTreeFromTarGz(t)).toEqual({ treeSha: 'fe60f368c29bea04121661f02bd2d51cf6a147ff', files: 1, bytes: 4 });
  });

  it('has the documented default limits', () => {
    expect(GIT_TAR_LIMITS).toEqual({ maxEntries: 200_000, maxUncompressedBytes: 300 * 1024 * 1024 });
  });

  describe('fails closed', () => {
    const cases: [string, TarEntry[], RegExp][] = [
      ['a submodule (git archive writes a gitlink as an empty directory)', [dir('x/'), file('x/a', '1'), dir('x/sub/')], /submodule/],
      ['a hard link', [dir('x/'), file('x/a', '1'), { name: 'x/b', type: '1', linkname: 'x/a' }], /hard link/],
      ['a character device', [dir('x/'), { name: 'x/tty', type: '3' }], /device/],
      ['a block device', [dir('x/'), { name: 'x/sda', type: '4' }], /device/],
      ['a FIFO', [dir('x/'), { name: 'x/fifo', type: '6' }], /FIFO/],
      ['an unknown entry type', [dir('x/'), { name: 'x/v', type: 'V' }], /unsupported/],
      ['a ".." path segment', [dir('x/'), file('x/a/../../evil', '1')], /path/],
      ['a "." path segment', [dir('x/'), file('x/./a', '1')], /path/],
      ['an empty path segment', [dir('x/'), file('x/a//b', '1')], /path/],
      [
        'an absolute path',
        [dir('x/'), { name: 'PaxHeader', type: 'x', data: paxData({ path: '/etc/passwd' }) }, file('x/a', '1')],
        /path/,
      ],
      ['a duplicate path', [dir('x/'), file('x/a', '1'), file('x/a', '2')], /duplicate/],
      ['a file that is also a directory', [dir('x/'), file('x/a', '1'), file('x/a/b', '2')], /conflict/],
      ['two top-level folders', [file('x/a', '1'), file('y/b', '2')], /top-level/],
      ['a file at the top level', [file('a', '1')], /top-level/],
      ['a corrupt header checksum', [dir('x/'), { ...file('x/a', '1'), badChecksum: true }], /checksum/],
      ['a pax header with no entry after it', [dir('x/'), { name: 'P', type: 'x', data: paxData({ path: 'x/a' }) }], /extended header/],
      ['a malformed pax record', [dir('x/'), { name: 'P', type: 'x', data: '99 path=x/a\n' }, file('x/a', '1')], /pax/],
    ];
    for (const [what, entries, err] of cases) {
      it(`throws on ${what}`, () => {
        expect(() => gitTreeFromTarGz(tgz(entries))).toThrow(err);
      });
    }

    it('throws on more entries than the limit', () => {
      const t = tgz([dir('x/'), file('x/a', '1'), file('x/b', '2'), file('x/c', '3')]);
      expect(gitTreeFromTarGz(t, { maxEntries: 4 }).files).toBe(3);
      expect(() => gitTreeFromTarGz(t, { maxEntries: 3 })).toThrow(/entries/);
    });

    it('throws when the archive inflates past the size limit, without inflating all of it', () => {
      const bomb = gzipSync(new Uint8Array(64 * 1024 * 1024));
      const started = Date.now();
      expect(() => gitTreeFromTarGz(bomb, { maxUncompressedBytes: 1024 * 1024 })).toThrow(/limit/);
      expect(Date.now() - started).toBeLessThan(5_000);
      const t = tgz([dir('x/'), file('x/a', 'z'.repeat(5000))]);
      expect(() => gitTreeFromTarGz(t, { maxUncompressedBytes: 4096 })).toThrow(/limit/);
    });

    it('throws on a truncated archive', () => {
      const raw = tar([dir('x/'), file('x/a', 'z'.repeat(3000))]);
      expect(() => gitTreeFromTarGz(gzipSync(raw.subarray(0, 512 + 1024)))).toThrow(/truncated/);
      const gz = tgz([dir('x/'), file('x/a', 'z')]);
      expect(() => gitTreeFromTarGz(gz.subarray(0, gz.length - 12))).toThrow();
    });

    it('throws on bytes that are not gzip', () => {
      expect(() => gitTreeFromTarGz(new TextEncoder().encode('not a tarball'))).toThrow();
      expect(() => gitTreeFromTarGz(new Uint8Array(0))).toThrow();
    });
  });

  // Guards against parser differentials: whatever this function hashes must be exactly what a
  // system tar/gzip extracts from the same bytes, so anything two readers could read differently
  // is refused.
  describe('refuses what another tar or gzip reader could read differently', () => {
    const ok = [dir('x/'), file('x/a', '1')];
    const throwsOn = (bytes: Uint8Array, err: RegExp) => expect(() => gitTreeFromTarGz(bytes)).toThrow(err);
    const concat = (...parts: Uint8Array[]) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) (out.set(p, at), (at += p.length));
      return out;
    };

    it('(1) a pax global header with any key but comment', () => {
      const g = (rec: Record<string, string>) => ({ name: 'pax_global_header', type: 'g', data: paxData(rec) });
      expect(gitTreeFromTarGz(tgz([g({ comment: 'abc' }), ...ok])).files).toBe(1);
      throwsOn(tgz([g({ comment: 'abc', path: 'x/evil' }), ...ok]), /global/);
      throwsOn(tgz([g({ mtime: '1' }), ...ok]), /global/);
    });

    it('(2) stacked or conflicting extended headers', () => {
      const x = (rec: Record<string, string>) => ({ name: 'P', type: 'x', data: paxData(rec) });
      const L = (v: string) => ({ name: '././@LongLink', type: 'L', data: v + '\0', magic: 'gnu' as const });
      const K = (v: string) => ({ name: '././@LongLink', type: 'K', data: v + '\0', magic: 'gnu' as const });
      throwsOn(tgz([dir('x/'), x({ path: 'x/a' }), x({ path: 'x/b' }), file('x/c', '1')]), /extended header/);
      throwsOn(tgz([dir('x/'), L('x/a'), L('x/b'), file('x/c', '1')]), /long name/);
      throwsOn(tgz([dir('x/'), file('x/t', '1'), K('t'), K('x/t'), { name: 'x/l', type: '2', linkname: 't' }]), /long (link|name)/);
      throwsOn(tgz([dir('x/'), x({ path: 'x/a' }), L('x/b'), file('x/c', '1')]), /both/);
      throwsOn(
        tgz([dir('x/'), file('x/t', '1'), x({ linkpath: 't' }), K('x/t'), { name: 'x/l', type: '2', linkname: 't' }]),
        /both/,
      );
    });

    it('(3) anything but two or more zero blocks closing the archive', () => {
      throwsOn(tgz(ok, new Uint8Array(512)), /zero blocks/); // one zero block only
      throwsOn(tgz(ok, new Uint8Array(0)), /truncated|zero blocks/);
      // a lone zero block, then an entry other readers would extract
      const hidden = tar([file('x/hidden', 'boo')]);
      throwsOn(gzipSync(concat(tar(ok, new Uint8Array(512)), hidden)), /after the end|zero blocks/);
      const tail = new Uint8Array(10240);
      tail[5000] = 1;
      throwsOn(tgz(ok, tail), /after the end/);
      expect(gitTreeFromTarGz(tgz(ok, new Uint8Array(10240))).files).toBe(1); // record padding is fine
    });

    it('(4) a multi-member gzip, or bytes after the first member', () => {
      const raw = tar(ok);
      throwsOn(concat(gzipSync(raw.subarray(0, 1024)), gzipSync(raw.subarray(1024))), /member/);
      throwsOn(concat(gzipSync(raw), gzipSync(new Uint8Array(0))), /member/);
      const gz = gzipSync(raw);
      for (const extra of [[1], [1, 2, 3], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], Array.from('trailing garbage', (c) => c.charCodeAt(0))]) {
        throwsOn(concat(gz, new Uint8Array(extra)), /gzip/);
      }
      const badCrc = gz.slice();
      badCrc[badCrc.length - 8]! ^= 1;
      throwsOn(badCrc, /gzip/);
      const badFlags = gz.slice();
      badFlags[3]! |= 0x20;
      throwsOn(badFlags, /gzip/);
    });

    it('(5) pax keys outside the allowlist, a NUL in a path, a link path on a non-link, a repeated key', () => {
      const x = (rec: Record<string, string>) => ({ name: 'P', type: 'x', data: paxData(rec) });
      for (const k of ['GNU.sparse.size', 'GNU.sparse.map', 'SCHILY.xattr.user.a', 'LIBARCHIVE.xattr.a', 'hdrcharset', 'charset', 'realtime.x']) {
        throwsOn(tgz([dir('x/'), x({ [k]: '1' }), file('x/a', '1')]), /pax key/);
      }
      const fine = { mtime: '1.5', atime: '1', ctime: '1', uid: '0', gid: '0', uname: 'root', gname: 'root', comment: 'c' };
      expect(gitTreeFromTarGz(tgz([dir('x/'), x(fine), file('x/a', '1')])).files).toBe(1);
      throwsOn(tgz([dir('x/'), x({ path: 'x/a\0b' }), file('x/a', '1')]), /NUL/);
      throwsOn(tgz([dir('x/'), x({ linkpath: 'x/b' }), file('x/a', '1')]), /link/);
      throwsOn(tgz([dir('x/'), { name: 'P', type: 'x', data: paxData({ path: 'x/a' }) + paxData({ path: 'x/b' }) }, file('x/c', '1')]), /twice/);
    });

    it('also: an unknown header format, a stray link name, data on a directory or symlink', () => {
      throwsOn(tgz([dir('x/'), { ...file('x/a', '1'), magic: 'none' }]), /format/);
      throwsOn(tgz([dir('x/'), { ...file('x/a', '1'), linkname: 'x/b' }]), /link/);
      throwsOn(tgz([dir('x/'), file('x/a', '1'), { name: 'x/d/', type: '5', data: 'zz' }]), /data/);
      throwsOn(tgz([dir('x/'), file('x/a', '1'), { name: 'x/l', type: '2', linkname: 'a', data: 'zz' }]), /data/);
    });
  });

  it.skipIf(!process.env.RECALL_LIVE_GIT)(
    'live: the codeload tarball of a real bitchat commit hashes to the tree GitHub reports',
    async () => {
      const res = await fetch(
        codeloadTarGzUrl({ owner: 'permissionlesstech', repo: 'bitchat', commitSha: '04995f68e470a18d1fc99f86fa326c2a87bab4f2' }),
      );
      expect(res.status).toBe(200);
      const got = gitTreeFromTarGz(new Uint8Array(await res.arrayBuffer()));
      expect(got.treeSha).toBe('74f38d254ea1a6a87caec1016b29dc4ca296b5ff');
    },
    180_000,
  );
});

// bitchat-branch-main.json: the body of GET https://api.github.com/repos/permissionlesstech/bitchat/branches/main
const BITCHAT = {
  owner: 'permissionlesstech',
  repo: 'bitchat',
  branch: 'main',
  commitSha: '04995f68e470a18d1fc99f86fa326c2a87bab4f2',
  treeSha: '74f38d254ea1a6a87caec1016b29dc4ca296b5ff',
};
const bitchatJson = () => JSON.parse(new TextDecoder().decode(vec('bitchat-branch-main.json'))) as Record<string, any>;
const API_URL = 'https://api.github.com/repos/permissionlesstech/bitchat/branches/main';

describe('parseGitHubBranch', () => {
  it('reads owner, repo, branch, commit and tree from the real GitHub response', () => {
    expect(parseGitHubBranch(vec('bitchat-branch-main.json'))).toEqual(BITCHAT);
    expect(parseGitHubBranch(new TextDecoder().decode(vec('bitchat-branch-main.json')))).toEqual(BITCHAT);
  });

  it('accepts owner/repo from either _links.self or commit.url alone', () => {
    const a = bitchatJson();
    delete a._links;
    expect(parseGitHubBranch(JSON.stringify(a))).toEqual(BITCHAT);
    const b = bitchatJson();
    delete b.commit.url;
    expect(parseGitHubBranch(JSON.stringify(b))).toEqual(BITCHAT);
  });

  const bad: [string, (j: Record<string, any>) => void][] = [
    ['a short commit sha', (j) => (j.commit.sha = j.commit.sha.slice(0, 39))],
    ['an upper-case commit sha', (j) => (j.commit.sha = j.commit.sha.toUpperCase())],
    ['a non-hex tree sha', (j) => (j.commit.commit.tree.sha = 'z'.repeat(40))],
    ['a missing tree', (j) => delete j.commit.commit.tree],
    ['no _links.self and no commit.url', (j) => (delete j._links, delete j.commit.url)],
    ['_links.self naming another branch', (j) => (j._links.self = j._links.self.replace(/main$/, 'dev'))],
    ['_links.self and commit.url naming different repos', (j) => (j.commit.url = j.commit.url.replace('/bitchat/', '/other/'))],
    ['commit.url naming another commit', (j) => (j.commit.url = j.commit.url.replace(/[0-9a-f]{40}$/, 'a'.repeat(40)))],
    ['tree.url naming another tree', (j) => (j.commit.commit.tree.url = j.commit.commit.tree.url.replace(/[0-9a-f]{40}$/, 'b'.repeat(40)))],
    ['_links.self on another host', (j) => (j._links.self = j._links.self.replace('api.github.com', 'api.evil.com'))],
    ['a name that is not a string', (j) => (j.name = 7)],
    ['a branch name with ".."', (j) => ((j.name = 'a..b'), (j._links.self = j._links.self.replace(/main$/, 'a..b')))],
  ];
  for (const [what, mutate] of bad) {
    it(`throws on ${what}`, () => {
      const j = bitchatJson();
      mutate(j);
      expect(() => parseGitHubBranch(JSON.stringify(j))).toThrow();
    });
  }

  it('throws on bytes that are not a JSON object', () => {
    expect(() => parseGitHubBranch('[]')).toThrow();
    expect(() => parseGitHubBranch('not json')).toThrow();
    expect(() => parseGitHubBranch(new Uint8Array([0xff, 0xfe]))).toThrow();
  });

  it('accepts another API host when told to (the devnet fixture)', () => {
    const j = bitchatJson();
    const s = JSON.stringify(j).replaceAll('https://api.github.com/', 'https://api.github.recall.test/');
    expect(() => parseGitHubBranch(s)).toThrow();
    expect(parseGitHubBranch(s, { apiHost: 'api.github.recall.test' })).toEqual(BITCHAT);
  });

  it('accepts branch names with slashes', () => {
    const j = bitchatJson();
    j.name = 'feature/x-1.2';
    j._links.self = j._links.self.replace(/main$/, 'feature/x-1.2');
    expect(parseGitHubBranch(JSON.stringify(j)).branch).toBe('feature/x-1.2');
  });
});

describe('githubBranchFromFacts', () => {
  const facts = (over: Partial<{ canonicalUrl: string; body: Uint8Array; httpStatus: number; contentType?: string }> = {}) => ({
    canonicalUrl: API_URL,
    body: vec('bitchat-branch-main.json'),
    httpStatus: 200,
    contentType: 'application/json; charset=utf-8',
    ...over,
  });

  it('returns the branch when the captured URL and the JSON agree', () => {
    expect(githubBranchFromFacts(facts())).toEqual(BITCHAT);
    expect(githubBranchApiUrl(BITCHAT)).toBe(API_URL);
  });

  it('compares owner and repo case-insensitively (GitHub does), branch exactly', () => {
    expect(githubBranchFromFacts(facts({ canonicalUrl: API_URL.replace('permissionlesstech/bitchat', 'PermissionlessTech/BitChat') }))).toEqual(BITCHAT);
    expect(githubBranchFromFacts(facts({ canonicalUrl: API_URL.replace(/main$/, 'Main') }))).toBeNull();
  });

  const nulls: [string, Parameters<typeof facts>[0]][] = [
    ['another repo in the URL', { canonicalUrl: API_URL.replace('/bitchat/', '/other/') }],
    ['another branch in the URL', { canonicalUrl: API_URL.replace(/main$/, 'dev') }],
    ['a query string', { canonicalUrl: API_URL + '?x=1' }],
    ['a trailing slash', { canonicalUrl: API_URL + '/' }],
    ['another host', { canonicalUrl: API_URL.replace('api.github.com', 'github.com') }],
    ['another path', { canonicalUrl: 'https://api.github.com/repos/permissionlesstech/bitchat/commits/main' }],
    ['plain http', { canonicalUrl: API_URL.replace('https:', 'http:') }],
    ['a non-200 status', { httpStatus: 301 }],
    ['a non-JSON content type', { contentType: 'text/html' }],
    ['no content type', { contentType: undefined }],
    ['a body that is not the branch JSON', { body: new TextEncoder().encode('{"message":"Not Found"}') }],
  ];
  for (const [what, over] of nulls) {
    it(`returns null for ${what}`, () => {
      expect(githubBranchFromFacts(facts(over))).toBeNull();
    });
  }

  it('uses the given API host for the devnet fixture', () => {
    const body = new TextEncoder().encode(
      new TextDecoder().decode(vec('bitchat-branch-main.json')).replaceAll('https://api.github.com/', 'https://api.github.recall.test/'),
    );
    const url = API_URL.replace('api.github.com', 'api.github.recall.test');
    expect(githubBranchFromFacts(facts({ canonicalUrl: url, body }))).toBeNull();
    expect(githubBranchFromFacts(facts({ canonicalUrl: url, body }), { apiHost: 'api.github.recall.test' })).toEqual(BITCHAT);
    expect(codeloadTarGzUrl(BITCHAT, 'codeload.github.recall.test')).toBe(
      `https://codeload.github.recall.test/permissionlesstech/bitchat/tar.gz/${BITCHAT.commitSha}`,
    );
  });
});
