import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gitTreeFromTarGz, githubBranchFromFacts } from '../../../packages/evidence/src/git';
import { FIXTURE_OWNER, branchJson, buildFixtureRepos } from '../gitRepo.ts';

// The GitHub-like fixture without the container: the tarball must pass the adapter's strict
// parser and hash to the tree the branch JSON names; the tampered one must not.
const here = path.dirname(fileURLToPath(import.meta.url));
const git = buildFixtureRepos(path.join(here, '..', 'content', 'repo'));
const HOST = 'api.github.recall.test';

describe('git fixture repository', () => {
  it('the demo tarball hashes to the tree its branch JSON names', () => {
    const got = gitTreeFromTarGz(git.good.tarGz);
    expect(got.treeSha).toBe(git.good.treeSha);
    expect(got.files).toBe(5);
    const facts = {
      canonicalUrl: `https://${HOST}/repos/${FIXTURE_OWNER}/demo/branches/main`,
      body: new Uint8Array(branchJson(git.good, HOST)),
      httpStatus: 200,
      contentType: 'application/json; charset=utf-8',
    };
    expect(githubBranchFromFacts(facts, { apiHost: HOST })).toEqual({
      owner: FIXTURE_OWNER,
      repo: 'demo',
      branch: 'main',
      commitSha: git.good.commitSha,
      treeSha: git.good.treeSha,
    });
  });

  it('the tampered tarballs parse but hash to another tree', () => {
    for (const t of [git.tampered.tarGz, git.tamperedTarGzOfGood]) {
      const got = gitTreeFromTarGz(t);
      expect(got.treeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(got.treeSha).not.toBe(git.good.treeSha);
    }
    expect(git.tampered.treeSha).toBe(git.good.treeSha);
  });

  it('real git agrees with the tree id (exec bit kept)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-gitfix-'));
    try {
      execFileSync('tar', ['-xzf', '-', '-C', dir], { input: git.good.tarGz });
      const top = path.join(dir, `demo-${git.good.commitSha}`);
      execFileSync('git', ['init', '-q'], { cwd: top });
      execFileSync('git', ['add', '-A'], { cwd: top });
      expect(execFileSync('git', ['write-tree'], { cwd: top }).toString().trim()).toBe(git.good.treeSha);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
