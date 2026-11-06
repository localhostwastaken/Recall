import { createHash, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import source from '../../src/manifest.json';

const { recallManifest, RELEASE_CONNECTABLE, RELEASE_KEY, RELEASE_EXTENSION_ID } = createRequire(import.meta.url)(
  '../../utils/recallManifest.js',
) as {
  recallManifest: (m: typeof source, o: { dev: boolean }) => typeof source & { key?: string };
  RELEASE_CONNECTABLE: string[];
  RELEASE_KEY: string;
  RELEASE_EXTENSION_ID: string;
};

/** The fixed ID of the release extension, as the web app defaults to it (apps/web/src/defaults.ts). */
const FIXED_ID = 'mgpclfpdgpinofgpgfeodcbmlfaglmnp';

describe('the shipped manifest', () => {
  it('a release build accepts messages from the GitHub Pages app only', () => {
    const release = recallManifest(source, { dev: false });
    expect(RELEASE_CONNECTABLE).toEqual(['https://localhostwastaken.github.io/*']);
    expect(release.externally_connectable).toEqual({ matches: ['https://localhostwastaken.github.io/*'] });
    expect(release.name).toBe('Recall');
    // Everything else is the source manifest, plus the fixed key.
    const { key, ...rest } = release;
    expect(key).toBe(RELEASE_KEY);
    expect({ ...rest, externally_connectable: source.externally_connectable }).toEqual(source);
  });

  it('a release build carries the public key, so every unpacked install has the same extension ID', () => {
    const release = recallManifest(source, { dev: false });
    expect(release.key).toBe(RELEASE_KEY);
    // A public RSA-2048 key (base64 of the DER SubjectPublicKeyInfo), nothing private.
    const k = createPublicKey({ key: Buffer.from(RELEASE_KEY, 'base64'), format: 'der', type: 'spki' });
    expect(k.asymmetricKeyType).toBe('rsa');
    expect(k.asymmetricKeyDetails?.modulusLength).toBe(2048);
    // Chrome's ID: SHA-256 of the DER key, first 16 bytes as hex, 0-9a-f mapped to a-p.
    const id = createHash('sha256')
      .update(Buffer.from(RELEASE_KEY, 'base64'))
      .digest('hex')
      .slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'['0123456789abcdef'.indexOf(c)]);
    expect(id).toBe(FIXED_ID);
    expect(RELEASE_EXTENSION_ID).toBe(FIXED_ID);
  });

  it('the source manifest and a dev build have no key (each e2e profile keeps its own random ID)', () => {
    expect(source).not.toHaveProperty('key');
    expect(recallManifest(source, { dev: true })).not.toHaveProperty('key');
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
