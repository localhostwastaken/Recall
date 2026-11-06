#!/usr/bin/env bash
# Builds the RELEASE extension into extension/packages/extension/build-release/:
# Mozilla roots (no dev CA), no dev test hook, manifest name "Recall". The dev build
# in build/ (used by the local e2e tests) is left alone. Fails if the output still
# holds anything dev-only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"
OUT="$EXT/packages/extension/build-release"
DEV_CA="$ROOT/fixtures/notice/.certs/ca.der"

# The release build bakes the public Arkiv access key in as the default (R30). It comes from the
# environment, else from the git-ignored repo-root .env.local; it is read here without printing
# anything and only handed to the build command.
read_env_value() { # <file> <NAME>: the last NAME=value line, quotes removed, nothing echoed
  local line v
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  v="${line#*=}"; v="${v%$'\r'}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}";; \'*\') v="${v#\'}"; v="${v%\'}";; esac
  [ -n "$v" ] || return 1
  printf '%s' "$v"
}
ENV_FILE="${RECALL_ENV_FILE:-$ROOT/.env.local}"
# Tracing (bash -x) is switched off while the key is handled, so it never shows in a trace log;
# it is switched back on afterwards if it was on. The key lives in a plain shell variable (not
# exported), so `npm install` below never sees it; only the build command gets it.
xtrace_was_on=0
case "$-" in *x*) xtrace_was_on=1;; esac
{ set +x; } 2>/dev/null
ARKIV_KEY=""
if [ -n "${ARKIV_ACCESS_KEY:-}" ]; then
  ARKIV_KEY="$ARKIV_ACCESS_KEY"
  unset ARKIV_ACCESS_KEY
elif [ -f "$ENV_FILE" ]; then
  if key="$(read_env_value "$ENV_FILE" ARKIV_ACCESS_KEY)"; then ARKIV_KEY="$key"; fi
  unset key
fi
if [ -z "$ARKIV_KEY" ]; then
  echo "WARNING: release build has NO built-in Arkiv key (ARKIV_ACCESS_KEY is neither in the environment nor in .env.local)." >&2
  echo "         Reads then use the rate-limited public Arkiv endpoint unless the person sets a key in Settings." >&2
fi
if [ "$xtrace_was_on" = 1 ]; then set -x; fi

cd "$EXT"
# The key is not in the environment here (see above), even when the caller's shell exports it.
[ -d node_modules ] || env -u ARKIV_ACCESS_KEY npm install
# Dev flags must never leak in from the caller's shell. The key goes to the build command only,
# as an environment variable (not an argument, which `ps` would show), with tracing off.
{ set +x; } 2>/dev/null
if [ -n "$ARKIV_KEY" ]; then
  ARKIV_ACCESS_KEY="$ARKIV_KEY" env -u RECALL_DEV_CA_DER_B64 -u RECALL_DEV RECALL_BUILD_DIR=build-release npm run build
else
  env -u ARKIV_ACCESS_KEY -u RECALL_DEV_CA_DER_B64 -u RECALL_DEV RECALL_BUILD_DIR=build-release npm run build
fi
if [ "$xtrace_was_on" = 1 ]; then set -x; fi

fail() { echo "release build check FAILED: $*" >&2; exit 1; }

[ -f "$OUT/manifest.json" ] || fail "no $OUT/manifest.json"
name="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$OUT/manifest.json")"
[ "$name" = "Recall" ] || fail "manifest name is '$name', expected 'Recall'"
# Only the GitHub Pages app may message a release build (no localhost, no shared bzz.link origins).
connectable="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).externally_connectable.matches.join(" "))' "$OUT/manifest.json")"
[ "$connectable" = "https://localhostwastaken.github.io/*" ] || fail "externally_connectable is '$connectable', expected only https://localhostwastaken.github.io/*"

# The release manifest carries the fixed public key (utils/recallManifest.js), so every "Load unpacked"
# of the release gets the same extension ID, the one the web app defaults to.
ext_id="$(node -e '
  const m = require(process.argv[1]);
  const manifest = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
  if (manifest.key !== m.RELEASE_KEY) { console.error("manifest key is missing or is not the release key"); process.exit(1); }
  process.stdout.write(m.extensionIdFromKey(manifest.key));
' "$EXT/packages/extension/utils/recallManifest.js" "$OUT/manifest.json")" || fail "the release manifest has no fixed key"

# Dev-only markers: the Playwright test hook, the dev build object, the dev label.
for marker in captureForTest __RECALL_DEV__ __RECALL_DEV_CA_DER_B64__ devCa 'Recall (dev)'; do
  if grep -rlF -- "$marker" "$OUT" >/dev/null; then
    fail "found '$marker' in $(grep -rlF -- "$marker" "$OUT" | head -3 | tr '\n' ' ')"
  fi
done
# The dev CA must not be embedded (release builds trust the Mozilla roots).
if [ -f "$DEV_CA" ]; then
  ca_b64="$(base64 < "$DEV_CA" | tr -d '\n')"
  if grep -rlF -- "${ca_b64:0:64}" "$OUT" >/dev/null; then fail "the dev CA is embedded"; fi
fi

echo "Release build OK: $OUT (name \"$name\", extension ID $ext_id, Mozilla roots, no dev hook)"
