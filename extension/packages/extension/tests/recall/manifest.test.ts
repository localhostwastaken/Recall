import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import source from '../../src/manifest.json';

const { recallManifest, RELEASE_CONNECTABLE } = createRequire(import.meta.url)(
  '../../utils/recallManifest.js',
) as {
  recallManifest: (m: typeof source, o: { dev: boolean }) => typeof source;
  RELEASE_CONNECTABLE: string[];
};

describe('the shipped manifest', () => {
  it('a release build accepts messages from the GitHub Pages app only', () => {
    const release = recallManifest(source, { dev: false });
    expect(RELEASE_CONNECTABLE).toEqual(['https://localhostwastaken.github.io/*']);
    expect(release.externally_connectable).toEqual({ matches: ['https://localhostwastaken.github.io/*'] });
    expect(release.name).toBe('Recall');
    // Everything else is the source manifest.
    expect({ ...release, externally_connectable: source.externally_connectable }).toEqual(source);
  });

  it('a dev build keeps the localhost and bzz.link origins the e2e tests use, and says (dev)', () => {
    const dev = recallManifest(source, { dev: true });
    expect(dev.name).toBe('Recall (dev)');
    expect(dev.externally_connectable.matches).toEqual(
      expect.arrayContaining([
        'http://localhost:5173/*',
        'http://localhost:1633/*',
        'https://*.bzz.link/*',
        'https://localhostwastaken.github.io/*',
      ]),
    );
  });

  it('does not change the source object', () => {
    const before = JSON.stringify(source);
    recallManifest(source, { dev: false });
    recallManifest(source, { dev: true });
    expect(JSON.stringify(source)).toBe(before);
  });
});
