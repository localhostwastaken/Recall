#!/usr/bin/env bash
# Starts the LIVE witness and exposes it through a Cloudflare quick tunnel.
#
# 1. (Re)creates the container recall-witness-live from the devnet witness image:
#    real key (WITNESS_PRIVATE_KEY from .env.local, passed in alone), Mozilla roots
#    (no dev CA, no dev allow-list), published on 127.0.0.1:7048 only, and
#    TRUST_CF_HEADER=1 (safe only because the tunnel is the one way in).
# 2. Runs `cloudflared tunnel --url` in the background (pid file), or keeps the
#    running tunnel when it still serves this witness.
# 3. Writes the https://*.trycloudflare.com URL to WITNESS_PUBLIC_URL in .env.local
#    (only that line changes) and prints it.
#
# Stop everything with scripts/tunnel-stop.sh (pnpm tunnel:down).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
COMPOSE_FILE="$ROOT/devnet/docker-compose.yml"
CONTAINER="recall-witness-live"
LOCAL_PORT=7048
LOCAL_URL="http://127.0.0.1:$LOCAL_PORT"
# The address of WITNESS_PRIVATE_KEY (public). Override only for a new key.
EXPECTED_SIGNER="${WITNESS_EXPECTED_SIGNER:-0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D}"
TMP_BASE="${TMPDIR:-/tmp}"
RUN_DIR="${RECALL_TUNNEL_DIR:-${TMP_BASE%/}/recall-tunnel}"
# Edge transport. QUIC (cloudflared's default, UDP 7844) stalled bulk WebSocket data
# after ~50 KB on this network, while MPC-TLS sends ~80 MB per capture; http2 (TCP 443)
# carried it at full speed. Set TUNNEL_PROTOCOL=quic or auto to try the others.
TUNNEL_PROTOCOL="${TUNNEL_PROTOCOL:-http2}"
PID_FILE="$RUN_DIR/cloudflared.pid"
LOG_FILE="$RUN_DIR/cloudflared.log"
URL_FILE="$RUN_DIR/url"

say() { echo "[tunnel] $*"; }
die() { echo "[tunnel] ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is not installed"
command -v cloudflared >/dev/null || die "cloudflared is not installed (brew install cloudflared)"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
mkdir -p "$RUN_DIR"

# The signer address /info reports at $1, lower-cased ("" if unreachable).
signer_at() {
  { curl -fsS --max-time 10 "$1/info" 2>/dev/null || true; } |
    sed -n 's/.*"signer":"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' | tr 'A-F' 'a-f'
}
expected="$(printf '%s' "$EXPECTED_SIGNER" | tr 'A-F' 'a-f')"

# ---- 1. live witness -------------------------------------------------------------
say "building the witness image (cached unless witness/ changed)"
docker compose -f "$COMPOSE_FILE" build witness >/dev/null
IMAGE="$(docker compose -f "$COMPOSE_FILE" config --images witness | grep -- '-witness$' | head -n1 || true)"
[ -n "$IMAGE" ] || die "could not resolve the witness image name"

# Only this one value leaves .env.local. It is never printed and never on a command line.
key="$(sed -n 's/^[[:space:]]*WITNESS_PRIVATE_KEY[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | head -n1 |
  tr -d '\r' | sed -e 's/[[:space:]]*$//' -e "s/^['\"]//" -e "s/['\"]\$//")"
[ -n "$key" ] || die "WITNESS_PRIVATE_KEY is missing in .env.local"

say "starting $CONTAINER on 127.0.0.1:$LOCAL_PORT (Mozilla roots, TRUST_CF_HEADER=1)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
WITNESS_PRIVATE_KEY="$key" docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --label recall.role=live-witness \
  -p "127.0.0.1:$LOCAL_PORT:7047" \
  -e WITNESS_PRIVATE_KEY \
  -e TRUST_CF_HEADER=1 \
  -e MAX_SESSIONS=3 \
  -e MAX_SESSIONS_PER_IP=2 \
  -e GIT_HASH="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)" \
  "$IMAGE" >/dev/null
unset key

got=""
for _ in $(seq 1 30); do
  got="$(signer_at "$LOCAL_URL")"
  [ -n "$got" ] && break
  sleep 1
done
if [ "$got" != "$expected" ]; then
  docker logs --tail 20 "$CONTAINER" 2>&1 | grep -v -i 'private' >&2 || true
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  die "the live witness signer is '${got:-unreachable}', expected $EXPECTED_SIGNER"
fi
logs="$(docker logs "$CONTAINER" 2>&1)"
if grep -q 'DEV CA MODE' <<<"$logs"; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  die "the live witness started in DEV CA mode"
fi
grep -q 'client IP from CF-Connecting-IP' <<<"$logs" || die "the live witness does not trust CF-Connecting-IP"
say "witness ready, signer $EXPECTED_SIGNER"

# ---- 2. quick tunnel -------------------------------------------------------------
tunnel_pid() {
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && ps -p "$pid" -o command= | grep -q cloudflared; then
    echo "$pid"
  fi
}
tunnel_protocol_ok() {
  ps -p "$1" -o command= | grep -q -- "--protocol $TUNNEL_PROTOCOL "
}

url=""
if [ -n "$(tunnel_pid)" ] && tunnel_protocol_ok "$(tunnel_pid)" && [ -s "$URL_FILE" ]; then
  old="$(cat "$URL_FILE")"
  if [ "$(signer_at "$old")" = "$expected" ]; then
    url="$old"
    say "keeping the running tunnel (pid $(tunnel_pid))"
  fi
fi

if [ -z "$url" ]; then
  if pid="$(tunnel_pid)" && [ -n "$pid" ]; then
    say "replacing the stale tunnel (pid $pid)"
    kill "$pid" 2>/dev/null || true
    # Let it exit first: a dying cloudflared still writing to the log would corrupt it.
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  fi
  rm -f "$PID_FILE" "$URL_FILE"
  say "starting cloudflared over $TUNNEL_PROTOCOL (log: $LOG_FILE)"
  nohup cloudflared tunnel --no-autoupdate --protocol "$TUNNEL_PROTOCOL" --url "$LOCAL_URL" \
    >"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"

  for _ in $(seq 1 60); do
    url="$(grep -aEo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | grep -v '^https://api\.' | head -n1 || true)"
    [ -n "$url" ] && grep -aq 'Registered tunnel connection' "$LOG_FILE" && break
    [ -n "$(tunnel_pid)" ] || { tail -n 20 "$LOG_FILE" >&2; die "cloudflared exited"; }
    sleep 1
  done
  [ -n "$url" ] || { tail -n 20 "$LOG_FILE" >&2; die "no trycloudflare URL after 60 s"; }

  # cloudflared prints the URL before its DNS record exists. Asking the system resolver
  # too early caches NXDOMAIN (macOS keeps it for minutes, and the browser uses the
  # same cache), so first wait until a public resolver sees the name.
  host="${url#https://}"
  if command -v dig >/dev/null; then
    for _ in $(seq 1 30); do
      [ -n "$(dig +short +time=2 +tries=1 @1.1.1.1 "$host" A 2>/dev/null | head -n1)" ] && break
      sleep 2
    done
  else
    sleep 20
  fi

  ok=""
  for _ in $(seq 1 45); do
    if [ "$(signer_at "$url")" = "$expected" ]; then ok=1; break; fi
    sleep 2
  done
  [ -n "$ok" ] || die "$url does not serve the witness yet (see $LOG_FILE)"
  echo "$url" >"$URL_FILE"
fi

# ---- 3. .env.local ---------------------------------------------------------------
# Rewrite only the WITNESS_PUBLIC_URL line (appended when missing); keep the mode.
tmp="$(mktemp "$ENV_FILE.XXXXXX")"
awk -v url="$url" '
  /^[[:space:]]*WITNESS_PUBLIC_URL[[:space:]]*=/ { if (!done) print "WITNESS_PUBLIC_URL=" url; done = 1; next }
  { print }
  END { if (!done) print "WITNESS_PUBLIC_URL=" url }
' "$ENV_FILE" >"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$ENV_FILE"

say "tunnel pid $(tunnel_pid), WITNESS_PUBLIC_URL written to .env.local"
echo "$url"
