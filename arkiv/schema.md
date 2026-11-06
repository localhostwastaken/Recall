# Arkiv schema

Recall writes three entity types to **Arkiv Rabdi** (chain 7794095). They are defined once, with
`defineSchema` from `@arkiv-network/sdk`, in [`packages/net/src/arkiv.ts`](../packages/net/src/arkiv.ts),
and the extension, the web app and the scripts all use that one definition.

Every entity is created with:
- **`readonly: true`**: its attributes can never change, not even by its owner;
- **expiry:** 30 days (`ExpirationTime.fromDays(30)`), which anyone can push further with keep-alive,
  up to the chain maximum of about 182 days ahead (`MAX_LIFETIME`, 7,884,000 blocks);
- **`permissionlessExtension: true`**, so anyone, not only the owner, can extend it. A capture
  should outlive the interest of the person who made it: a reader who cares about a page can keep
  its evidence alive.

So nobody can edit a record's content, and anyone can extend it. Arkiv has no flag against the
other two owner powers: the owner of a record can still **delete** it or **transfer** it to another
wallet. Recall never does either; a new version of a page is a new capture. Records written before
the read-only flag was added (the live demo capture and witness profile below, written on
2026-11-06) are not read-only: their `creationFlags` show `"readonly":false`.

## `recall.v1.capture`: one witnessed version of a page

Owner: the wallet of the person who captured the page (they sign `createEntity` in MetaMask, in the
web app's approval tab). Live example:
[`0xc50021a9...3611244`](https://localhostwastaken.github.io/Recall/app/#/c/0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244),
written by `0xd46480d1Ec02B8ce92aE383914026efD5F73f835`.

| Attribute | Type | Indexed | What it is | Why |
|---|---|---|---|---|
| `urlHash` | key (32 B) | **yes** | keccak256 of the canonical URL | The main query: "every capture of this page". The popup runs it when you open a page, the app's timeline runs it, and so does `pnpm arkiv:query` |
| `serverName` | str | **yes** | The TLS server name the witness proved | Lets a reader list the captures of one site (the domain) |
| `witness` | addr | **yes** | The witness that signed the statement | Lets a reader ask for one witness's captures. Never trusted by itself: check C recovers the signer from the evidence |
| `bodySha256` | key | no | sha256 of the response body | Detects "same body" (a confirmation, not a new upload) and is cross-checked against the evidence |
| `signedAt` | u64 | no | When the witness signed (Unix s) | Timeline order; cross-checked against the evidence |
| `httpStatus` | i32 | no | The response status | Shown on the timeline |
| `batchId` | key | no | The Swarm postage batch the evidence was stamped with | Keep-alive tops up this batch |
| `evidenceRef` | key | no | The Swarm reference of the evidence file | Where to download the evidence ([swarm.md](swarm.md)) |
| `canonicalUrl` | bytes | no | The canonical URL itself | Shown to the reader; its hash must equal `urlHash` |

## `recall.v1.confirmation`: "the page was still the same at this time"

Written instead of a capture when a new capture's body is byte-identical to an existing capture
(no second Swarm upload). Owner: the capturer's wallet.

| Attribute | Type | Indexed | What it is | Why |
|---|---|---|---|---|
| `captureKey` | key | **yes** | Entity key of the capture it confirms | Find the confirmations of one capture |
| `urlHash` | key | **yes** | As above | Listed with the captures on the page's timeline |
| `witness` | addr | **yes** | As above | As above |
| `bodySha256` | key | no | As above | Must equal the confirmed capture's |
| `signedAt` | u64 | no | When the witness signed | Timeline order |
| `evidence` | bytes | no | The whole evidence file, inline | Small enough (well under Arkiv's 128 KiB entity limit at the 64 KB capture cap) that no Swarm batch is needed; verified exactly like a capture's evidence |

## `recall.v1.witness`: where a witness can be reached

Creator (and owner): **the witness's own signing key** (`0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D`
for the Recall witness), written by `pnpm witness:announce`. Discovery counts only profiles whose
**`$creator`** is the witness: the owner can change (anyone can create a profile and hand it to the
witness), the creator cannot. Live example: profile entity
`0xf7c813892f290fbb35aaa129e04759434b833d4f47d629a6917144ac28aa913a`
(tx [`0x5a7f3b3e...5ab616`](https://rabdi.explorer.arkiv.network/tx/0x5a7f3b3e47dd042beb0a4cbcabd0f12cb597a06328e83cb497871bdc0a5ab616)).

| Attribute | Type | Indexed | What it is | Why |
|---|---|---|---|---|
| `witness` | addr | **yes** | The witness address | The query, together with a creator filter ([how-you-use-arkiv.md](how-you-use-arkiv.md)) |
| `url` | str | no | The witness's current public URL | The extension connects there. A quick tunnel gets a new URL on every restart, so the witness announces again; the newest profile wins |

## The queries

```ts
// Every capture of a page (keyset paging on $key, stable while rows are being written):
select().from(CaptureSchema).where(and(eq('urlHash', key(h)), gt('$key', key(last)))).orderBy(asc('$key')).limit(100)
// The same for confirmations (ConfirmationSchema).
// A witness's current URL: only profiles CREATED by that witness count ($creator never changes).
select().from(WitnessSchema).where(eq('witness', addr(w))).createdBy(w)
// Expiry, for check E and keep-alive:
getEntity(key) -> $expiresAt;  getBlockTiming()
```

Run one yourself: `pnpm arkiv:query` (see the [README](../README.md#writer-wallets)).
