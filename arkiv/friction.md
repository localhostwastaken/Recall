# Arkiv friction

What got in our way while building Recall on Arkiv Rabdi with `@arkiv-network/sdk` 1.0.1, roughly
in order of how much time it cost. Each item says what we expected, what happened, how to reproduce
it, and what would have helped.

## 1. The access key silently disappears when you pass your own transport

- **Expected:** `createPublicClient({ chain: rabdi({ accessKey }), transport: http(rpcUrl) })` sends
  the key, since the chain was given it.
- **What happened:** `rabdi({ accessKey })` puts the key only into the chain's `rpcUrls`
  (`https://rpc.rabdi.db-chain.testnet.arkiv.network/<key>`). The moment you pass an explicit
  `http(url)`, the usual viem pattern (we needed it to let users pick their own RPC), the key is gone
  and every read goes to the heavily rate-limited public endpoint. No warning: the "no access key"
  console warning only fires when the key passed to `rabdi()` is empty. Our app and extension read
  without the key until a code review caught it.
- **Reproduce:**
  ```ts
  const pub = createPublicClient({ chain: rabdi({ accessKey: KEY }), transport: http('https://rpc.rabdi.db-chain.testnet.arkiv.network') });
  // every request goes to the bare host, without KEY
  ```
- **Fix we used:** build the keyed URL ourselves (`arkivRpcUrl` in
  [`packages/net/src/config.ts`](../packages/net/src/config.ts)), only for that exact host.
- **Would help:** send the key in a header (so the transport URL and the key are independent), or
  warn when a Rabdi chain with a key is used with a transport whose URL has no key.

## 2. A key in the URL path leaks into error messages and logs

- **What happened:** viem puts the request URL into HTTP error messages (`URL: https://.../<key>`).
  Our errors are shown in the page and logged by the extension, so the key ended up on screen. We
  wrote a scrubber that walks the error `cause` chain (`message`, `shortMessage`, `details`, `url`,
  `stack`, `metaMessages`), plus `redactKey` for anything after the Rabdi host
  ([`packages/net/src/arkiv.ts`](../packages/net/src/arkiv.ts), [`redact.ts`](../packages/net/src/redact.ts)).
  The key also shows in the browser's Network tab and in any proxy log.
- **Would help:** header-based keys (as above).

## 3. A browser app has to ship its access key

- **What happened:** Recall is a static app (GitHub Pages, Swarm, local build) with no backend, by
  design. Without a key, reads hit the public endpoint's rate limit; with a key, the key is in the
  public bundle. We chose to bake a key into the builds (from a CI secret, never committed) and let
  users replace it in Settings, and we document it as a limitation.
- **Would help:** keys that are safe to publish: read-only, limited per origin (like map API keys),
  or a keyless read tier with a per-IP limit sized for real browser use.

## 4. `extendEntity(fromDays(n))` means "n days from now", and reverts if that is not later

- **Expected:** "extend by 7 days" adds 7 days to the current expiry.
- **What happened:** `ExpirationTime.fromDays(7)` is 7 days from the current block. On a record
  created with 30 days, that is earlier than its expiry, and the chain reverts with
  `ExpiryNotExtended`. A keep-alive button built the obvious way fails on every fresh record.
- **Reproduce:** create an entity with `fromDays(30)`, then `extendEntity({ entityKey, expiration:
  ExpirationTime.fromDays(7) })`: reverted.
- **Fix we used:** read `$expiresAt`, compute `current + days` in blocks, cap it at
  `currentBlock + MAX_LIFETIME`, and send `ExpirationTime.atBlock(...)` for all records in one
  `executeBatch` (`planExtension` / `extendEntities` in `arkiv.ts`).
- **Would help:** an `ExpirationTime.addDays(n)` (relative to the current expiry), or a clearer
  name and a doc note on `fromDays`; and an error that says "the new expiry must be later than block
  N".

## 5. Days are counted at a nominal 2-second block

- **What happened:** the SDK converts days to blocks at 2 s per block. The local dev node
  (`arkiv-reth-dev`) makes 1-second blocks, so a "30-day" record shows about 15 days locally, and
  "extend by 7 days" adds about 3.5 real days. Dates we show come from `getBlockTiming()`, so they
  are right, but the requested durations are not.
- **Would help:** compute `fromDays` from the chain's real block time (the SDK already has
  `getBlockTiming`), or say in the docs that the dev node's block time differs.

## 6. Adding Rabdi to MetaMask

- **What happened:** every capturer must add a custom network (chain 7794095, tGLM) before the
  first write. We call `wallet_addEthereumChain` then `wallet_switchEthereumChain`, which is up to
  two extra prompts on first use, for people who have never heard of Rabdi. The RPC URL we hand
  MetaMask is the keyed one (so writes are not rate-limited), so the key also lands in the user's
  wallet settings. Getting tGLM means a faucet visit or a transfer from someone who has some (we
  fund teammates by script).
- **Would help:** a chain-list entry so wallets know Rabdi, and a gas sponsor / paymaster option
  for small writes from new users.

## 7. Reads can lag the write receipt

- **What happened:** right after a `createEntity` receipt, a query by attribute sometimes came back
  empty (seen in our devnet tests). We poll for up to 10 s in tests, and the approval tab retries
  its "is it on Arkiv yet" check 4 times before telling the extension the record is published.
- **Would help:** documenting the expected delay, or a read option that waits for a given block.

## 8. Anyone can write rows with your entity type

- **What happened:** `recall.v1.capture` is just a tag; any wallet can write rows with it and any
  attribute values. A spammer can flood a URL's listing, so `listByUrl` keeps a separate row budget
  per entity kind, reports `truncated`, and the app says "Too many records for this URL (possible spam)" instead
  of silently showing a partial list. Every row is then verified against its signed evidence.
- **Would help:** a way to register a schema/type so rows can be filtered by an allowed writer set
  or a reputation signal, or server-side ordering by `$createdAt` so the newest rows are not starved.

## 9. `ownedBy` is not "written by", and entities are editable by default

- **Expected:** `.ownedBy(W)` returns entities that W wrote, so it is safe for "the witness's own
  profile".
- **What happened:** `changeOwnership` needs no consent from the new owner. Anyone can create a
  `recall.v1.witness` profile naming witness W with their own URL, then hand it to W; with an owner
  filter and "newest wins", every extension would then connect to the attacker's server. A
  reviewer found it; we reproduced it on the local node (SDK 1.0.1). Separately, entities are
  patchable by their owner unless created with `readonly: true`, which we had not set.
- **Reproduce:** attacker `createEntity(WitnessSchema, { witness: W, url: evil })`, then
  `changeOwnership({ entityKey, newOwner: W })`; `select().from(WitnessSchema).where(eq('witness',
  W)).ownedBy(W)` now includes it.
- **Fix we used:** `.createdBy(W)` (`$creator` never changes), and `readonly: true` on every Recall
  entity, with a test for each.
- **Would help:** a warning in the `ownedBy` docs that ownership can be pushed onto anyone; an
  opt-in "accept transfer" for recipients; and a flag that also forbids delete and transfer, for
  records meant to be permanent while paid for.

## Also, on the Swarm side

- **bzz.link and the upload gateway moderate HTML of non-allowlisted hashes; the hosting docs don't
  mention it.** Our published app answered `302 -> bzz.link/forbidden` on api.gateway.ethswarm.org
  and bzz.link, and was served only by download.gateway.ethswarm.org, until the Swarm team allowlists
  the hash. Details, with the hashes, in [swarm.md](swarm.md#what-got-in-our-way-with-swarm).

## What worked well

- Keyset paging (`gt('$key', last)` + `orderBy(asc('$key'))`) is stable while rows are being written,
  unlike offsets.
- `.createdBy(addr)` made witness discovery safe in one line, once we knew to use it instead of `ownedBy`.
- `executeBatch` let one MetaMask prompt extend any number of records.
- Fees are tiny: a capture write cost 0.000201535 tGLM; the witness profile 0.00015068 tGLM.
