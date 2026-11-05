# Local devnet

`pnpm devnet:up` brings up everything with one command; `pnpm devnet:down` stops it.

| Service | URL | Notes |
| --- | --- | --- |
| Arkiv dev node | `http://localhost:8545` | chain 1337 |
| Anvil fork of Gnosis | `http://localhost:9545` | chain 100, Swarm contracts at their mainnet addresses |
| Bee node A (full, "queen") | `http://localhost:1633` | uploads |
| Bee node B (full) | `http://localhost:1643` | downloads (bee-compose worker-1); socat forwards to bee-compose's `:16331` |

Swarm and Anvil come from `@snaha/bee-compose@0.3.0` (Bee 2.8.0, three full nodes; the third only makes the health check work),
run by `devnet/up.sh`. The first run builds Bee images and takes several minutes; later runs are fast.

- Money: the public bee-compose faucet (`BEE_COMPOSE_FAUCET_KEY` in `e2e/fixtures/keys.ts`) holds about
  250 xBZZ. A one-day depth-17 batch costs about 0.0054 xBZZ on the fork (lastPrice 24000), so the faucet
  covers tens of thousands of runs. `docker volume rm bee-compose_blockchain` (after `devnet:down`) restores the snapshot.
- A new batch needs about 12 blocks (about 1 minute) before Bee accepts stamps for it.
- Bee nodes must be full nodes and there must be three of them: with a light peer or only two nodes, Bee never marks the peer healthy, so `POST /chunks` takes 30 s per chunk and node B cannot retrieve anything. `devnet:up` waits for this (up to about 5 minutes on a fresh start). Deferred chunk uploads also hang here, so `uploadStamped` pushes synchronously.
- Bee rejects unstamped uploads, so `uploadFree` is only exercised against the live gateway.
