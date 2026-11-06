# Arkiv schema

Recall writes four entity types to **Arkiv Rabdi** (chain 7794095). They are defined once, with
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

## `recall.v1.attachment`: a repository snapshot linked to a capture

The implemented attachment kind is **`git`**, at **`proofLevel: 1`** ("hash-anchored"). The parent
capture contains GitHub's branch API response, which names a commit and a Git tree. The attachment
points to that commit's `.tar.gz` snapshot on Swarm. The tarball is downloaded separately from the
witnessed response; its files must reproduce the tree named in that response. It is a snapshot,
not a Git history bundle or a separate TLS proof of the tarball download.

| Attribute | Type | Indexed | What it is | Why |
|---|---|---|---|---|
| `parentCaptureKey` | key (32 B) | **yes** | Entity key of the parent `recall.v1.capture` | The reader finds candidate snapshots with `listAttachments(pub, parentCaptureKey)` |
| `urlHash` | key | **yes** | keccak256 of the canonical, lower-cased repository URL, `https://github.com/<owner>/<repo>` | Identifies the repository; differs from the parent's URL hash, which identifies the branch API URL |
| `sha256` | key | **yes** | SHA-256 of the compressed tarball bytes | Cross-checked against the downloaded file; distinct from the Git tree hash |
| `kind` | str | **yes** | Currently `git` | Writers and the reader support only this attachment kind |
| `commitSha` | str | **yes** | Commit ID named in the parent response; 40 lower-case hex digits, without `0x` | Cross-checked against the checked parent capture |
| `treeSha` | str | **yes** | Git tree ID named in the parent response; 40 lower-case hex digits, without `0x` | Must match the tree recomputed from the tarball's files |
| `proofLevel` | i32 | **yes** | Currently `1`, meaning hash-anchored | The reader rejects unsupported levels; this attribute alone is not proof |
| `evidenceRef` | key | no | Swarm reference of the repository tarball | Locates the code bytes, rather than the parent's evidence JSON |
| `batchId` | key | no | Postage batch named for the tarball's upload; all zeros for free gateway storage | Identifies the claimed storage batch; its value is not cryptographically bound to the file |
| `size` | u64 | no | Compressed tarball size in bytes | Cross-checked against the downloaded byte count |
| `contentType` | str | no | File MIME type; the repository upload uses `application/gzip` | Describes the attachment; does not replace parsing and hash checks |

**Ownership and writes.** In the normal approval flow, the capturer's wallet creates the capture
and attachment in one `executeBatch` transaction, using `writeCaptureWithAttachment`. If the
capture already exists, the app can add the attachment separately with `writeAttachment`. Like
other Recall entities, attachments are read-only, but their owner can still delete or transfer
them. The read result exposes `$owner` as `owner` and the immutable `$creator` as `creator`.
`parentCaptureKey` is a claimed link: anyone can write an attachment naming a capture they did
not create. Discovery therefore does not require the attachment's owner or creator to match the
parent's, and verification must not trust the record merely because it names that parent.

**Expiry.** Both write helpers use the shared `ExpirationTime.fromDays(30)` default and
`permissionlessExtension: true`. A batched capture and attachment start with the same expiration
setting. Each remains a separate entity with its own `$expiresAt` block (returned as
`expiresAtBlock`), and anyone may extend it subject to the chain maximum described above.
Keeping the parent record does not by itself retain the attachment record or pay for its Swarm
bytes; Arkiv expiry and Swarm storage lifetime are separate.

**Filters and verification.** `listAttachments` filters on `parentCaptureKey`, orders by `$key`
ascending and pages with `gt('$key', last)`. Its defaults are 100 rows per page and a 500-row
budget, with `truncated` reported. The library also calls `listAllAttachments`, which lists the
attachment schema without a parent or owner filter, using the same paging and a default
1,000-row budget. The other indexed fields above are available for queries; those helpers do
not filter by them.

All returned attributes are unverified claims. The reader checks the parent capture, downloads
the tarball, recomputes its SHA-256, byte count and Git tree, and compares the tree with the
checked parent response. `attachmentMatches` also cross-checks the parent key, repository URL
hash, kind, proof level and commit ID. See [`apps/web/src/attachments/git.ts`](../apps/web/src/attachments/git.ts)
and [`useRepoSnapshot.ts`](../apps/web/src/attachments/useRepoSnapshot.ts). The snapshot inherits
the parent's witness trust assumptions; the attachment record does not independently establish
source authenticity or capture time.

## The queries

```ts
// Every capture of a page (keyset paging on $key, stable while rows are being written):
select().from(CaptureSchema).where(and(eq('urlHash', key(h)), gt('$key', key(last)))).orderBy(asc('$key')).limit(100)
// The same for confirmations (ConfirmationSchema).
// A witness's current URL: only profiles CREATED by that witness count ($creator never changes).
select().from(WitnessSchema).where(eq('witness', addr(w))).createdBy(w)
// Candidate repository snapshots for one capture (the first page):
select().from(AttachmentSchema).where(eq('parentCaptureKey', key(parentKey))).orderBy(asc('$key')).limit(100)
// Later pages add gt('$key', key(last)) alongside the parent filter.
// All attachment records for the library (the first page; no owner filter):
select().from(AttachmentSchema).orderBy(asc('$key')).limit(100)
// Expiry, for check E and keep-alive:
getEntity(key) -> $expiresAt;  getBlockTiming()
```

Run one yourself: `pnpm arkiv:query` (see the [README](../README.md#writer-wallets)).
