# Recall: design + phased test-first build plan (v2, 2026-11-06)

## 1. Context and intent
Public notices and policies get quietly edited or removed. A **journalist or researcher** later needs to prove "this official page said X on date Y". Recall lets them:
- capture a public HTTPS page with **TLSNotary**, signed by an independent **witness**;
- store the evidence on **Swarm** and index it on **Arkiv**;
- have **anyone verify it** in a browser or offline. Verification needs no Recall-run service.

The MVP is for ETHGlobal Mumbai 2026 (From Scratch; deadline **Sat 7 Nov 09:00 IST**) and continues afterwards. `RECALL.md`/`README.md` were rough references only. Every decision below was made by the user in the 2026-11-05/06 interview, and every technical fact comes from fresh research.

**Non-goals (MVP):**
- Private or login pages.
- TLS 1.3-only sites.
- Video or large files.
- Automated monitoring.
- Legal-grade claims.
- ENS.
- TEE (comes after the MVP).

**Anti-goals:**
- A "verified" badge without a check the reader ran itself.
- Verification depending on any Recall-run service.
- Secrets or sponsor docs committed to the repo.
- Claiming a page is "gone everywhere".

## 2. Decisions (all made by the user)
| # | Topic | Decision |
|---|---|---|
| D1 | First user | Journalist/researcher proving a page's past content |
| D2 | Timeline | Hackathon MVP, then keep building |
| D3 | Team | One developer. 3 non-coding teammates capture and verify with their own MetaMask, and are at the venue |
| D4 | Decentralization | Nothing Recall runs is needed to **verify**. Captures need **one witness server** (open source, anyone can run another; readers pin which witness keys they trust). TEE comes after the MVP |
| D5 | Method | Test-first. All tests are end-to-end (Vitest for packages and scripts against local devnets, Playwright for browser + extension). Phase gate = local end-to-end tests green **and** the live check passes. If a live check is blocked on the user, start the next phase locally; the blocked phase stays "not done" until its live check passes |
| D6 | Prizes | EF Best CROPS App + Arkiv (with the Swarm bonus). ENS removed. The 3rd pick stays unused |
| D7 | Rules | Commit the design and plan docs plus an AI-use disclosure (spec-driven artifacts) |
| D8 | Capture client | **Our own Recall extension** (fork of tlsn-extension 0.1.0.1501, sideloaded, upstream MIT/Apache attribution kept). The popup has a "Capture this page" button and the prover runs in the offscreen document. **MPC mode only** |
| D9 | Witness | **One server:** TLSNotary's verifier (`servers/verifier`, alpha.15) plus our signing patch (§3.3). It runs in Docker on the user's Mac, exposed through a free Cloudflare quick tunnel. Its key lives in `.env.local` |
| D10 | Payments and keys | The capturer's **MetaMask** approves and pays for Arkiv writes (Rabdi) and for buying storage and keep-alive (Gnosis), in our web app. The extension holds a **stamp key** (`chrome.storage.local`) that owns the batches and signs Swarm chunk stamps. After uploading, the extension opens an **approve tab** on the web app, which hands over the record and does the MetaMask write |
| D11 | Swarm | **One immutable depth-17 batch per capture**, from a pre-bought pool. The web app buys the pool with MetaMask (`createBatch(owner = extension stamp address)`). Stamping happens in the browser (bee-js `Stamper`), with POST /chunks through a public gateway (configurable). The **JSON evidence file** never contains raw HTML. The gateway's free /bytes mode is a demo-day fallback switch |
| D12 | Same page captured again | The extension shows existing captures first. Identical body → a signed **confirmation** (no new Swarm upload) plus a keep-alive offer. Different body → a new version |
| D13 | Keep-alive | Anyone can top up a capture's batch (permissionless `topUp`) and extend its Arkiv entity (`permissionlessExtension:true`) from the web app with MetaMask |
| D14 | Trust list | Pinned witness address list in the extension and app settings (default: our witness) |
| D15 | MVP extras | URL timeline + text diff; evidence-file download (dropping it back into the app verifies it, even offline); keep-alive. **No CLI verifier** (the user removed it) |
| D16 | Tests | Local copy of every network for every change, plus a live check per phase |
| D17 | Demo page | Our own fictional "University notice: Deadline 15 Dec" on GitHub Pages (TLS 1.2), edited to "12 Dec" on camera. A real public page is a bonus |
| D18 | Web app hosting | Swarm (request gateway approval) + a GitHub Pages mirror + run-from-source |
| D19 | Licence | MIT. Forked code keeps its upstream MIT/Apache notices |
| D20 | Mac setup | Allowed: start Docker, `rustup update`, Playwright Chromium, devnet images |
| D21 | Repo | `/Users/madkeanuj/Code/Eth-2026/recall` (clone of github.com/localhostwastaken/recall, currently empty). Only real work is committed; notes and sponsor docs stay outside it; `.env*` is gitignored |
| D22 | Treasury | A fresh imported key (not the personal seed), stored in `.env.local`. The Swarm gift funds are swept into it. Used by scripts and automated live checks (a mock wallet backed by the treasury key). Real MetaMask gets a manual smoke test each phase |
| D23 | File types | HTML + small PDFs up to the size cap. PDFs get a safe preview; the text diff covers HTML/text |
| D24 | Witness uptime | The Mac stays on for judging. Otherwise the extension shows "witness offline", and verification still works |
| D25 | Fallback | If the forked extension is blocked, use the store extension + web-app capture via `window.tlsn.execCode`. The patched witness also puts its signature inside `results`, which the store build forwards |

## 3. Architecture
### 3.1 Actors
- **Recall extension:** captures, uploads to Swarm, opens the approve tab.
- **Witness server:** verifies and signs.
- **Swarm:** holds the evidence file.
- **Arkiv:** the searchable index.
- **Recall web app:** browse, verify (including a dropped evidence file, offline), approve (MetaMask write), buy storage, keep-alive, settings.
- **MetaMask:** the capturer's payments.

Shared package **`@recall/evidence`** (used by the extension and the app):
- EIP-712 types;
- HTTP transcript parsing (status, headers, Content-Length/chunked body);
- canonical URL / urlHash;
- evidence schema;
- the check functions A–E.

### 3.2 Capture flow
1. Popup reads the active tab URL and queries Arkiv by urlHash to show existing captures. The witness URL is discovered from an Arkiv `recall.v1.witness` profile entity written by the witness key (D14 pin), or set by hand.
2. The prover runs in the offscreen document: MPC against the witness's `/session` and `/verifier`, with the server reached through the witness's `/proxy` (port 443 only).
   - The request is GET with `Accept-Encoding: identity` and no cookies or auth.
   - Both directions are fully revealed (`part:'ALL'`).
3. The witness verifies and enforces its gates (§3.3), then returns `session_completed.attestation = {message, signature, signer}`. The forked `ProveManager` keeps this field.
4. The extension builds the evidence file `{schema:"recall.evidence.v1", statement, signature, signer, transcript:{sent,recv}, meta}`, then parses it to get bodySha256 and the canonical URL.
5. **Same page, same body:** prepare a confirmation (evidence inline in the Arkiv entity, under the 128 KiB limit at our size cap).
   **Otherwise:** take a batch from the pool, stamp and upload, and get `evidenceRef`.
6. The extension opens the approve tab on the web app, which receives the pending record from the extension via `externally_connectable` (builder's call). MetaMask adds or switches to Rabdi, then calls `createEntity` (`recall.v1.capture` or `recall.v1.confirmation`).

### 3.3 Witness signing patch (verified online)
Change `servers/verifier/src/{verifier.rs,main.rs}` (~150–250 lines of Rust; Cargo adds sha2 and alloy-sol-types/primitives/signer-local).

**Gates before `accept()`:**
- `server_identity()` must be true.
- `transcript_commit()` must be None. This also avoids the alpha.15 commitment-range crash.
- Reject proxy mode.

**Gates after verification:**
- No unauthenticated sent/received ranges (full reveal).
- Host header = `server_name`.
- No Cookie/Authorization headers.
- Lossy transcript→string conversion (upstream code fails on PDF/binary data).
- `/proxy` limited to port 443.

**Signed EIP-712 statement:**
- Domain: `{name:"Recall Witness",version:"1"}`.
- Type: `Capture{string serverName; uint64 connTime; uint64 signedAt; bytes32 sentSha256; bytes32 recvSha256; uint32 sentLen; uint32 recvLen; uint8 tlsVersion; bytes32 nonce}`.
- Returned as an `attestation` field **and** as an extra `results` entry (for the D25 fallback).
- Verified in the browser with viem `verifyTypedData` against the pinned witness address.

**Dev-only:** a fixture-CA env var replaces `RootCertStore::mozilla()` for local tests. The extension gets a matching dev build flag for `root_certs`.

### 3.4 Verify flow (web app)
Input: a dropped evidence file, or Arkiv query → `evidenceRef` → download from a gateway other than the upload node.

**Checks:**
- **A.** sha256 and length of sent/recv match the statement.
- **B.** The parsed request has Host = serverName and no cookies. The canonical URL matches. The response is complete. bodySha256 is computed.
- **C.** The EIP-712 signer is in the pinned witness list; otherwise it shows "unknown witness".
- **D.** Any user-supplied file's hash matches.
- **E.** Storage status: batch TTL (Gnosis RPC) and Arkiv expiry.

Display comes only from the verified evidence. Failures sit behind "show unverified (n)". Preview: `<iframe sandbox="">` for HTML, a sandboxed blob for PDF.

### 3.5 Arkiv entities (all `permissionlessExtension:true`, default 30-day expiry)
- **`recall.v1.capture`:**
  - Indexed: urlHash, bodySha256, serverName, witness (addr), signedAt (u64), httpStatus (i32), batchId.
  - Stored: evidenceRef (str), canonicalUrl (bytes).
- **`recall.v1.confirmation`:**
  - Indexed: captureKey (key), urlHash, bodySha256, witness, signedAt.
  - Stored: the evidence inline (bytes).
- **`recall.v1.witness`:**
  - Written by the witness key; indexed witness (addr).
  - Stored: current URL.

## 4. Phases (test-first; ≈27 h total)
**P0 Foundations [2.5 h]**
- **Build:**
  - Repo skeleton in `recall/`: pnpm workspace (`packages/evidence`, `apps/web`, `scripts/`), plus `extension/` (the fork, keeping its own npm tooling) and `witness/` (the verifier fork).
  - MIT licence, `.gitignore`, `.env.example`.
  - `devnet/` compose:
    - Arkiv: `arkiv-reth-dev:v1.0.1`.
    - Swarm: bee-compose (Gnosis-fork Anvil; contracts at mainnet addresses).
    - TLSNotary: `tlsn-server-fixture` serving our notice HTML/PDF.
  - The GitHub Pages notice page.
  - The witness key is generated by a script that writes it straight into `.env.local` and prints only the address.
- **E2E:**
  - Write and read an Arkiv entity.
  - Stamp, upload and download a chunk.
  - TLS 1.2 fetch of the fixture.
- **Live check:**
  - Rabdi write/read with the access key and treasury.
  - Download a Swarm ref from 2 gateways.
  - GitHub Pages notice is reachable over TLS 1.2.

**P1 Witness + capture core [7 h]**
- **Build:**
  - The signing patch.
  - The extension fork: trim the mobile workspaces, add a popup, keep `attestation`, add the dev CA flag.
  - `@recall/evidence` and the evidence builder.
- **E2E (Playwright + built extension):**
  - Capture the fixture notice → signed statement → all checks pass.
  - Rejections:
    - one body byte changed;
    - a different signer;
    - proxy mode;
    - a cookie header;
    - a partial reveal;
    - a commitment request;
    - a Host that doesn't match.
  - A PDF (non-UTF-8) captures.
- **Live check:** capture the GitHub Pages notice through the tunnel witness. Record time and bandwidth.

**P2 Storage + index + MetaMask [6 h]**
- **Build:**
  - Extension stamp key, `Stamper` upload in offscreen, pool tracking.
  - Web app "Buy storage" (approve + `createBatch(owner=stamp addr)`).
  - The approve tab: `externally_connectable` → MetaMask Arkiv write.
  - Same-page logic.
  - Witness profile entity.
- **E2E:** with a mock EIP-1193 wallet (viem local account via `addInitScript`):
  - Capture → upload → approve → entity → read back.
  - Identical re-capture → confirmation.
  - Edited page → new version.
  - A junk entity is hidden.
- **Live check:** one real capture on Swarm mainnet + Rabdi.
  - Automated with the treasury-backed mock wallet.
  - Plus a manual real-MetaMask approval.

**P3 Browse/verify app [5 h]**
- **Build:**
  - URL timeline + diff (15→12 Dec).
  - Capture detail with checks A–E.
  - Evidence download.
  - "Show unverified".
  - Sandboxed HTML/PDF preview.
  - Settings (witness pins, endpoints).
- **E2E:** Playwright journeys, including a tampered file showing red.
- **Live check:** the same journeys with a teammate's machine.

**P4 Keep-alive [2 h]**
- **Build:** keep-alive with a cost preview (approve + `topUp` on Gnosis, `extendEntity` on Rabdi).
- **E2E:**
  - TTL and expiry increase and are read back.
  - A dropped evidence file verifies in the app with the network blocked.
- **Live check:** top up and extend a real capture.

**P5 Hosting + CROPS moment [2.5 h]**
- **Build:**
  - Publish the web app to Swarm (hosting batch) and request approval.
  - GitHub Pages mirror.
  - Extension zip for sideloading.
- **E2E:** smoke journeys against the deployed URLs.
- **Rehearsal:**
  - Stop the witness → captures pause, verification still works.
  - Mirror gone → app loads from Swarm or local.
  - With the network off, a locally run app verifies a downloaded evidence file.

**P6 Docs + submission [2 h]**
- README:
  - How to run.
  - CROPS section.
  - Writer wallets and a runnable Arkiv query.
  - Limitations.
  - AI use.
- `/arkiv/{schema,friction,reach,why-arkiv,how-you-use-arkiv,swarm}.md`.
- `docs/` with the design and plan.
- A video of 3 minutes or less.

## 5. What the user supplies (and when)
| Needed by | Item |
|---|---|
| P0 | Docker running. Treasury private key + Arkiv access key pasted by the user into `.env.local` (never into chat). Treasury has tGLM |
| P1 live | GitHub Pages enabled on the repo (Settings → Pages). Mac online (I start the tunnel) |
| P2 live | Gift xBZZ/xDAI swept into the treasury. MetaMask has the Rabdi + Gnosis networks. One real approval click |
| P3+ | Each teammate: Chrome/Brave + our extension (load unpacked from a zip) + MetaMask. tGLM is sent from the treasury by script |

## 6. Risks, fallbacks, cut order
- **Forked extension build blocked:** D25 fallback (store extension + `window.tlsn.execCode`, signature inside `results`).
- **Quick-tunnel URL changes on restart:** the witness profile entity on Arkiv carries the current URL, so extensions find it automatically.
- **Custom CA needs dev flags on both sides:** dev builds only. Release builds use Mozilla roots.
- **Gateway may reject our stamped /chunks POSTs:** checked first thing in P0 with curl. Fallback: free /bytes mode, or a local Bee node (Nook).
- **The Arkiv access key ships in client code:** user-replaceable; documented.
- **MPC is ~30 MB per capture through the tunnel:** measured in the P1 live check; captures are capped at 64 KB to start.
- **alpha.15 is unaudited:** stated in the README limitations, along with single witness, testnet and gateway caveats.
- **Cut order:**
  1. PDF preview polish
  2. Swarm-hosted app (keep GitHub Pages + local)
  3. Diff (keep the timeline)
  4. Swarm top-up (keep the Arkiv extend)
  5. Confirmations (store as a new capture instead)
- **Never cut:** witness-signed capture via the extension, Swarm + Arkiv write via MetaMask, browse/verify with tamper detection (including an offline dropped evidence file), the CROPS moment.

## 7. Builder's calls
- Package layout and UI styling.
- Exact attribute names.
- Canonical-URL rules (tested).
- Mechanism for extension↔app messaging.
- Pool tracking format.
- Size cap (start at 64 KB, raise after P1 measurements).
- Mock-wallet implementation.
- Fictional notice content.

## 8. Verification
- Every phase: `pnpm test:e2e` green on local devnets (Playwright + Vitest), then `pnpm test:live` against Rabdi, Swarm mainnet, the tunnel witness and GitHub Pages, plus a manual MetaMask smoke test.
- Outputs (entity keys, Swarm refs, tx hashes, timings) are logged in `docs/evidence-log.md`.
- Final rehearsal: the full demo script on the deployed builds, with teammates as capturers and verifiers.
