# How Recall uses Arkiv

Arkiv is Recall's **public index**: the one place where anyone can ask "what captures exist of this
page?" without asking us. The evidence itself is on Swarm ([swarm.md](swarm.md)); the schema is in
[schema.md](schema.md).

## Do the filters, owners and expiry fit the app?

**Filters.** People look a page up by its URL, so the main indexed attribute is `urlHash`
(keccak256 of the canonical URL). One equality filter answers the question the popup and the
timeline ask. `serverName` and `witness` are indexed for "all captures of this site" and "all
captures by this witness". We deliberately do **not** trust any attribute: anyone can write a
`recall.v1.capture` row with any values, so every row is re-checked against its signed evidence
before the app shows it as verified, and rows that fail sit behind "show unverified (n)".

**Owners.** A capture is owned by the person who made it, because they pay for it and sign it in
their own MetaMask; nobody else, including us, can change it. A witness profile is owned by the
witness key itself, and the extension reads only profiles **owned by** the witness it trusts
(`.ownedBy(witness)`), so nobody can redirect captures to a fake witness by writing a profile with
the right attribute.

**Expiry.** A capture starts with 30 days. That is the honest default: it costs little, and it
lives exactly as long as someone cares. Every entity has `permissionlessExtension: true`, so the
people who need a capture later (a journalist, a reader, the institution being watched) can extend
it themselves, without the original capturer.

## Write paths

| Who | What | Where in the code |
|---|---|---|
| The capturer, in **MetaMask**, in the approval tab the extension opens | `createEntity` of a `recall.v1.capture` (or a `recall.v1.confirmation` for an identical body). The app first adds or switches MetaMask to Rabdi (chain 7794095), re-runs checks A to C and the Swarm root check itself, and builds the row only from verified facts | [`apps/web/src/routes/Approve.tsx`](../apps/web/src/routes/Approve.tsx), [`apps/web/src/wallet.ts`](../apps/web/src/wallet.ts), `writeCapture` / `writeConfirmation` in [`packages/net/src/arkiv.ts`](../packages/net/src/arkiv.ts) |
| The **witness** key | `createEntity` of a `recall.v1.witness` profile with its current URL (`pnpm witness:announce --net live`) | [`scripts/announce-witness.ts`](../scripts/announce-witness.ts) |
| **Anyone**, in MetaMask | Keep-alive: one `executeBatch` that extends every chosen record by 7 or 30 days on top of its current expiry (capped at the chain maximum), next to a Swarm batch top-up | [`apps/web/src/keepalive/flow.ts`](../apps/web/src/keepalive/flow.ts), `extendEntities` in `arkiv.ts` |

Live write: capture entity `0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244`, tx
[`0x512ad75e...175d4f`](https://rabdi.explorer.arkiv.network/tx/0x512ad75ec7002990307ba29f763d2e3f9aa343b851abc4b39e6ab89bf4175d4f)
(Rabdi block 279811, fee 0.000201535 tGLM, 13 s from "Publish" to done).

## Read paths

| Read | Query | What the user sees |
|---|---|---|
| **listByUrl** | `eq('urlHash')` on captures and on confirmations, keyset-paged with `gt('$key', last)` + `orderBy(asc('$key'))`; each kind has its own row budget, and `truncated` is reported | The extension popup shows "earlier captures of this page" before you capture (and offers a confirmation for an identical body). The web app's page timeline and diff. `pnpm arkiv:query` |
| **Owner-filtered discovery** | `eq('witness', w)` + `.ownedBy(w)`, newest `$createdAt` wins | The popup finds the witness and shows "Witness online" with no URL typed in. Our quick-tunnel URL changes on every restart; this is how extensions follow it |
| **getEntity** | by entity key | A shared capture link (`#/c/<entityKey>`) opens straight to its verified view. The approval tab checks for an existing identical record before writing again |
| **Expiry** | `getEntity().$expiresAt` + `getBlockTiming()` | Check E, "Record on Arkiv until <date>", and the keep-alive preview (what it costs and the date the record would then last until) |

## Does each feature change something users see?

| Arkiv feature | What the user sees because of it |
|---|---|
| Entities owned by a wallet | Each record carries the wallet that wrote it, and only that wallet could have written it; the approval tab uses the owner to avoid writing the same record twice |
| Indexed attributes + query | The page timeline, and "earlier captures" in the popup, for any URL, from any copy of the app |
| `ownedBy` | Witness discovery that a stranger cannot hijack |
| Expiry | Check E and the "until <date>" line; a capture nobody keeps alive really goes away |
| `permissionlessExtension` + batch extension | The Keep-alive button works for anyone, on someone else's capture, in one wallet prompt |
| Public reads | Verification works from GitHub Pages, from Swarm, from a local build or from `pnpm arkiv:query`, with no Recall server |
