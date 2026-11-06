// Recall: the manifest a build ships, from src/manifest.json (used by webpack.config.js).

const { createHash } = require('node:crypto');

/**
 * The public half of the release extension's key pair (base64 of the DER SubjectPublicKeyInfo),
 * written to the release manifest as "key". Chrome derives the extension ID from it, so every
 * "Load unpacked" of the release gets the same ID, and the web app can default to it
 * (apps/web/src/defaults.ts). The private key is not in the repo; unpacked installs do not need it.
 * The dev build has no key, so each e2e profile keeps its own random ID.
 */
const RELEASE_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo9mDJAdCT0XECPs0d4nWpG8uILVRFMruE82P5c6SLf+GOGyg1bvPnO9MkkDWURd8gzcaGYBrZph3cfqb68RaNztjk8b5r6lVbHgx67YZY3b/9cbUgRuraCpuMrt7FFz8sByy/rrWCzPg+klzpCsy2Z65biXriOhP6TrjaR9i9LA5Kjw3MtkCpYpJqvSp7WpBXqZ12cyw5nqKjNkUjZkqQwstFQh2Ji955x8GsNdqcCl1jh77c7iF8QOk7NOBJbB5ocpE+pgdpBYDTtnYV7+VsdIGsQvU/nnXILbyM0i4e+rzYTVpctD92sgn1c4DYoo62Y5i0wqlZmEQXZgMNVWiKwIDAQAB';

/** The ID Chrome gives an extension with this "key": SHA-256 of the DER key, first 16 bytes, hex mapped 0-9a-f to a-p. */
function extensionIdFromKey(keyB64) {
  const hex = createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));
}

/** The fixed ID of the release extension. */
const RELEASE_EXTENSION_ID = extensionIdFromKey(RELEASE_KEY);

/**
 * Pages that may message the extension (externally_connectable) in a release build: the GitHub
 * Pages app only. The localhost app and Bee origins and *.bzz.link (shared gateway origins, where
 * any site could call the extension) stay in dev builds, which the e2e tests use.
 */
const RELEASE_CONNECTABLE = ['https://localhostwastaken.github.io/*'];

/** `manifest` as a dev build (name "Recall (dev)") or a release build ships it. */
function recallManifest(manifest, { dev }) {
  const out = { ...manifest };
  if (dev) {
    // A dev build (test CA, devnet defaults) is labelled so it is never mistaken for the release.
    out.name = `${out.name} (dev)`;
  } else {
    out.externally_connectable = { ...out.externally_connectable, matches: [...RELEASE_CONNECTABLE] };
    out.key = RELEASE_KEY;
  }
  return out;
}

module.exports = { RELEASE_CONNECTABLE, RELEASE_KEY, RELEASE_EXTENSION_ID, extensionIdFromKey, recallManifest };
