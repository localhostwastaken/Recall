#!/usr/bin/env bash
# Packages the RELEASE extension for teammates: runs the release build (Mozilla roots, no dev
# CA, no dev test hook; build-release-extension.sh refuses to finish if any dev marker is left)
# and zips extension/packages/extension/build-release/ into dist/recall-extension.zip
# (gitignored). Unzip it and load the folder with "Load unpacked" in chrome://extensions.
#
# Set RECALL_SKIP_BUILD=1 to zip the build-release/ that is already there (it is still
# checked for the same dev markers).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/extension/packages/extension/build-release"
ZIP="$ROOT/dist/recall-extension.zip"

fail() { echo "package-extension FAILED: $*" >&2; exit 1; }
command -v zip >/dev/null || fail "zip is not installed"

if [ "${RECALL_SKIP_BUILD:-}" != "1" ]; then
  bash "$ROOT/scripts/build-release-extension.sh"
fi

[ -f "$OUT/manifest.json" ] || fail "no $OUT/manifest.json (run without RECALL_SKIP_BUILD=1)"
# Re-check what goes into the zip: the manifest name and the dev-only markers.
name="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$OUT/manifest.json")"
[ "$name" = "Recall" ] || fail "manifest name is '$name', expected 'Recall' (not a release build)"
for marker in captureForTest __RECALL_DEV__ __RECALL_DEV_CA_DER_B64__ devCa 'Recall (dev)'; do
  if grep -rlF -- "$marker" "$OUT" >/dev/null; then
    fail "found dev marker '$marker' in the release build"
  fi
done

mkdir -p "$ROOT/dist"
rm -f "$ZIP"
# -X drops file timestamps' extra fields, -r recurses; the manifest sits at the zip's top level.
(cd "$OUT" && zip -q -r -X "$ZIP" . -x '.DS_Store' '*/.DS_Store')

# The zip must open on its own: manifest at the root, no dev files.
unzip -p "$ZIP" manifest.json >/dev/null || fail "manifest.json is not at the top of the zip"
echo "Wrote $ZIP ($(du -h "$ZIP" | cut -f1), $(unzip -Z1 "$ZIP" | wc -l | tr -d ' ') files, manifest name \"$name\")"
