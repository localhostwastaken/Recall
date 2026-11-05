# Recall MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Recall: a forked TLSNotary extension captures a public HTTPS page, one signing witness server attests to it, the evidence file goes to Swarm, the record goes to Arkiv via MetaMask, and a static web app lets anyone browse and verify captures, including offline.

**Architecture:** A pnpm TypeScript workspace holds two shared packages:
- `@recall/evidence`: statement, transcript parsing, checks.
- `@recall/net`: Arkiv, Swarm and Gnosis postage clients.

They are used by:
- a Vite React web app;
- a vendored fork of `tlsn-extension@0.1.0.1501` (keeps its own npm build);
- a vendored fork of its Rust `servers/verifier` (the "witness") with an EIP-712 signing patch.

Every test runs against real local services: Arkiv dev node, Bee + Gnosis-fork Anvil, a TLS 1.2 notice fixture, and the witness. Each phase ends with a live check against Rabdi, Swarm mainnet, Gnosis, GitHub Pages and the tunnelled witness.

**Tech Stack:**
- Node 22.13 + pnpm 10, TypeScript, viem 2.
- `@arkiv-network/sdk@1.0.1`, `@ethersphere/bee-js@13.2.0`.
- React + Vite.
- Vitest, Playwright (Chromium, MV3 extension).
- Rust stable: `tlsn` v0.1.0-alpha.15, alloy, sha2.
- Docker Compose, `@snaha/bee-compose@0.3.0`, `cloudflared`.

**Spec:** `docs/superpowers/specs/2026-11-06-recall-design.md` (decisions D1–D25, architecture §3, phases §4)

## Global Constraints

**Deadline and versions**
- Deadline: **Sat 7 Nov 2026 09:00 IST**. Phases run in order P0→P6. Gate rule D5: if a live check is blocked on the user, start the next phase locally; the blocked phase stays "not done".
- TLSNotary versions are pinned: extension fork from tag `0.1.0.1501`; witness from the same tag's `servers/verifier`; `tlsn`/`tlsn-wasm` `v0.1.0-alpha.15` (the verifier rejects mismatched versions).

**Capture**
- MPC mode only; proxy mode is rejected.
- `GET` with `Accept-Encoding: identity`, no Cookie/Authorization.
- Full reveal of both directions (`part:'ALL'`).
- `maxSentData = 4096`, `maxRecvData = 65536` (64 KB cap).

**Witness statement (EIP-712)**
- Domain: `{name:"Recall Witness",version:"1"}` (no chainId).
- Type: `Capture{string serverName; uint64 connTime; uint64 signedAt; bytes32 sentSha256; bytes32 recvSha256; uint32 sentLen; uint32 recvLen; uint8 tlsVersion; bytes32 nonce}`.

**Arkiv**
- `@arkiv-network/sdk@1.0.1`.
- Live: Rabdi, chain `7794095`, RPC `https://rpc.rabdi.db-chain.testnet.arkiv.network`, access key from `ARKIV_ACCESS_KEY`.
- Local: `ghcr.io/arkiv-network/arkiv-reth-dev:v1.0.1`, chain `1337`, `http://localhost:8545`.
- Every entity is created with `flags:{permissionlessExtension:true}` and a default expiry of 30 days.
- `str` ≤128 bytes, `bytes` ≤128 KiB.
- Schema names: `recall.v1.capture`, `recall.v1.confirmation`, `recall.v1.witness`.

**Swarm and Gnosis**
- One **immutable depth-17** batch per capture.
- PostageStamp `0x45a1502382541Cd610CC9068e88727426b696293`; xBZZ `0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da` (16 decimals). Gnosis chain `100`.
- Live upload: `https://api.gateway.ethswarm.org` (`POST /chunks` + `swarm-postage-stamp`). Live downloads: `https://download.gateway.ethswarm.org`, `https://bzz.link`.
- Local: Bee API `http://localhost:1633` (second node `http://localhost:1643`), Anvil Gnosis fork `http://localhost:9545`.

**Secrets**
- Only in `.env.local` (gitignored): `TREASURY_PRIVATE_KEY`, `WITNESS_PRIVATE_KEY`, `ARKIV_ACCESS_KEY`, `WITNESS_PUBLIC_URL`.
- Never printed or logged; scripts print addresses only.

**Tests**
- No mocked network layers. MetaMask is the only simulated actor: a mock EIP-1193 wallet backed by a real key on a real local or live chain.
- Each phase tags its Playwright specs `@p0`…`@p5`; live specs are tagged `@live`.

**Web app**
- No COEP header.
- No analytics, trackers or third-party fonts.
- HTML previews in `<iframe sandbox="">`.
- Hash routing (`#/…`) so it works from Swarm gateways.

**Repo**
- MIT licence at the root. Vendored upstream code keeps its MIT/Apache notices in `extension/` and `witness/`.
- Commit only project work; never `.env*`, keys, or anything outside `recall/`.

## Review Focus

These are not covered by the spec's own tests but are most likely to bite users. Each has a test in the owning task.
1. **Chunked transfer encoding / no Content-Length** (common on real servers): the body must be de-chunked before `bodySha256`. Test in Task 9 (`/chunked` fixture route).
2. **Page larger than the 64 KB cap:** a clear "page too large (N KB > 64 KB)" error within seconds, not a hang. Test in Task 9 (`/big` route).
3. **Witness offline or stale tunnel URL:** the popup shows "witness offline" and never starts a capture. Test in Task 13.
4. **Gateway returns altered bytes or 404 for `evidenceRef`:** the detail page shows check A failed or "evidence unavailable", never verified. Test in Task 15.
5. **User rejects MetaMask or is on the wrong chain:** the approve page offers retry, keeps the record pending, and switches chain. Test in Task 13.

---

## File Structure

```
recall/
├── package.json · pnpm-workspace.yaml · tsconfig.base.json · vitest.workspace.ts
├── .gitignore · .env.example · LICENSE · README.md (Task 23)
├── packages/evidence/src/{statement,http,url,evidence,checks,index}.ts   # pure TS + viem
├── packages/evidence/test/{*.test.ts, vectors/statement-v1.json}
├── packages/net/src/{config,arkiv,swarm,postage,index}.ts                 # Arkiv/Swarm/Gnosis I/O
├── packages/net/test/*.test.ts                                            # run against devnet
├── fixtures/notice/{server.ts, gen-certs.sh, content/v1.html, v2.html, v1.pdf, v2.pdf, test/*.test.ts}
├── devnet/docker-compose.yml · devnet/README.md
├── witness/   (vendored tlsn-extension@0.1.0.1501 servers/verifier + patch)
│   └── src/{main.rs, verifier.rs, attest.rs, gates.rs} · Cargo.toml · Dockerfile · NOTICE
├── extension/ (vendored tlsn-extension@0.1.0.1501, app/* removed; npm workspaces)
│   └── packages/extension/src/recall/{capture.ts, stamp.ts, pool.ts, messages.ts, settings.ts}
│       packages/extension/src/entries/Popup/*   (new popup UI)
├── apps/web/src/{main.tsx, routes/*, wallet.ts, verify/*, components/*}
├── scripts/{gen-witness-key.ts, announce-witness.ts, tunnel.sh, fund.ts, publish-swarm.ts, package-extension.sh, check-docs.ts, arkiv-query.ts}
├── site/notice/{index.html, notice.pdf}                                   # GitHub Pages demo page
├── .github/workflows/pages.yml
├── e2e/playwright.config.ts · e2e/fixtures/{extension.ts, mockWallet.ts, devnet.ts, keys.ts}
├── e2e/specs/{p0..p5}-*.spec.ts · e2e/live/*.spec.ts
├── arkiv/{schema,friction,reach,why-arkiv,how-you-use-arkiv,swarm}.md     # Task 23
└── docs/{superpowers/specs, superpowers/plans, evidence-log.md}
```

---

## Phase P0: Foundations

### Task 1: Workspace + local Arkiv round-trip

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `.env.example`, `LICENSE`
- Create: `devnet/docker-compose.yml` (service `arkiv`), `packages/net/src/{config,arkiv,index}.ts`, `packages/net/package.json`
- Test: `packages/net/test/arkiv.test.ts`

**Interfaces:**
- Produces:
  - `type NetConfig = { arkiv:{ chain:'local'|'rabdi'; rpcUrl:string; accessKey?:string }; swarm:{ uploadUrl:string; downloadUrls:string[] }; gnosis:{ rpcUrl:string }; app:{ url:string }; witness:{ pinned: Address[] } }`
  - `LOCAL: NetConfig`; `liveConfig(env: Record<string,string>): NetConfig`
  - `CaptureSchema`, `ConfirmationSchema`, `WitnessSchema` (`defineSchema('recall.v1.capture'|…)`)
  - `type CaptureRow = { urlHash:Hex; bodySha256:Hex; serverName:string; witness:Address; signedAt:bigint; httpStatus:number; batchId:Hex; evidenceRef:Hex; canonicalUrl:string }`
  - `type ConfirmationRow = { captureKey:Hex; urlHash:Hex; bodySha256:Hex; witness:Address; signedAt:bigint; evidence:Uint8Array }`
  - `arkivPublic(cfg)`, `arkivWallet(cfg, transport, account)`
  - `writeCapture(w,row)`, `writeConfirmation(w,row)`, `writeWitnessProfile(w,{witness,url})` → `Promise<{entityKey:Hex; txHash:Hex}>`
  - `listByUrl(pub, urlHash) → Promise<Array<({kind:'capture'} & CaptureRow | {kind:'confirmation'} & ConfirmationRow) & {entityKey:Hex; owner:Address; expiresAtBlock:bigint}>>`
  - `latestWitnessUrl(pub, witness) → Promise<string|null>`
  - `extendEntity(w, entityKey, days) → Promise<Hex>`

- [ ] **Step 1: Write the failing test.** `writeCapture then listByUrl returns the row with permissionless extension`. Create a row with fixed values (urlHash `keccak256('https://notice.recall.test/notice')`, serverName `notice.recall.test`, a 150-character `canonicalUrl`). Assertions:
  - `rows.length === 1` and `rows[0].canonicalUrl === row.canonicalUrl`.
  - `rows[0].kind === 'capture'`.
  - A second wallet (different key) can call `extendEntity` on that entity.
- [ ] **Step 2:** `pnpm devnet:up && pnpm --filter @recall/net test`. Expected: FAIL (`writeCapture` is not defined).
- [ ] **Step 3: Implement.**
  - Root scripts: `devnet:up` (`docker compose -f devnet/docker-compose.yml up -d --wait`), `devnet:down`, `test` (`vitest run`), `test:e2e` (`playwright test -c e2e --project=local`), `test:live` (`playwright test -c e2e --project=live`).
  - Use the SDK's `localhost` chain for local and `rabdi({accessKey})` for live. Store `canonicalUrl` as `bytes()` (it can exceed 128 B).
  - The prefunded dev key comes from the arkiv-reth-dev image docs/SDK tests; record it in `e2e/fixtures/keys.ts`.
  - `.gitignore`: `node_modules`, `.env*` except `.env.example`, `dist`, `fixtures/notice/.certs`, `test-results`, `target`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(net): workspace scaffold and local Arkiv capture round-trip`.

### Task 2: Local Swarm + postage (stamped upload, download from a second node)

**Files:**
- Modify: `devnet/docker-compose.yml`, or a `devnet:up` step that runs `npx @snaha/bee-compose@0.3.0` with 2 nodes (Bee ≥2.8.1; Anvil Gnosis fork on :9545, chain 100, contracts at mainnet addresses).
- Create: `packages/net/src/{swarm,postage}.ts`
- Test: `packages/net/test/swarm.test.ts`

**Interfaces:**
- Produces:
  - `buyBatch(wallet: WalletClient, {owner:Address; depth:17; days:number}) → Promise<{batchId:Hex; txHash:Hex}>` (xBZZ `approve`, then `createBatch(owner, perChunk, 17, 16, nonce, true)`)
  - `topUp(wallet, batchId, days) → Promise<Hex>`
  - `batchTtlSeconds(pub, batchId) → Promise<bigint|null>`
  - `costFor(pub, depth, days) → Promise<bigint>`
  - `waitBatchUsable(beeUrl, batchId, timeoutMs) → Promise<void>`
  - `uploadStamped(bytes, {uploadUrl, stamper: Stamper}) → Promise<Hex>` (bee-js `ChunkSplitter` + `Stamper.stamp(address)` + `POST /chunks`; returns the root ref)
  - `downloadBytes(ref, urls:string[]) → Promise<{bytes:Uint8Array; from:string}>` (tries each URL's `/bytes/{ref}`)
  - `uploadFree(bytes, uploadUrl) → Promise<Hex>`

- [ ] **Step 1: Write the failing tests.**
  - `stamped upload on node A downloads byte-identical from node B`: buy a depth-17 batch with `owner` = a fresh stamp key and payer = the faucet key, then `waitBatchUsable`, upload 70 000 random bytes, download from `:1643`. Assert `equals(down.bytes, up)`.
  - `stamp signed by non-owner key is rejected`: expect `uploadStamped` to reject.
  - `topUp increases TTL`: `ttlAfter > ttlBefore`.
- [ ] **Step 2:** `pnpm devnet:up && pnpm --filter @recall/net test swarm`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above. Persist nothing here: the `Stamper` is passed in. `days` → `amount = lastPrice × 17280 × days`, read from the contract.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(net): client-side stamped Swarm upload and postage helpers`.

### Task 3: TLS 1.2 notice fixture

**Files:**
- Create: `fixtures/notice/{server.ts, gen-certs.sh, content/v1.html, content/v2.html, content/v1.pdf, content/v2.pdf}`
- Modify: `devnet/docker-compose.yml` (service `notice`: network alias `notice.recall.test`, host port 443)
- Test: `fixtures/notice/test/notice.test.ts`

**Interfaces:**
- Produces: HTTPS on `notice.recall.test:443`, TLS **1.2 only**, certificate signed by the test CA in `fixtures/notice/.certs/ca.der`.
- Routes:
  - `GET /notice`: HTML; v1 contains "Deadline: 15 December", v2 contains "Deadline: 12 December".
  - `GET /notice.pdf`: PDF.
  - `GET /chunked`: chunked HTML.
  - `GET /big`: 100 KB HTML.
  - `GET /script`: HTML whose `<script>` sets `window.__ran=1`.
  - `POST /__admin/version` `{v:1|2}`.

- [ ] **Step 1: Write the failing tests.**
  - `negotiates TLSv1.2 with the test CA`: `socket.getProtocol() === 'TLSv1.2'`.
  - `rejects a TLS1.3-only client`.
  - `version switch changes the notice`: v1 body includes `15 December`; after POST `{v:2}` the body includes `12 December`.
  - `/chunked uses Transfer-Encoding: chunked`.
- [ ] **Step 2:** Run `pnpm --filter notice test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `gen-certs.sh` uses openssl to create the CA and a server cert with SAN `notice.recall.test` into `.certs/`, and also exports `ca.der`.
  - `server.ts` uses Node `https.createServer({minVersion:'TLSv1.2', maxVersion:'TLSv1.2'})`.
  - Content files are fictional ("Mumbai Institute of Studies — Admissions Notice").
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(fixtures): TLS1.2 notice fixture with versioned content`.

### Task 4: Demo notice on GitHub Pages + P0 live check

**Files:**
- Create: `site/notice/index.html`, `site/notice/notice.pdf`, `.github/workflows/pages.yml`, `e2e/playwright.config.ts`, `e2e/live/p0-live.spec.ts`, `docs/evidence-log.md`

**Interfaces:**
- Produces:
  - The Pages URL `https://localhostwastaken.github.io/recall/notice/`.
  - Playwright projects `local` (grep `@p\d`) and `live` (grep `@live`; loads `.env.local`).

- [ ] **Step 1: Write the failing live spec** `@live p0`:
  - `Rabdi write/read`: `writeCapture` with the treasury key, then `listByUrl` finds it.
  - `free upload then download from two gateways`: `uploadFree` to `api.gateway`, then `downloadBytes` from `download.gateway` and `bzz.link`, byte-equal.
  - `gateway accepts /chunks route`: POST with an invalid stamp returns 4xx with a stamp error, not 405.
  - `Pages notice negotiates TLS 1.2`: `tls.connect` with `maxVersion:'TLSv1.2'` succeeds, and the body includes `15 December`.
- [ ] **Step 2:** `pnpm test:live --grep p0`. Expected: FAIL (no site; `.env.local` missing values).
- [ ] **Step 3: Implement.**
  - The workflow uploads `site/` as the Pages artifact on push to `main`. The user enables Pages, with source "GitHub Actions".
  - Append results (entity key, refs, timestamps) to `docs/evidence-log.md`.
- [ ] **Step 4:** The user fills `.env.local` (treasury key, access key). Run `pnpm test:live --grep p0`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(site): demo notice page and P0 live checks`. **P0 gate:** `pnpm test && pnpm test:e2e --grep @p0 && pnpm test:live --grep p0` all green.

---

## Phase P1: Witness + capture core

### Task 5: EIP-712 statement + cross-language test vector

**Files:**
- Create: `packages/evidence/src/statement.ts`, `packages/evidence/test/statement.test.ts`, `packages/evidence/test/vectors/statement-v1.json`, `scripts/gen-witness-key.ts`

**Interfaces:**
- Produces:
  - `WITNESS_DOMAIN`, `CAPTURE_TYPES` (exactly the spec type).
  - `type Statement = { serverName:string; connTime:bigint; signedAt:bigint; sentSha256:Hex; recvSha256:Hex; sentLen:number; recvLen:number; tlsVersion:number; nonce:Hex }`
  - `hashStatement(s): Hex`
  - `recoverWitness(s, sig): Promise<Address>`
  - `statementToJson` / `statementFromJson` (bigints as decimal strings)
- `gen-witness-key.ts` writes `WITNESS_PRIVATE_KEY` into `.env.local` and prints only the address.

- [ ] **Step 1: Write the failing test.**
  - `vector digest and signature are reproduced`: with the vector's key (a well-known test key), `hashStatement(v.statement) === v.digest`, and `signTypedData` gives `v.signature`.
  - `any field change changes the recovered signer`: mutate `recvSha256`; the recovered address is not `v.signer`.
- [ ] **Step 2:** `pnpm --filter @recall/evidence test statement`. Expected: FAIL.
- [ ] **Step 3: Implement** with viem `hashTypedData` / `recoverTypedDataAddress`. Generate the vector once with a small inline script and commit the JSON.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(evidence): EIP-712 witness statement and test vector`.

### Task 6: Witness server fork + signing patch

**Files:**
- Create: `witness/` (copy of `tlsn-extension@0.1.0.1501/servers/verifier` + `NOTICE` with upstream licence text), `witness/src/attest.rs`, `witness/src/gates.rs`, `witness/Dockerfile`
- Modify: `witness/src/verifier.rs`, `witness/src/main.rs`, `witness/Cargo.toml`, `devnet/docker-compose.yml` (service `witness`)
- Test: `witness/tests/vector.rs`, `witness/src/gates.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: `packages/evidence/test/vectors/statement-v1.json`.
- Produces:
  - env `WITNESS_PRIVATE_KEY`, optional `WITNESS_DEV_CA_DER` (path; dev only), `PORT` (default 7047), `MAX_RECV_DATA` (65536), `MAX_SENT_DATA` (4096).
  - `GET /info` includes `"signer":"0x…"`.
  - `session_completed` gains `attestation:{message:<statement JSON, bigints as strings>, signature:"0x…", signer:"0x…"}` **and** an extra `results` entry `{"type":"RECALL_ATTESTATION","value":"<same JSON>"}`.
  - Rejections send `{"type":"error","message":…}`:
    - `recall: proxy mode not allowed`
    - `recall: server identity required`
    - `recall: commitments not allowed`
    - `recall: partial reveal not allowed`
    - `recall: host mismatch`
    - `recall: cookies/auth not allowed`
    - `recall: proxy port must be 443`
  - `attest.rs`: `pub fn eip712_digest(s:&CaptureStatement)->[u8;32]`, `pub fn sign(s:&CaptureStatement, key:&PrivateKeySigner)->Signature`.
  - `gates.rs`: `pub fn check_request(sent:&[u8], server_name:&str)->Result<(),String>` (Host header equals `server_name`; no `cookie` or `authorization` header, case-insensitive) and `pub fn check_proxy_target(token:&str)->Result<(String,u16),String>` (port defaults to 443; any other port returns `recall: proxy port must be 443`).

- [ ] **Step 1: Write the failing tests.**
  - `vector.rs`: `digest_matches_ts_vector` and `signature_matches_ts_vector`, both reading the JSON vector.
  - `gates.rs` unit cases:
    - `host_mismatch_rejected` (`Host: evil.example` vs `notice.recall.test`).
    - `cookie_rejected` (`Cookie: a=1`).
    - `clean_request_ok`.
    - `proxy_port_non_443_rejected` (`notice.recall.test:8443`).
    - `proxy_default_port_is_443` (`notice.recall.test` → `("notice.recall.test",443)`).
- [ ] **Step 2:** `cd witness && cargo test`. Expected: FAIL.
- [ ] **Step 3: Implement** per spec §3.3:
  - Before `accept()`: require `server_identity()`; require `transcript_commit().is_none()`; reject proxy mode.
  - After verification: require `sent_unauthed()` and `received_unauthed()` to be empty; `check_request`; `sha2` over `sent_unsafe()` and `received_unsafe()`.
  - `connTime` / `tlsVersion` from `tls_transcript()`; `signedAt` = the witness clock; `nonce` from `sessionData.nonce`.
  - Replace the UTF-8 conversion with a lossy one.
  - The `/proxy` handler rejects ports other than 443.
  - `WITNESS_DEV_CA_DER` replaces `RootCertStore::mozilla()` when set.
- [ ] **Step 4:** `cargo test && docker compose -f devnet/docker-compose.yml build witness`. Expected: PASS, image builds.
- [ ] **Step 5: Commit** `feat(witness): signing patch with Recall gates on tlsn verifier`.

### Task 7: Extension fork + Playwright extension fixture

**Files:**
- Create: `extension/` (copy of `tlsn-extension@0.1.0.1501` minus `app/*`, mobile workspaces and `.git`; keep the upstream licence notice in `extension/NOTICE`)
- Create: `extension/packages/extension/src/recall/settings.ts`, `extension/packages/extension/src/entries/Popup/{index.tsx,Popup.tsx}`
- Modify: `extension/packages/extension/src/manifest.json` (`action.default_popup`; `externally_connectable` matches `http://localhost:5173/*`, `https://localhostwastaken.github.io/*`, `https://*.bzz.link/*`, `http://localhost:1633/*`), webpack config (popup entry; alias `@recall/evidence` and `@recall/net` → `../../../packages/*/src`), `offscreen/ProveManager/index.ts` (keep `attestation`; `root_certs` from build-time `RECALL_DEV_CA_DER_B64` when set)
- Create: `e2e/fixtures/extension.ts`, `e2e/specs/p1-extension.spec.ts`

**Interfaces:**
- Produces:
  - `launchWithExtension({dev:boolean}) → {context, extensionId, serviceWorker}`. Chromium flags: `--disable-extensions-except`, `--load-extension`, `--host-resolver-rules=MAP notice.recall.test 127.0.0.1`, `--ignore-certificate-errors`.
  - The popup reads `chrome.tabs` for the active URL.
  - `Settings = { witnessUrl?:string; pinnedWitnesses:Address[]; appUrl:string; net:'local'|'live' }` in `chrome.storage.local`.

- [ ] **Step 1: Write the failing test** `@p1 extension loads and popup shows active tab URL`: open `https://notice.recall.test/notice`, open `chrome-extension://<id>/popup.html?tab=<tabId>`, and expect the text `notice.recall.test/notice`.
- [ ] **Step 2:** `cd extension && npm install && RECALL_DEV_CA_DER_B64=$(base64 -i ../fixtures/notice/.certs/ca.der) npm run build && cd .. && pnpm test:e2e --grep "@p1 extension loads"`. Expected: FAIL.
- [ ] **Step 3: Implement** the trim, the popup entry, the settings and the `ProveManager` changes above. Build output: `extension/packages/extension/build/`.
- [ ] **Step 4:** Rebuild and run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): fork tlsn-extension with Recall popup and dev CA flag`.

> **Fallback D25:** if the fork won't build or load after ~2 h, stop and tell the user, then switch Tasks 9/11/13 to the store extension. In that path, capture runs from the web app via `window.tlsn.execCode`, and the statement is read from the `RECALL_ATTESTATION` entry in `results`. The stamp key and upload then live in the web app (`localStorage`).

### Task 8: Evidence parsing + checks A–C

**Files:**
- Create: `packages/evidence/src/{http,url,evidence,checks,index}.ts`
- Test: `packages/evidence/test/parse.test.ts` (inputs are real byte captures recorded from the notice fixture over TLS in `beforeAll`, no hand-written HTTP)

**Interfaces:**
- Consumes: `Statement`, `recoverWitness` (Task 5).
- Produces:
  - `parseRequest(sent:Uint8Array):{method:string; target:string; host:string; headers:[string,string][]}`
  - `parseResponse(recv:Uint8Array):{status:number; headers:[string,string][]; body:Uint8Array; complete:boolean}` (Content-Length and chunked)
  - `canonicalUrl(raw:string):string` (`https:` only; lowercase host; drop `:443` and fragment; keep path and query verbatim)
  - `urlHash(c):Hex` (= `keccak256(toBytes(c))`)
  - `type EvidenceFile = { schema:'recall.evidence.v1'; statement:StatementJson; signature:Hex; signer:Address; transcript:{sent:string; recv:string}; meta:{capturedUrl:string; size:number} }` (transcript as base64)
  - `buildEvidence(...)`, `encodeEvidence(e):Uint8Array` (JSON starting with `{"schema"`), `decodeEvidence(b)`
  - `type CheckResult = {status:'pass'|'fail'|'warn'|'unavailable'; detail:string}`
  - `runChecks(e, {pinnedWitnesses, userFileBytes?}) → Promise<{A,B,C,D?:CheckResult; facts?:VerifiedFacts}>`
  - `type VerifiedFacts = {canonicalUrl; urlHash; serverName; httpStatus; bodySha256; body; contentType?; signedAt; witness}` (`facts` is present only if A and B pass and C ≠ fail)

- [ ] **Step 1: Write the failing tests.**
  - `parses real fixture request and chunked response`: `parseResponse(chunkedRecv).body` equals the de-chunked bytes, and `complete === true`.
  - `canonicalUrl normalises`: `HTTPS://Notice.Recall.Test:443/notice?a=1#x` → `https://notice.recall.test/notice?a=1`.
  - `truncated response is incomplete`: drop the last 10 bytes → `complete === false` → check B fails.
- [ ] **Step 2:** `pnpm --filter @recall/evidence test parse`. Expected: FAIL.
- [ ] **Step 3: Implement** the functions above.
  - Check A: sha256 and length of sent/recv vs the statement.
  - Check B: Host = serverName, no cookie/auth, the response is complete, the canonical URL comes from `serverName` + target.
  - Check C: the signer is in `pinnedWitnesses`; otherwise `warn` with "unknown witness". A bad signature is `fail`.
  - Check D: `sha256(userFileBytes) === bodySha256`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(evidence): transcript parsing, canonical URL and checks A–D`.

### Task 9: End-to-end capture through extension + witness

**Files:**
- Create: `extension/packages/extension/src/recall/capture.ts`, `e2e/specs/p1-capture.spec.ts`
- Modify: the popup ("Capture this page" button → progress → result/error)

**Interfaces:**
- Consumes: Tasks 6–8.
- Produces:
  - `captureUrl(url:string, {witnessUrl:string; maxRecvData?:number; overrides?:CaptureOverrides}) → Promise<{evidence:EvidenceFile}|{error:string}>`. It runs in the offscreen document via the existing `SessionManager`/`ProveManager` with handlers `[{type:'SENT',part:'ALL',action:'REVEAL'},{type:'RECV',part:'ALL',action:'REVEAL'}]`, mode `Mpc`, and `sessionData.nonce` = random 32 bytes.
  - `CaptureOverrides` (dev builds only): `{mode?:'Proxy'; extraHeaders?:Record<string,string>; recvRevealEnd?:number; commit?:boolean; hostHeader?:string}`.
  - The service worker exposes `recall.captureForTest(url, overrides)` to Playwright in dev builds.

- [ ] **Step 1: Write the failing tests** (`@p1 capture`; the witness runs in devnet with `WITNESS_DEV_CA_DER`):
  - `captures fixture notice and all checks pass`: A/B pass, C pass for the pinned test witness, and the facts' body includes `15 December`.
  - `pdf capture works`: `/notice.pdf`, B pass, `contentType` `application/pdf`.
  - `chunked page hashes de-chunked body` (Review Focus 1).
  - `page over 64 KB fails fast with size message`: `/big` → error matches `/too large/`, in under 10 s (Review Focus 2).
  - Each override rejected with the witness message:
    - `{mode:'Proxy'}` → `recall: proxy mode not allowed`
    - `{extraHeaders:{Cookie:'a=1'}}` → `recall: cookies/auth not allowed`
    - `{recvRevealEnd:100}` → `recall: partial reveal not allowed`
    - `{commit:true}` → `recall: commitments not allowed`
    - `{hostHeader:'evil.example'}` → `recall: host mismatch`
  - `tampered evidence fails A`: flip one recv byte in the base64 → A fail.
  - `unknown witness warns C`: run checks with `pinnedWitnesses=[randomAddress]` → C warn.
- [ ] **Step 2:** `pnpm devnet:up && pnpm test:e2e --grep "@p1 capture"`. Expected: FAIL.
- [ ] **Step 3: Implement** `captureUrl`, the popup flow, the size pre-check (HEAD or first-bytes check against `maxRecvData`) and the overrides plumbing.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): witness-signed capture flow`.

### Task 10: Tunnel + P1 live check

**Files:**
- Create: `scripts/tunnel.sh`, `e2e/live/p1-live.spec.ts`

**Interfaces:**
- `tunnel.sh`:
  1. Starts the witness container with `WITNESS_PRIVATE_KEY` from `.env.local` (no dev CA).
  2. Runs `cloudflared tunnel --url http://localhost:7047`.
  3. Parses the `https://*.trycloudflare.com` URL and writes `WITNESS_PUBLIC_URL` to `.env.local`.

- [ ] **Step 1: Write the failing live spec** `@live p1 captures Pages notice via tunnel`. Use the release extension build (Mozilla roots) and the witness URL `wss://…trycloudflare.com`. Assert:
  - A/B/C pass, with C pinned to the `WITNESS_PRIVATE_KEY` address.
  - Record the duration and the bytes transferred in `docs/evidence-log.md`.
- [ ] **Step 2:** Run without the tunnel. Expected: FAIL (witness unreachable).
- [ ] **Step 3: Implement** `tunnel.sh` (`brew install cloudflared` if missing).
- [ ] **Step 4:** `scripts/tunnel.sh & pnpm test:live --grep p1`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(scripts): witness tunnel and P1 live check`. **P1 gate:** `pnpm test:e2e --grep @p1` plus the P1 live check.

---

## Phase P2: Storage + index + MetaMask

### Task 11: Extension stamp key, batch pool, upload, messaging API

**Files:**
- Create: `extension/packages/extension/src/recall/{stamp.ts,pool.ts,messages.ts}`, `e2e/specs/p2-extension-api.spec.ts`

**Interfaces:**
- Consumes: `uploadStamped` (Task 2), `captureUrl` (Task 9).
- Produces (`chrome.runtime.onMessageExternal`, all JSON-safe):
  - `{type:'recall.getStampAddress'}` → `{address}`
  - `{type:'recall.addBatches', batchIds:Hex[]}` → `{pool:{batchId:Hex; used:boolean}[]}`
  - `{type:'recall.getPending', captureId}` → `PendingRecord = {captureId; kind:'capture'|'confirmation'; evidence:EvidenceFile; evidenceRef?:Hex; batchId?:Hex; captureKey?:Hex}`
  - `{type:'recall.markPublished', captureId, entityKey}` → `{ok:true}`
- The stamp key is generated on install (`chrome.storage.local`). One `Stamper` per batch, persisted with `getState()`. Uploads run in offscreen.

- [ ] **Step 1: Write the failing tests** (a test page on `http://localhost:5173` sends messages to the extension ID):
  - `stamp address is stable across reloads`.
  - `addBatches then capture uploads using one batch`: buy 2 batches on the local fork with `owner` = the stamp address. After capture, the pool has 1 unused, `getPending` has `evidenceRef`, and `downloadBytes(ref,[':1643'])` equals `encodeEvidence(evidence)`.
  - `empty pool shows buy-storage prompt`: popup text `No storage left`.
- [ ] **Step 2:** `pnpm test:e2e --grep "@p2 extension api"`. Expected: FAIL.
- [ ] **Step 3: Implement** the stamp key, pool, upload-after-capture and the four handlers. Opening the approve tab is Task 13.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(extension): stamp key, batch pool, upload and app messaging`.

### Task 12: Web app scaffold, wallet, mock wallet, Buy Storage page

**Files:**
- Create: `apps/web/` (Vite React TS, hash router), `apps/web/src/{wallet.ts, ext.ts, routes/Storage.tsx}`, `e2e/fixtures/mockWallet.ts`, `e2e/specs/p2-storage.spec.ts`

**Interfaces:**
- Produces:
  - `connectWallet() → {address, walletClient}` (viem `custom(window.ethereum)`)
  - `ensureChain(id: 1337|7794095|100)` (`wallet_addEthereumChain` then switch; the chain table comes from `NetConfig`. Locally, Arkiv = 1337 at :8545 and Gnosis fork = 100 at :9545. Live: 7794095 Rabdi, 100 Gnosis)
  - `ext.send<T>(msg) → Promise<T>` (`chrome.runtime.sendMessage(extensionId,…)`; the extension ID comes from settings)
  - `installMockWallet(page, {privateKey, rpcByChainId: Record<number,string>})`: an `addInitScript` defines `window.ethereum` and announces it via EIP-6963. `exposeFunction` forwards `eth_requestAccounts`, `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `eth_sendTransaction`, `personal_sign` and `eth_signTypedData_v4` to a viem local account; other read calls are proxied to the RPC.
  - The mock rejects the next request with code 4001 when `window.__rejectNext = true` (Review Focus 5).
- Storage page: input N (default 4) → shows `costFor` → for each, `buyBatch(owner=stamp address)` → `ext.send(addBatches)`.

- [ ] **Step 1: Write the failing test** `@p2 storage buys batches for the extension stamp key`: mock wallet = the faucet key on the local Gnosis fork; buy 2. Assert:
  - The pool has 2 unused.
  - `batchTtlSeconds > 0` for both.
- [ ] **Step 2:** `pnpm --filter web dev & pnpm test:e2e --grep "@p2 storage"`. Expected: FAIL.
- [ ] **Step 3: Implement** the scaffold, `wallet.ts`, `ext.ts`, the Storage page and the mock wallet.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): app scaffold, wallet, mock wallet and storage purchase`.

### Task 13: Approve tab, same-page logic, witness discovery

**Files:**
- Create: `apps/web/src/routes/Approve.tsx`, `scripts/announce-witness.ts`, `e2e/specs/p2-approve.spec.ts`
- Modify: `extension/.../recall/capture.ts` (dedupe + open approve tab), popup (existing captures count, witness online/offline)

**Interfaces:**
- Consumes: `listByUrl`, `writeCapture`, `writeConfirmation`, `latestWitnessUrl`, `writeWitnessProfile` (Task 1); `runChecks` (Task 8); messaging (Task 11).
- Dedupe rule (security):
  - Before choosing the confirmation path, the extension **downloads and verifies** the existing capture's evidence (A–C pass, pinned witness).
  - Only a verified identical `bodySha256` produces `kind:'confirmation'` with the evidence inline (≤128 KiB). Otherwise the capture is uploaded.
- Approve page:
  - `#/approve/:captureId` → `getPending` → `runChecks` (must pass A–B, C≠fail) → `ensureChain(arkiv)` → `writeCapture`/`writeConfirmation` from verified facts → `markPublished` → link to `#/u/:urlHash`.
  - On MetaMask rejection it shows "Retry" and keeps the record pending.
- `announce-witness.ts`: `writeWitnessProfile({witness, url: WITNESS_PUBLIC_URL})` signed with `WITNESS_PRIVATE_KEY`. The extension resolves the witness URL with `latestWitnessUrl(pinned[0])`, falling back to `settings.witnessUrl`. A health check `GET {witness}/info` (2 s timeout) decides online/offline.

- [ ] **Step 1: Write the failing tests:**
  - `capture → approve → entity readable`: `listByUrl` returns a capture whose `evidenceRef` downloads and verifies.
  - `identical re-capture writes confirmation without upload`: pool unchanged; `kind:'confirmation'`.
  - `edited page (fixture v2) writes a new capture version`: 2 captures, different `bodySha256`.
  - `junk entity with matching bodySha256 does not suppress upload`: write a fake capture claiming the same `bodySha256` with a random `evidenceRef`. The next capture still uploads.
  - `witness offline: popup shows witness offline and Capture disabled`: stop the witness container (Review Focus 3).
  - `witness discovered from Arkiv profile`: announce a URL; the popup uses it.
  - `MetaMask rejection keeps record pending and retry succeeds`: `window.__rejectNext=true` (Review Focus 5).
  - `wrong chain is switched`: the mock wallet starts on chain 100 and ends on the Arkiv chain.
- [ ] **Step 2:** `pnpm test:e2e --grep "@p2 approve"`. Expected: FAIL.
- [ ] **Step 3: Implement** the above.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat: approve tab, same-page confirmations and witness discovery`.

### Task 14: P2 live check

**Files:**
- Create: `e2e/live/p2-live.spec.ts`

- [ ] **Step 1: Write the failing live spec** `@live p2`:
  - The treasury-backed mock wallet buys 1 real depth-17 batch for 1 day on Gnosis (`owner` = the extension stamp address); wait until usable.
  - Capture the Pages notice via the tunnel witness, then upload via `api.gateway.ethswarm.org` `/chunks`.
  - Approve on Rabdi.
  - Download `evidenceRef` from `download.gateway.ethswarm.org` **and** `bzz.link`, verify A–C, and log the entity key, ref, batch ID and tx hashes.
- [ ] **Step 2:** Run. Expected: FAIL until the user has swept the gift xBZZ/xDAI into the treasury.
- [ ] **Step 3:** No new code beyond fixes found by the live run. **Manual:** the user approves one capture with real MetaMask (Rabdi added).
- [ ] **Step 4:** `pnpm test:live --grep p2`. Expected: PASS.
- [ ] **Step 5: Commit** `test(live): P2 real Swarm + Rabdi capture`. **P2 gate.**

---

## Phase P3: Browse/verify app

### Task 15: Capture detail + drop-to-verify + unverified filter

**Files:**
- Create: `apps/web/src/routes/{Home.tsx, Capture.tsx}`, `apps/web/src/verify/{useVerifiedCapture.ts, CheckPanel.tsx}`, `e2e/specs/p3-verify.spec.ts`

**Interfaces:**
- Consumes: `runChecks`, `downloadBytes`, `batchTtlSeconds`, `listByUrl`.
- Produces:
  - `useVerifiedCapture(entityKey) → {report, facts, storage:{ttlSeconds:bigint|null; arkivExpiresAtBlock:bigint}}`. Check E = `pass` if TTL > 0, otherwise `warn`. `downloadBytes` failure → A `unavailable` with "evidence unavailable".
  - Home: URL search → `#/u/:urlHash`; a drop zone for `.json` evidence (offline-capable) or a raw file plus URL (check D).
  - Everything displayed comes from `facts` only.

- [ ] **Step 1: Write the failing tests:**
  - `detail page shows A–E pass for real capture`.
  - `dropped tampered evidence shows A failed in red`.
  - `unknown witness shows C warning`.
  - `junk entity hidden behind show unverified (1)`.
  - `gateway serving altered bytes shows A failed` (Review Focus 4: the download URL points at a local proxy that flips one byte).
  - `missing ref shows evidence unavailable, never verified`.
- [ ] **Step 2:** `pnpm test:e2e --grep "@p3 verify"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): verified capture detail and drop-to-verify`.

### Task 16: Timeline, diff, previews, evidence download

**Files:**
- Create: `apps/web/src/routes/Timeline.tsx`, `apps/web/src/components/{Diff.tsx, Preview.tsx}`, `e2e/specs/p3-timeline.spec.ts`

**Interfaces:**
- Timeline: `#/u/:urlHash` lists verified captures and confirmations by `signedAt`. A confirmation shows "confirmed unchanged on <date>".
- Diff: extract text from HTML with `DOMParser`, then use the `diff` npm package (word diff).
- Preview: HTML uses `<iframe sandbox="" srcdoc>`; PDF uses a blob URL in a sandboxed iframe (fallback: a download link).
- Download: `recall-<urlHash8>-<signedAt>.json` = `encodeEvidence`.

- [ ] **Step 1: Write the failing tests:**
  - `timeline shows v1, confirmation and v2 in order`.
  - `diff shows 15 December removed and 12 December added`.
  - `preview iframe is sandboxed and scripts do not run` (`/script` capture → the iframe's `sandbox` attribute is `""` and `__ran` is undefined).
  - `downloaded evidence re-verifies when dropped`.
- [ ] **Step 2:** `pnpm test:e2e --grep "@p3 timeline"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): timeline, diff, sandboxed previews and evidence download`.

### Task 17: Settings (app + extension)

**Files:**
- Create: `apps/web/src/routes/Settings.tsx`, `apps/web/src/settings.ts`
- Modify: the extension popup (settings section), `e2e/specs/p3-settings.spec.ts`

**Interfaces:**
- App settings (`localStorage`): `{pinnedWitnesses:Address[]; arkivRpcUrl; arkivAccessKey; downloadUrls:string[]; uploadUrl; gnosisRpcUrl; extensionId}`, with defaults from `LOCAL`/`liveConfig`.
- Extension settings extend Task 7's `Settings`: `{pinnedWitnesses; witnessUrl?; appUrl; arkivRpcUrl; arkivAccessKey; uploadUrl; uploadMode:'stamped'|'free'}`. `free` is the D11 demo fallback: `uploadFree` via the gateway's own batch, with no batch taken from the pool and `batchId = 0x0…0`. Keep-alive is then unavailable for that capture.

- [ ] **Step 1: Write the failing tests:**
  - `changing pinned witness turns C into warning`.
  - `changing download gateway is used for downloads` (observe the request URL).
  - `free upload mode uploads without consuming a batch`: pool unchanged, and the evidence still downloads and verifies.
- [ ] **Step 2:** `pnpm test:e2e --grep "@p3 settings"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat: user-configurable witnesses and endpoints`.

### Task 18: Teammate funding + P3 live check

**Files:**
- Create: `scripts/fund.ts`, `e2e/live/p3-live.spec.ts`

**Interfaces:**
- `pnpm fund <address> [--tglm 0.05] [--xdai 0.05] [--xbzz 0.5]` sends from the treasury. It prints tx hashes only.

- [ ] **Step 1: Write the failing live spec** `@live p3`: opens the live web app config, visits `#/u/<pages notice urlHash>`, and expects the P2 capture to be verified A–E.
- [ ] **Step 2:** Run. Expected: FAIL until Tasks 15–17 are wired to the live config.
- [ ] **Step 3: Implement** `fund.ts`. **Manual:** each teammate loads the dev-free extension zip (from `scripts/package-extension.sh` in Task 21, or `extension/packages/extension/build` for now), connects MetaMask (funded via `pnpm fund`), captures the notice and verifies on their own machine.
- [ ] **Step 4:** `pnpm test:live --grep p3`. Expected: PASS. Log the teammate captures.
- [ ] **Step 5: Commit** `feat(scripts): teammate funding; P3 live check`. **P3 gate.**

---

## Phase P4: Keep-alive

### Task 19: Keep-alive + offline verification

**Files:**
- Create: `apps/web/src/components/KeepAlive.tsx`, `e2e/specs/p4-keepalive.spec.ts`

**Interfaces:**
- Consumes: `costFor`, `topUp` (Task 2), `extendEntity` (Task 1).
- KeepAlive: choose days (7/30) → show the xBZZ cost and an estimated Arkiv gas → approve + `topUp(batchId)` on Gnosis → `extendEntity(captureKey, days)` on Arkiv (capped at the ~182-day max). A confirmation tops up its parent capture's batch.

- [ ] **Step 1: Write the failing tests:**
  - `keep-alive increases batch TTL and Arkiv expiry` (read both before and after).
  - `a different wallet can keep alive` (permissionless).
  - `dropped evidence verifies offline`: `context.setOffline(true)`, drop the file → A/B/C pass, E `unavailable`.
- [ ] **Step 2:** `pnpm test:e2e --grep "@p4"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): keep-alive and offline verification`.

### Task 20: P4 live check

**Files:**
- Create: `e2e/live/p4-live.spec.ts`

- [ ] **Step 1: Write the failing live spec** `@live p4`: keep the P2 live capture alive by 1 day with the treasury-backed mock wallet; TTL and expiry increase on mainnet Gnosis and Rabdi.
- [ ] **Step 2:** Run. Expected: FAIL before Task 19 is wired to the live config.
- [ ] **Step 3:** Fix any live-only issues.
- [ ] **Step 4:** `pnpm test:live --grep p4`. Expected: PASS; log the tx hashes.
- [ ] **Step 5: Commit** `test(live): P4 keep-alive on mainnet Gnosis and Rabdi`. **P4 gate.**

---

## Phase P5: Hosting + CROPS moment

### Task 21: Publish app (Swarm + GitHub Pages) + extension zip

**Files:**
- Create: `scripts/publish-swarm.ts`, `scripts/package-extension.sh`, `e2e/live/p5-hosting.spec.ts`
- Modify: `.github/workflows/pages.yml` (build `apps/web` with the live config into `site/app/`)

**Interfaces:**
- `publish-swarm.ts` builds `apps/web` and uploads the `dist/` collection with the treasury's hosting batch: depth 18, 30 days, `index.html` as the index document. It prints the `bzz` ref and `https://<ref>.bzz.link/` (or the `/bzz/<ref>/` gateway path).
- `package-extension.sh` makes a release build (no dev CA) and writes `dist/recall-extension.zip`.

- [ ] **Step 1: Write the failing live spec** `@live p5`:
  - The Pages app (`https://localhostwastaken.github.io/recall/app/`) verifies the P2 capture.
  - The Swarm-hosted app verifies the same capture. If the gateway blocks HTML before moderation, use a local Bee node (`http://localhost:1633/bzz/<ref>/`) and record that in the evidence log.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** both scripts and the workflow change. The user asks the Swarm booth for gateway approval of the ref.
- [ ] **Step 4:** `pnpm test:live --grep p5`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: publish app to Swarm and Pages; extension release zip`.

### Task 22: CROPS rehearsal

**Files:**
- Create: `e2e/live/p5-crops.spec.ts`, `docs/demo-script.md`

- [ ] **Step 1: Write the failing live spec** `@live p5 crops`:
  - Stop the witness: the popup shows "witness offline" and Capture is disabled, while the app still verifies.
  - Open the Swarm-hosted (or local) app with the Pages mirror unreachable (route-blocked in Playwright): it still verifies.
  - Run a local app build fully offline: a dropped evidence file verifies.
- [ ] **Step 2:** Run. Expected: FAIL until the behaviour is right.
- [ ] **Step 3:** Fix gaps. Write `docs/demo-script.md`: a ≤3-minute run of order that matches these steps.
- [ ] **Step 4:** `pnpm test:live --grep crops`. Expected: PASS.
- [ ] **Step 5: Commit** `test(live): CROPS moment rehearsal and demo script`. **P5 gate.**

---

## Phase P6: Docs + submission

### Task 23: README, Arkiv docs, evidence log, submission check

**Files:**
- Create: `README.md`, `arkiv/{schema,friction,reach,why-arkiv,how-you-use-arkiv,swarm}.md`, `scripts/check-docs.ts`, `scripts/arkiv-query.ts`
- Modify: `docs/evidence-log.md`

**Interfaces:**
- `pnpm arkiv:query` prints the latest 5 verified captures from Rabdi. This is the README's "one runnable query".
- `check-docs.ts` asserts that these exist:
  - README sections `## CROPS` (with `C`, `O`, `P`, `S`), `## Run it`, `## Writer wallets`, `## Limitations`, `## AI use`;
  - all 6 `/arkiv/*.md`;
  - `swarm.md` containing an entity key, a Swarm ref, the batch ID, the batch owner and the Bee node.

- [ ] **Step 1: Write the failing check:** `pnpm check:docs` exits non-zero and lists missing items.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Write the docs** from `docs/evidence-log.md` (real values only), the limitations (single witness, alpha.15 unaudited, TLS 1.2 only, testnet, gateway moderation, the Arkiv access key ships in the client) and an honest AI-use statement.
- [ ] **Step 4:** `pnpm check:docs && pnpm arkiv:query`. Expected: PASS, and the query prints ≥1 capture.
- [ ] **Step 5: Commit** `docs: README with CROPS, Arkiv/Swarm docs and evidence log`. Record the video (≤3 min) using `docs/demo-script.md`, then submit.
