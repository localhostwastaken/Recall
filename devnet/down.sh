#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f devnet/docker-compose.yml down
npx -y @snaha/bee-compose@0.3.0 stop
