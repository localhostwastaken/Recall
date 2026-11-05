#!/usr/bin/env bash
# One command for the whole local devnet: Arkiv dev node (:8545), Anvil fork of
# Gnosis (:9545, chain 100), Bee node A (:1633), Bee node B (:1643), the notice
# fixture (:443) and the witness (:7047; the first build takes several minutes).
set -euo pipefail
cd "$(dirname "$0")/.."
# Three full nodes: Bee's health check ("salud") never marks a peer healthy in a
# two-node cluster, so pushsync and retrieval between the two nodes stall.
# 2.8.1 was also tried on two nodes; 2.8.0 is bee-compose's tested default.
BEE_VERSION=2.8.0
npx -y @snaha/bee-compose@0.3.0 start --full 3 --bee-version "$BEE_VERSION"
[ -f fixtures/notice/.certs/server.pem ] || bash fixtures/notice/gen-certs.sh
docker compose -f devnet/docker-compose.yml up -d --build --wait
echo "waiting for the Bee nodes to see each other as healthy peers (up to 8 minutes)"
for port in 1633 16331 16332; do
  for _ in $(seq 1 96); do
    curl -fsS "http://localhost:$port/topology" 2>/dev/null | grep -q '"healthy":true' && break
    sleep 5
  done
  curl -fsS "http://localhost:$port/topology" | grep -q '"healthy":true' || { echo "node on :$port has no healthy peer" >&2; exit 1; }
done
echo "devnet ready"
