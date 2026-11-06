#!/usr/bin/env bash
# Stops what scripts/tunnel.sh started: the cloudflared quick tunnel (pid file) and the
# live witness container. WITNESS_PUBLIC_URL in .env.local is left as is (the next
# `pnpm tunnel:up` replaces it; a quick-tunnel URL never comes back).
set -euo pipefail

CONTAINER="recall-witness-live"
TMP_BASE="${TMPDIR:-/tmp}"
RUN_DIR="${RECALL_TUNNEL_DIR:-${TMP_BASE%/}/recall-tunnel}"
PID_FILE="$RUN_DIR/cloudflared.pid"
URL_FILE="$RUN_DIR/url"

say() { echo "[tunnel] $*"; }

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q cloudflared; then
  kill "$pid"
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  say "stopped cloudflared (pid $pid)"
else
  say "no running tunnel"
fi
rm -f "$PID_FILE" "$URL_FILE"

if docker rm -f "$CONTAINER" >/dev/null 2>&1; then
  say "removed $CONTAINER"
else
  say "no $CONTAINER container"
fi
