import { describe, expect, it } from 'vitest';
import { gitCheckCommand } from '../src/components/RepoSnapshot';

describe('gitCheckCommand', () => {
  it('unpacks the downloaded file by its saved name and prints the tree hash with plain git', () => {
    const cmd = gitCheckCommand({
      owner: 'permissionlesstech',
      repo: 'bitchat',
      branch: 'main',
      commitSha: '04995f68aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      treeSha: '74f38d25bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    expect(cmd).toBe(
      'mkdir recall-check && tar xzf bitchat-04995f6.tar.gz -C recall-check --strip-components=1 && cd recall-check && git init -q && git add -A -f && git write-tree',
    );
  });
});
