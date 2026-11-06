// Recall: the manifest a build ships, from src/manifest.json (used by webpack.config.js).

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
  }
  return out;
}

module.exports = { RELEASE_CONNECTABLE, recallManifest };
