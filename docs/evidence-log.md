# Evidence log

## 2026-11-05 live P0 checks (UTC)

- Arkiv Rabdi write/read: treasury 0xd46480d1Ec02B8ce92aE383914026efD5F73f835 wrote a capture row.
  entityKey 0x85cb1a39f06c7951096c11cfd43c9cd4e20562c98030435804aabcb92b322708
  txHash 0xae934fc05362ca09ca070532a926a3e947b766d9c901d169f0dd7809fbc33f23 (2026-11-05T22:04:17Z); listByUrl found it.

## 2026-11-05T22:08Z green run (all four @live p0 tests pass)

- Arkiv Rabdi: entityKey 0x700a2e5c3732c1b86eab917777d8d7f87128f7f258c437f1ec6906a3836b99a3
  txHash 0xcfee285f14ddf9713a0dc4067ac9a8e1e32c6476079ff573d5e82a2493608c59 (22:08:34Z); read back via listByUrl.
- Swarm free upload (3000 random bytes) ref 0x9ba562b90a8d47d2541163ce304b841f7f13975752551d916a2b680af2a8c999 (22:08:35Z).
  Served byte-equal, root hash verified locally, by https://download.gateway.ethswarm.org and https://bzz.link (`/bytes/<ref>` works on both).
- POST /chunks with an invalid stamp on api.gateway.ethswarm.org: 400 {"message":"invalid batch id"} (route exists, not 405).
- Pages notice https://localhostwastaken.github.io/Recall/notice/ : 200, contains "15 December", negotiated with maxVersion TLSv1.2 (Actions run 42118827608, success).

## Finding: public gateway multi-chunk upload ref differs from local root

Free `POST /bytes` of 5000 random bytes to api.gateway.ethswarm.org returned a ref that does not equal the
ChunkSplitter root of the same bytes (gateway 074b6b80..., local 2e3bb84f...; second sample 1e2aa99e... vs cc0f6657...).
Single-chunk payloads (<= 4096 B, e.g. 3000 B) match exactly. Downloads returned the full 5000 bytes on all gateways, so the
gateway builds a different tree for multi-chunk uploads (likely redundancy/erasure coding). `downloadBytes` therefore rejects
such refs. Our own client-side stamped `/chunks` upload uses the local chunker, so its refs are locally verifiable; not yet
confirmed live (needs a postage batch, out of scope for this task).
