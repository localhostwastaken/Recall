# Recall extension

Recall's Chrome extension: a trimmed fork of TLSNotary's
[tlsn-extension](https://github.com/tlsnotary/tlsn-extension) at tag
`0.1.0.1501`. Provenance, licence and the list of changes: [NOTICE](NOTICE).

The fork keeps its own npm tooling (`package-lock.json`); it is not part of the
repo's pnpm workspace. It imports `@recall/evidence` and `@recall/net` from
`../packages/*/src` through webpack aliases, so run `pnpm install` at the repo
root first.

## Build

```sh
cd extension
npm install
npm run build                      # release build: the prover trusts the Mozilla roots
RECALL_DEV_CA_DER_B64=$(base64 -i ../fixtures/notice/.certs/ca.der) npm run build   # dev build
```

Output: `packages/extension/build/` (load it unpacked in `chrome://extensions`).

- `RECALL_DEV_CA_DER_B64`: base64 of one DER certificate. The prover then trusts
  ONLY that CA (pair it with a witness started with `WITNESS_DEV_CA_DER`), and
  the build is a dev build: settings default to the local devnet and the service
  worker exposes `self.recall` for tests.
- `RECALL_DEV=1`: a dev build without a custom CA.

## Settings

`chrome.storage.local["recall.settings"]`:
`{ witnessUrl?, pinnedWitnesses, appUrl, net: 'local' | 'live' }`
(`src/recall/settings.ts`). Defaults come from `@recall/net` config.

## Tests

```sh
npm test                                         # unit tests (vitest) in this fork
cd .. && pnpm test:e2e --grep "@p1 extension"    # Playwright against the built extension
```
