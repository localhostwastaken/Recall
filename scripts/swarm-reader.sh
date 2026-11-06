#!/usr/bin/env bash
# Starts a Swarm mainnet node of your own in ultra-light mode, to open the Recall app straight
# from Swarm when no public gateway will show it:
#   - download.gateway.ethswarm.org sends every /bzz/ file with "Content-Disposition: attachment",
#     so a browser saves index.html instead of showing the app;
#   - bzz.link and api.gateway.ethswarm.org redirect a site to bzz.link/forbidden until its hash
#     is allowlisted.
#
# Ultra-light: no wallet, no blockchain endpoint, no funds, no postage. It only downloads. Its
# key is a throwaway made inside the container (the password below protects nothing of value).
# The API is published on 127.0.0.1 only.
#
#   bash scripts/swarm-reader.sh          # start (or keep) it, wait for peers, print the app URL
#   bash scripts/swarm-reader.sh stop     # remove it
#
# BEE_IMAGE picks the image (default: the official ethersphere/bee:2.8.1). SWARM_READER_PORT
# picks the port (default 1733).
set -euo pipefail

CONTAINER="recall-swarm-reader"
IMAGE="${BEE_IMAGE:-ethersphere/bee:2.8.1}"
PORT="${SWARM_READER_PORT:-1733}"
API="http://127.0.0.1:$PORT"
# The app's feed manifest: a stable address across republishes (docs/evidence-log.md).
APP_REF="e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0"

say() { echo "[swarm-reader] $*"; }
die() { echo "[swarm-reader] ERROR: $*" >&2; exit 1; }
command -v docker >/dev/null || die "docker is not installed"

if [ "${1:-}" = "stop" ]; then
  if docker rm -f "$CONTAINER" >/dev/null 2>&1; then say "removed $CONTAINER"; else say "no $CONTAINER container"; fi
  exit 0
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  say "starting $CONTAINER from $IMAGE on $API (ultra-light, mainnet)"
  docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:$PORT:1633" \
    "$IMAGE" start \
    --mainnet=true \
    --full-node=false \
    --swap-enable=false \
    --blockchain-rpc-endpoint= \
    --password=recall-ultralight-reader \
    --data-dir=/tmp/bee-data \
    --api-addr=:1633 >/dev/null
else
  say "keeping the running $CONTAINER"
fi

peers=0
for _ in $(seq 1 60); do
  # The first "connected" in /topology is the node's total.
  peers="$(curl -fsS --max-time 5 "$API/topology" 2>/dev/null | grep -o '"connected":[0-9]*' | head -n1 | cut -d: -f2 || true)"
  [ "${peers:-0}" -ge 3 ] && break
  sleep 2
done
[ "${peers:-0}" -ge 1 ] || die "no Swarm peers after 2 minutes (docker logs $CONTAINER)"
say "connected to $peers peers"

# The first read resolves the feed and fetches the site; later reads are fast.
code="$(curl -sS --max-time 120 -o /dev/null -w '%{http_code}' "$API/bzz/$APP_REF/" || true)"
[ "$code" = "200" ] || die "the app did not load from Swarm (HTTP ${code:-none}); try again in a minute"
say "the Recall app, straight from Swarm: $API/bzz/$APP_REF/"
