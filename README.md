# Recall

**Prove what a public web page said, on a given day, to anyone, without trusting us.**

Official notices and policies get quietly edited or taken down. Recall lets a journalist or
researcher capture a public HTTPS page so that anyone can later check, in a browser or fully
offline, that the page really said that:

1. **Capture.** The Recall browser extension fetches the page over TLS together with an
   independent **witness** (TLSNotary MPC-TLS). The witness never sees your keys or cookies, but it
   can tell that the bytes really came from that server, and it signs a statement about them
   (EIP-712).
2. **Store.** The signed evidence file (request, response, signature) goes to **Swarm**, stamped in
   your browser with a postage batch you paid for.
3. **Index.** A small record (which page, which body hash, which witness, when, where the evidence
   is) goes to **Arkiv**, written from your own MetaMask.
4. **Verify.** The Recall web app (or `pnpm arkiv:query`) finds every capture of a URL on Arkiv,
   downloads the evidence from any Swarm gateway, recomputes the Swarm hash, and re-runs every
   check itself: transcript hashes (A), the request and response (B), and the witness signature
   against the witnesses *you* trust (C). It shows a timeline of versions and a diff ("15 December"
   became "12 December"). A downloaded evidence file can be dropped into the app and verified with
   the network switched off.

Live: the app at <https://localhostwastaken.github.io/Recall/app/>, the demo notice at
<https://localhostwastaken.github.io/Recall/notice/>.

## Demo

<!-- DEMO-VIDEO: link to the 3-minute video goes here -->
_Demo video: coming with the submission (3 minutes, link here)._

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Capturer's browser"]
    EXT["Recall extension<br/>(TLSNotary prover, stamp key)"]
    APP["Recall web app<br/>(approve, verify, keep-alive)"]
    MM["MetaMask"]
  end
  SITE["Public HTTPS page"]
  W["Witness server<br/>(TLSNotary verifier + EIP-712 signer)"]
  SW[("Swarm<br/>evidence file")]
  AR[("Arkiv Rabdi<br/>capture index")]
  GN[("Gnosis<br/>postage batches")]
  READER["Any reader<br/>(web app, pnpm arkiv:query, offline file)"]

  EXT <-->|"MPC-TLS via /proxy"| SITE
  EXT <-->|"MPC session, signed statement"| W
  EXT -->|"client-stamped POST /chunks"| SW
  EXT -->|"pending record"| APP
  APP --> MM
  MM -->|"createEntity"| AR
  MM -->|"buy batch, topUp"| GN
  W -.->|"profile: current URL"| AR
  READER -->|"listByUrl(urlHash)"| AR
  READER -->|"GET /bytes/ref, root check"| SW
```

| Part | Where | What it is |
|---|---|---|
| Extension | `extension/` | Fork of [tlsn-extension](https://github.com/tlsnotary/tlsn-extension) 0.1.0.1501 with a "Capture this page" popup, the stamp key and the Swarm upload (`extension/packages/extension/src/recall/`) |
| Witness | `witness/` | TLSNotary's verifier server (tlsn `v0.1.0-alpha.15`) plus Recall's gates and EIP-712 signing patch ([witness/README.md](witness/README.md)) |
| Evidence | `packages/evidence/` | The evidence format, HTTP transcript parsing, canonical URL, and the checks A to D, shared by the extension, the app and the scripts |
| Network | `packages/net/` | Arkiv entities and queries, Swarm stamping and download, Gnosis postage batches |
| Web app | `apps/web/` | Browse, verify, approve (the MetaMask write), buy storage, keep-alive, settings. Static, hash-routed, no backend |
| Scripts | `scripts/` | Witness key and profile, funding, Swarm publish of the app, the docs check and the Arkiv query |
| Docs | `docs/`, `arkiv/` | Design and plan, the live evidence log, and the Arkiv and Swarm prize docs |

More detail: [arkiv/schema.md](arkiv/schema.md), [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md),
[arkiv/swarm.md](arkiv/swarm.md), the design in
[docs/superpowers/specs/2026-11-06-recall-design.md](docs/superpowers/specs/2026-11-06-recall-design.md)
and every live value we measured in [docs/evidence-log.md](docs/evidence-log.md).

## CROPS

The lead property is **censorship resistance of the evidence**: once a page is captured, nothing
Recall runs is needed to find it, fetch it or check it.

- **C: Censorship resistance.** We run one thing users depend on, the witness server (plus the
  GitHub Pages copy of the app).
  - If the witness goes away or refuses you, *new* captures stop (the popup says "witness offline"),
    but every existing capture still verifies: the index is on Arkiv, the evidence on Swarm, and the
    checks run in the reader's browser.
  - Anyone can run another witness from `witness/`. Readers choose which witness keys they trust
    (pinned in Settings), and a witness announces its URL on Arkiv, so no Recall server is needed
    to find it.
  - The app is static: GitHub Pages, any Swarm gateway (`pnpm publish:swarm`) or `pnpm --filter web
    dev` from this repo. The Arkiv RPC and Swarm gateways can be swapped in Settings. A downloaded
    evidence file verifies with the network switched off.
- **O: Open source.** MIT ([LICENSE](LICENSE)); the forked TLSNotary code keeps its MIT/Apache-2.0
  notices. Everything (extension, witness, app, scripts, local devnet) builds and runs from this
  repo alone; see [Run it](#run-it).
- **P: Privacy.** No analytics or trackers in the app or the extension. What third parties learn:
  - the **witness** sees the page you capture (Recall is for public pages; requests carry no cookies
    or auth, the witness enforces that) and your IP address;
  - the **Arkiv RPC** sees which URL hashes you look up; the **Swarm gateway** sees which evidence
    you fetch; both see your IP;
  - an Arkiv record is **public** and owned by the wallet that wrote it, so a capture links that
    wallet to that page. Use a fresh wallet if that matters.
- **S: Security.** Keys stay on the user's device: MetaMask holds the wallet key, the extension's
  stamp key stays in `chrome.storage.local`, the witness key stays on the witness server.
  - Trust assumptions: an evidence file is only as good as the witness that signed it (a witness
    that colludes with a capturer could sign a false page), which is why readers pin witnesses and
    a signature from an unknown key shows "unknown witness". tlsn alpha.15 is unaudited.
  - Gateways and RPCs are not trusted: the Swarm root is recomputed locally, the checks are re-run
    on every view, a record that disagrees with its evidence is hidden behind "show unverified",
    and the captured page is shown only in a sandboxed iframe.

## Run it

**Needs:** Node 22, pnpm 10 (`corepack enable`), Docker, and Chrome or Chromium. MetaMask for live
writes.

```bash
pnpm install
```

### Verify without installing anything
Open <https://localhostwastaken.github.io/Recall/app/>, paste
`https://localhostwastaken.github.io/Recall/notice/?run=0tzgmo55` and open the capture. Or run the
query below (`pnpm arkiv:query`).

### Local devnet and tests
```bash
pnpm devnet:up         # Arkiv dev node :8545, Gnosis fork :9545, 3 Bee nodes :1633/:1643,
                       # TLS 1.2 notice fixture, witness :7047 (first run builds images; minutes)
pnpm test              # Vitest: packages, app and scripts against the devnet
(cd extension && npm install && RECALL_DEV_CA_DER_B64=$(base64 -i ../fixtures/notice/.certs/ca.der) npm run build)
pnpm test:e2e          # Playwright: extension + app journeys on the devnet (mock wallet)
pnpm check:docs        # the submission docs are complete
pnpm devnet:down
```
Details: [devnet/README.md](devnet/README.md).

### The extension
```bash
pnpm extension:zip     # release build (Mozilla roots, no dev hooks) -> dist/recall-extension.zip
```
Unzip it, open `chrome://extensions`, turn on Developer mode, "Load unpacked", pick the folder. Open
a public HTTPS page that serves TLS 1.2 (the demo notice does), click the Recall icon, then
"Capture this page". After the upload, an approval tab opens in the web app: connect MetaMask, let
it add Arkiv Rabdi (chain 7794095), and publish. The first capture needs a postage batch: buy one on
the app's Storage page (Gnosis, xBZZ).

### The web app
- Hosted: <https://localhostwastaken.github.io/Recall/app/> (live networks).
- From source: `pnpm --filter web dev` (local devnet) or `VITE_RECALL_NET=live pnpm --filter web dev`
  (live networks). A build is plain static files (`pnpm --filter web build`), so it can be served
  from anywhere, including Swarm: `pnpm publish:swarm --net live`.

### Your own witness
Copy `.env.example` to `.env.local`, run `pnpm witness:keygen` (writes the key, prints only the
address), then `pnpm tunnel:up` (Docker witness plus a Cloudflare quick tunnel) and
`pnpm witness:announce --net live` (writes the witness profile on Arkiv). Readers add your address in
Settings to trust your captures.

## Writer wallets

Every Arkiv entity this project wrote on **Arkiv Rabdi** (chain 7794095) came from one of these:

| Wallet | Role | Writes |
|---|---|---|
| `0xd46480d1Ec02B8ce92aE383914026efD5F73f835` | Treasury, and the capturer's wallet in our live runs (MetaMask / the mock wallet backed by its key) | `recall.v1.capture` (and `recall.v1.confirmation`) records |
| `0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D` | The Recall witness signer | `recall.v1.witness` profile (its current URL); also the EIP-712 signer of every capture |

In the product, capture records are written by whoever captures, from their own wallet.

**Run a query** (reads Rabdi with `@recall/net` `listByUrl`, then downloads and verifies each
capture's evidence from Swarm):

```bash
pnpm install
pnpm arkiv:query
# or another page:
pnpm arkiv:query --url 'https://localhostwastaken.github.io/Recall/notice/?run=xbvmqf0p'
```

It prints the latest 5 captures of the page with signer, signedAt and evidenceRef, and marks the
ones that verify A to C against the Recall witness. An `ARKIV_ACCESS_KEY` in `.env.local` is used
when present (never printed); without one it uses the public, rate-limited endpoint. The query it
runs: `select().from(recall.v1.capture).where(eq('urlHash', keccak256(canonicalUrl)))`, paged by
`$key`.

## Limitations

- **One witness.** Captures need the Recall witness (or another one someone runs). It currently runs
  on a laptop behind a Cloudflare quick tunnel. Verification does not need it.
- **tlsn alpha.15 is unaudited.** TLSNotary `v0.1.0-alpha.15` has had no security audit, and nor has
  our signing patch.
- **TLS 1.2 only.** The MPC-TLS in this tlsn version speaks TLS 1.2; sites that only offer TLS 1.3
  cannot be captured.
- **64 KB response cap.** A capture is limited to about 64 KB of response, so large pages, video and
  big files are out.
- **About 77 MB of upload per capture.** MPC setup sends roughly 77 MB from the browser to the
  witness (measured: 77.0 MB in / 3.7 MB out). On a fast link a capture takes 5 to 30 s; on a slow
  link (a 5 Mbps venue uplink, in our case) it times out.
- **Testnet.** The index is on Arkiv **Rabdi**, a testnet. Swarm and Gnosis are mainnet.
- **Public gateway moderation.** By default evidence is uploaded and read through the public Swarm
  gateways (api/download.gateway.ethswarm.org, bzz.link), which can refuse or take content down. The
  data stays on Swarm while its batch is paid; any Bee node or gateway can be set in Settings.
- **The Arkiv access key ships in the client, by design.** It is a public rate-limit key baked into
  the app and extension builds (never committed); anyone can read it from the bundle. Users can
  replace it in Settings.
- **A record's batchId is not cryptographically bound to its evidence.** The Swarm reference is
  bound (the root hash is recomputed), but the batch a record names could be any batch. The
  keep-alive therefore checks that the batch exists on Gnosis and has Recall's size (depth 17,
  immutable) before anyone pays to top it up.
- Storage lasts as long as someone pays: a postage batch and an Arkiv record expire unless someone
  uses keep-alive (permissionless; anyone can extend any capture).
- Not legal-grade proof, and public pages only (no logins, no cookies).

## AI use

<!-- AI-USE: wording to be confirmed with the team -->
_Placeholder, to be confirmed by the team before submission:_ AI coding assistants were used during
the hackathon to help draft the design and plan documents in `docs/superpowers/`, write and review
code and tests, and draft documentation. The team made the product and design decisions, and every
change was checked by tests against local devnets and live networks before it was kept.

## Licence and credits

MIT, see [LICENSE](LICENSE).

Recall builds on [TLSNotary](https://tlsnotary.org): the extension is a fork of
[tlsn-extension](https://github.com/tlsnotary/tlsn-extension) and the witness is its
`servers/verifier`, both dual-licensed MIT / Apache-2.0 by the TLSNotary contributors. Their notices
are kept in [extension/NOTICE](extension/NOTICE) and [witness/NOTICE](witness/NOTICE). Storage on
[Swarm](https://www.ethswarm.org) (bee-js), index on [Arkiv](https://arkiv.network) (`@arkiv-network/sdk`).
