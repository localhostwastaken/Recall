# Why Arkiv

Recall's whole promise is "you don't have to trust us". The index of captures is the part that
would quietly break that promise if it sat in our own database.

## If we swapped Arkiv for Postgres, what would users lose?

- **The index would have an off switch, and it would be ours.** Whoever runs the database can delete
  a capture, hide it, or stop answering, which is exactly what someone who edited a notice would
  ask for. On Arkiv, a capture is owned by the capturer's wallet; we cannot remove or change it.
- **Verification would depend on a Recall server.** Today the web app (from GitHub Pages, Swarm or
  a local build) and `pnpm arkiv:query` read Arkiv directly. With Postgres, every reader would need
  our API to be up.
- **Anyone could no longer write.** A capture is written by the person who made it, from their own
  wallet, paying their own fee. With Postgres we would be the gatekeeper deciding whose captures get
  in.
- **Keep-alive by strangers would be gone.** `permissionlessExtension` lets anyone who cares about a
  capture extend it. In Postgres, "how long does this record live" is our policy, not the reader's
  choice.
- **Other apps would need our permission to read.** Any app can query `recall.v1.capture` by
  `urlHash`, for example to show "captured versions" next to a link, with no API key from us.
- **Witness discovery would need a server.** The witness announces its own URL as an entity it
  owns; the extension finds it with an owner-filtered query. With Postgres, we would run a
  directory that could point people at a fake witness.

## What we kept off Arkiv, and why

| Kept off | Where instead | Why |
|---|---|---|
| The evidence file (a few KB, up to 64 KB of page) | **Swarm**, referenced by `evidenceRef` | Content-addressed (the reference is the hash, so any gateway can serve it and be checked), cheap for bytes, and paid by a postage batch that anyone can top up. A confirmation is the exception: its evidence is small and goes inline |
| Raw page HTML outside the evidence | nowhere | The evidence is the signed transcript; we never store an unsigned copy that could drift from it |
| The extension's stamp key, pending records, the batch pool | the extension's `chrome.storage.local` | Private keys and work in progress never leave the device |
| Settings (pinned witnesses, endpoints) | the browser's localStorage | Trust is the reader's own choice, per device |
| Which witness to trust | the reader's pin list | An attribute on Arkiv is what someone wrote, not what someone proved; trust comes from the signature check, not from the index |
