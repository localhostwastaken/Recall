import { describe, expect, it } from 'vitest';
import { isTestAddress } from '../src/library/model';

describe('isTestAddress', () => {
  it('matches our fictional notice page with any query, and the devnet notice host', () => {
    expect(isTestAddress('localhostwastaken.github.io/Recall/notice/?run=mm0107')).toBe(true);
    expect(isTestAddress('localhostwastaken.github.io/Recall/notice/')).toBe(true);
    expect(isTestAddress('notice.recall.test/p0-live')).toBe(true);
  });
  it('leaves real pages and repos alone', () => {
    expect(isTestAddress('info.cern.ch/hypertext/WWW/TheProject.html')).toBe(false);
    expect(isTestAddress('api.github.com/repos/permissionlesstech/bitchat/branches/main')).toBe(false);
    expect(isTestAddress('localhostwastaken.github.io/Recall/app/')).toBe(false);
    expect(isTestAddress('evil.example/localhostwastaken.github.io/Recall/notice/')).toBe(false);
  });
});
