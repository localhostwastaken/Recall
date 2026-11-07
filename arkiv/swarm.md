# Swarm in Recall

## What lives where

| Swarm | Arkiv |
|---|---|
| The **evidence file** of each capture: a JSON file (`recall.evidence.v1`) with the witness's signed EIP-712 statement, the signature and signer, and the full TLS transcript (request and response bytes). A few KB; at most about 64 KB of page | The **index**: one `recall.v1.capture` entity per capture, with the page's `urlHash`, `bodySha256`, `serverName`, `witness`, `signedAt`, `httpStatus`, and the two Swarm fields below ([schema.md](schema.md)) |
| The Recall **web app** itself, live as a Swarm website (`pnpm publish:swarm`), so the verifier keeps working if GitHub Pages goes away: see [The web app on Swarm](#the-web-app-on-swarm) | The **witness profile** (where to reach the witness) |

The entity field that holds the Swarm reference is **`evidenceRef`** (a 32-byte key attribute) on
`recall.v1.capture`. Next to it, **`batchId`** names the postage batch the evidence was stamped with,
so anyone can top it up (keep-alive). A `recall.v1.confirmation` (same page, byte-identical body)
carries its small evidence inline and needs no Swarm upload.

Evidence references are **unencrypted** on purpose: Recall captures public pages, and the evidence is
meant to be read by anyone. No encrypted reference (which would contain its key) is ever written to
Arkiv.

## How evidence is stored

1. **One batch per capture.** The web app's Storage page buys immutable **depth-17** postage batches
   on Gnosis with MetaMask (`approve` xBZZ, then `createBatch` with **owner = the extension's stamp
   address**), and hands them to the extension, which keeps a pool. The Storage page offers 7 or 30
   days (about 0.32 xBZZ for a 7-day batch at today's price). Each capture takes a fresh batch, so a
   capture's storage can be topped up on its own and a used stamp slot is never reused.
2. **Client-side stamping.** No Bee node owns the batch. The extension's offscreen document splits the
   evidence into chunks, stamps each chunk with the stamp key (bee-js `Stamper`), and pushes it with
   **`POST /chunks`** to a gateway or Bee node (default: `https://api.gateway.ethswarm.org`). The stamp
   key lives only in the extension's `chrome.storage.local`.
3. **Root verification on read.** A reader downloads `/bytes/<ref>` from any gateway (default:
   `https://download.gateway.ethswarm.org`, then `https://bzz.link`), **recomputes the Swarm root hash
   locally** and refuses bytes that do not hash to the reference. Gateways are not trusted. Then the
   evidence is checked (A to C) and compared with the Arkiv record (urlHash, bodySha256, witness,
   signedAt).
4. **Keep-alive.** Anyone can `topUp` the batch on Gnosis (permissionless) and extend the Arkiv record,
   in one flow in the web app. Before paying, it checks that the batch exists and is a Recall batch
   (immutable, depth 17 or 18).

## One live example (2026-11-06, from [docs/evidence-log.md](../docs/evidence-log.md))

- **Arkiv entity key:** `0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244`
  (type `recall.v1.capture` on Rabdi, tx
  [`0x512ad75ec7002990307ba29f763d2e3f9aa343b851abc4b39e6ab89bf4175d4f`](https://rabdi.explorer.arkiv.network/tx/0x512ad75ec7002990307ba29f763d2e3f9aa343b851abc4b39e6ab89bf4175d4f),
  block 279811, written by `0xd46480d1Ec02B8ce92aE383914026efD5F73f835`).
  Verified view: <https://localhostwastaken.github.io/Recall/app/#/c/0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244>.
  This record was written before Recall entities were made read-only, so its `creationFlags` show
  `"readonly":false`.
- **Swarm reference** (its `evidenceRef`): `4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202`
  (2723 bytes). Open it: <https://bzz.link/bytes/4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202>
  or <https://download.gateway.ethswarm.org/bytes/4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202>.
- **Postage batch ID:** `0xde1b6b808de55064687e6c1ef7eae9aef91d9d9167d44719a2350fb3c6d8dd63`
  (depth 17, bucket depth 16, immutable, 3 days; cost 0.1367189760376832 xBZZ). The live test harness
  bought it directly with `buyBatch` (3 days, to stay under its spend cap) and, unlike the product,
  **reused it for two captures**: this one and an earlier run's
  (entity `0x6c488161621f449b4b21f165f9717a9c2da183ea45a7da28a4eb3084ca88123c`, Swarm reference
  `d2e1d35391f0eec3c238918471adcded6e121b517b5b72560c34da1815cc6b1c`). The stamper state was kept,
  so no stamp slot was reused. The product uses one batch per capture.
- **Batch owner:** `0x5455B84fcB0a05C0B68F8262a183D7e28f2a4212` (the extension's stamp address; it signs
  the stamps). **Paid by** the treasury `0xd46480d1Ec02B8ce92aE383914026efD5F73f835`: approve tx
  [`0x57969134...93325f`](https://gnosisscan.io/tx/0x57969134d16aff5883a3f163e6f45fa7813889adca1a60e7e50811ab9093325f),
  createBatch tx [`0x603c269c...a44cd4`](https://gnosisscan.io/tx/0x603c269cf0fbe031e1a58a91bdb1e2a9281209fb6fb16e25d41cfb1b81a44cd4)
  (Gnosis blocks 49134082 and 49134085).
- **Uploaded through the gateway** `https://api.gateway.ethswarm.org` (`POST /chunks`, client-stamped).
  Read back, root-checked, from `https://download.gateway.ethswarm.org` (2.7 s) and `https://bzz.link`
  (1.5 s, byte-equal).
- The page it captured: `https://localhostwastaken.github.io/Recall/notice/?run=0tzgmo55`, body
  sha256 `0x99bb0a8d8c7026af50281298955f0447def7c5069c66de0566914ffe26932273` ("Deadline: 15 December").

The batch is paid until about 2026-11-16 05:12 UTC. On 2026-11-06 the treasury added 7 days with
**Keep alive** in the app (topUp tx
[`0x3a27fb9a...8e6954`](https://gnosisscan.io/tx/0x3a27fb9a6d9a2d02fe271131e582783fdbba7bfd0fddd7d9b86f35a4358e6954),
0.319 xBZZ; the same keep-alive added 7 days to the Arkiv record). After that the evidence stays only
if someone tops the batch up: anyone can, with **Keep alive** on the capture's page in the app.

## The web app on Swarm

The built web app is a Swarm website, published on 2026-11-06 with
`pnpm publish:swarm --net live --feed --days 14 --max-xbzz 1.5 --yes`. It is a copy of the GitHub
Pages app, and it is a second place the verifier survives. Opened by its ENS name
(<https://recallapp.eth.limo>, <https://recallapp.bzz.link>) it can also publish: the release
extension accepts messages from those two exact hosts and the GitHub Pages app (pick **Swarm**
under Recall app in the popup's Advanced settings; GitHub Pages stays the default). Through a raw
`/bzz/<hash>/` address it is for browsing and verifying.

- **How to open it:** through any Bee node at `/bzz/e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0/`.
  `bash scripts/swarm-reader.sh` starts a read-only one (ultra-light: no wallet, no funds, API on
  127.0.0.1) and prints `http://127.0.0.1:1733/bzz/e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0/`. bzz.link will serve it
  once the Swarm team allowlists the hash (requested). The public download gateway serves the files,
  but as downloads (see below).
- **Site manifest** (the mantaray manifest of the build; 276 chunks uploaded): `7d1e73275798f6e0e69a08804bda4b582182e51456c41182637e8240cfad45a8`. It
  changes with every build.
- **Feed manifest** (the address to share): `e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0`. A feed is a pointer its owner can move, and
  the feed manifest is an address that always follows it. In one line: the feed keeps one address
  across republishes, as in
  [docs.ethswarm.org/docs/develop/host-your-website](https://docs.ethswarm.org/docs/develop/host-your-website/).
  Feed owner `0x3c221Ba84864c187DaA72e9A861b20aAdE1F89C1`, topic `website`; update index 0
  points at the site manifest above.
- **Hosting batch ID:** `0x50c1a8d51231595606ea8730f14554c4cdbb5d64280e82063e9a24347dd1f3b9`
  (depth 18, immutable, 14 days from 2026-11-06, 1.276 xBZZ). Batch owner and payer: the treasury
  `0xd46480d1Ec02B8ce92aE383914026efD5F73f835`: approve tx
  [`0x75eca45a...eae0`](https://gnosisscan.io/tx/0x75eca45ad0e6e332e4bece6bfe29ca931469b20dd775fd07618c2e8ef500eae0),
  createBatch tx
  [`0xbf73fc40...32dc`](https://gnosisscan.io/tx/0xbf73fc4064e2e2bf534433abf26caff292960e951c23c43c8860b2f824a132dc).
  The feed update is stamped from the same batch.
- **Uploaded through the gateway** `https://api.gateway.ethswarm.org` (`POST /chunks`, client-stamped,
  as for evidence). The script reads the site back through
  `https://download.gateway.ethswarm.org` and writes the feed only after the read-back matched.
- **bzz.link does not serve it yet.** <https://bzz.link/bzz/e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0/> and the CID form
  <https://bah5qcgza4abotkyl5zipq5fi5zdb7yctvstry7r34ublsqoysmyary2x7hqa.bzz.link/> redirect to
  `/forbidden` until the Swarm team allowlists the hash; we have asked.
- **download.gateway.ethswarm.org serves the files, but as downloads.** It answers `/bzz/...` with
  `Content-Disposition: attachment`, so a browser saves `index.html` instead of showing the app
  (curl and scripts get the right bytes). Meanwhile, open it through a Bee node of your own, as
  above. See the last two items of [What got in our way](#what-got-in-our-way-with-swarm).

## The files that upload to Swarm and read from it

| File | What it does |
|---|---|
| [`extension/packages/extension/src/recall/swarmUpload.ts`](../extension/packages/extension/src/recall/swarmUpload.ts) | Picks a batch, stamps the evidence chunks and `POST /chunks` them |
| [`extension/packages/extension/src/recall/stamp.ts`](../extension/packages/extension/src/recall/stamp.ts), [`uploadParts.ts`](../extension/packages/extension/src/recall/uploadParts.ts), [`pool.ts`](../extension/packages/extension/src/recall/pool.ts), [`batchChain.ts`](../extension/packages/extension/src/recall/batchChain.ts) | The stamp key, the stamper state, the batch pool and its on-chain checks |
| [`packages/net/src/swarm.ts`](../packages/net/src/swarm.ts) | `uploadStamped`, `swarmRootOf`, `downloadBytes` (root-verified, size-capped, gateway by gateway) |
| [`packages/net/src/postage.ts`](../packages/net/src/postage.ts) | `buyBatch`, `topUp`, `batchTtlSeconds`, `waitBatchUsable` (Gnosis postage contract) |
| [`apps/web/src/routes/Storage.tsx`](../apps/web/src/routes/Storage.tsx) | Buying batches with MetaMask and handing them to the extension |
| [`apps/web/src/verify/`](../apps/web/src/verify/) | Downloading and verifying a capture's evidence |
| [`apps/web/src/keepalive/`](../apps/web/src/keepalive/) | The top-up |
| [`scripts/publish-swarm.ts`](../scripts/publish-swarm.ts) | Publishes the web app as a Swarm website (client-stamped chunks plus a mantaray manifest; optional feed) |
| [`scripts/arkiv-query.ts`](../scripts/arkiv-query.ts) | Reads the index and downloads and verifies the evidence from the command line |

## Run one upload and one read yourself

**Read (live, needs only Node and pnpm):**
```bash
pnpm install
pnpm arkiv:query
```
You should see the capture above with `evidenceRef 0x4dde720f...13202` and the line
`verified A-C (evidence 2723 B from https://download.gateway.ethswarm.org, Swarm root checked: true)`.
Or just `curl -s https://bzz.link/bytes/4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202`
and look for `"schema":"recall.evidence.v1"`.

**Upload (local, needs Docker; no money):**
```bash
pnpm devnet:up    # Bee nodes on :1633 (upload) and :1643 (download), Gnosis fork on :9545
pnpm --filter @recall/net exec vitest run test/swarm.test.ts -t "stamped upload"
```
This buys a batch on the Gnosis fork, stamps a payload on the client, uploads it to node A with
`POST /chunks` and downloads it byte-identical from node B. To publish a whole site instead:
`pnpm publish:swarm --net local` prints the reference, and `http://localhost:1633/bzz/<ref>/` serves
the app. The live publish above is the same command with `--net live --feed` (it pays from the
treasury key in `.env.local`).

**Upload (live, the product path):** load the extension (`pnpm extension:zip`) and paste its ID
into the app's Settings, buy a batch on the app's Storage page (7 or 30 days; about 0.32 xBZZ for 7
days, plus a tiny xDAI fee; there is no public xBZZ faucet), capture the demo notice, and publish
from the approval tab. The popup shows the `evidenceRef`, and the record's page
links to the evidence.

## In the demo video

[Demo video](https://drive.google.com/file/d/1ZxGArPliJmzQaDDs9xogtd27HKMYTKiz/view) (3 minutes). Swarm is used in
two places: the **publish step** (about 1:20 to 1:40), where the bitchat evidence file and its code
archive are uploaded to Swarm with the batch bought in advance; and the **record page** right after,
where the app downloads the evidence and the code back from Swarm, recomputes their Swarm hashes and
shows the code as Hash-anchored.

## What got in our way with Swarm

- **Gateway `/bytes` uploads over 4 KB do not match the local root.** The free `POST /bytes` on
  api.gateway.ethswarm.org returned, for 5000 random bytes, a reference that is not the
  ChunkSplitter root of those bytes (gateway `074b6b80...`, local `2e3bb84f...`); single-chunk
  payloads matched. A reader therefore cannot bind gateway-built references to the bytes, which is
  why Recall stamps and chunks on the client.
- **A fresh batch never appeared in the gateway's `/batches`** (we watched for many minutes), and
  the gateway has no `/chainstate`, yet `/chunks` accepted stamps for it. We judge a batch usable by
  the chain instead (12 blocks after the `createBatch` block). The gateway's `/batches` list is also
  about 1.8 MB, too heavy to poll from a browser.
- **The minimum batch is huge for our files.** A depth-17 batch holds far more than one 3 KB evidence
  file, but it is the smallest Recall can use: our 3-day test batch cost 0.137 xBZZ, and the Storage
  page's shortest option, 7 days, costs about 0.32 xBZZ per capture.
- **bzz.link's CID subdomain form serves manifests only.** `https://<cid>.bzz.link/` answered 404 for
  raw-bytes evidence; the path form `https://bzz.link/bytes/<ref>` works.
- **The local cluster needs three full Bee nodes.** With a light node, or only two nodes, Bee never
  marks peers healthy: `POST /chunks` takes 30 s per chunk and the second node cannot retrieve
  anything.
- **bzz.link and the upload gateway moderate HTML of non-allowlisted hashes; the hosting docs don't
  mention it.** Publishing the app (276 chunks, the site manifest above) worked, and the JS asset
  read back fine, but the `index.html` of our hash answered `302 -> https://bzz.link/forbidden?hash=...`
  on api.gateway.ethswarm.org and on bzz.link, for the site manifest and later for the feed manifest.
  `download.gateway.ethswarm.org` served the exact bytes (200). Raw `/bytes/<ref>` evidence is not
  affected. Nothing in the hosting docs (docs.ethswarm.org/docs/develop/host-your-website) says a hash
  must be allowlisted first. We read back through the download gateway instead
  (the publish script now classifies a forbidden redirect as "held by gateway moderation") and asked
  the Swarm team to allowlist the feed manifest. **Would help:** a line in the hosting docs, and a
  way to see a hash's moderation status before publishing.
- **The download gateway serves websites as downloads.** `download.gateway.ethswarm.org` answers
  every `/bzz/` file with `Content-Disposition: attachment`, so a browser saves the site's
  `index.html` instead of showing it, while curl and our read-back see the right bytes (200). Our
  read-back passed, so we first called that link "working"; it works for scripts, not for people.
  With bzz.link and api.gateway waiting for the allowlist, the app opens only through a Bee node of
  your own: `scripts/swarm-reader.sh` starts an ultra-light, read-only one. **Would help:** a public
  gateway that renders allowlisted and pending sites alike, or a note on which gateway is meant for
  browsing.
