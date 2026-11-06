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
# anything and only handed to the build.
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
if [ -z "${ARKIV_ACCESS_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
  if key="$(read_env_value "$ENV_FILE" ARKIV_ACCESS_KEY)"; then export ARKIV_ACCESS_KEY="$key"; fi
  unset key
fi
if [ -z "${ARKIV_ACCESS_KEY:-}" ]; then
  echo "WARNING: release build has NO built-in Arkiv key (ARKIV_ACCESS_KEY is neither in the environment nor in .env.local)." >&2
  echo "         Reads then use the rate-limited public Arkiv endpoint unless the person sets a key in Settings." >&2
fi

cd "$EXT"
[ -d node_modules ] || npm install
# Dev flags must never leak in from the caller's shell.
env -u RECALL_DEV_CA_DER_B64 -u RECALL_DEV RECALL_BUILD_DIR=build-release npm run build

fail() { echo "release build check FAILED: $*" >&2; exit 1; }

[ -f "$OUT/manifest.json" ] || fail "no $OUT/manifest.json"
name="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$OUT/manifest.json")"
[ "$name" = "Recall" ] || fail "manifest name is '$name', expected 'Recall'"

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

echo "Release build OK: $OUT (name \"$name\", Mozilla roots, no dev hook)"
