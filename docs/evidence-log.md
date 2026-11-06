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

## 2026-11-06 live P1 check: Pages notice captured through the tunnel (UTC)

Setup (`pnpm tunnel:up`, then `pnpm test:live --grep p1`):
- Live witness: container `recall-witness-live` (devnet witness image, commit f43efdb plus the driver-abort guard).
  - Mozilla roots, no dev CA, no dev allow-list.
  - Signer 0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D.
  - Published on 127.0.0.1:7048 only, with TRUST_CF_HEADER=1, MAX_SESSIONS=3 and MAX_SESSIONS_PER_IP=2.
- Tunnel: Cloudflare quick tunnel over http2, host `americans-beautiful-nail-vote.trycloudflare.com` (edge bom12).
- Extension: the release build (name "Recall", no test hook, Mozilla roots), driven through the popup.
  - Settings: witnessUrl = the tunnel URL; pinnedWitnesses = the signer above.

Target: https://localhostwastaken.github.io/Recall/notice/
- TLS 1.2 with ECDHE-RSA-AES128-GCM-SHA256 and an RSA-2048 leaf.
- Chain: Let's Encrypt YR1, then Root YR (cross-signed by ISRG Root X1).
- The identity response has `Content-Length: 373` (not chunked).

Result: checks A, B and C pass (C pinned to the live signer). The body contains "Deadline: 15 December", with bodySha256 0x99bb0a8d8c7026af50281298955f0447def7c5069c66de0566914ffe26932273.

| Run (UTC) | Attempts | Capture time (click to checks done) | Witness traffic in / out | Transcript sent / recv | Evidence JSON |
|---|---|---|---|---|---|
| 01:17:10Z | 1 | 28.9 s | 77.0 MB / 3.7 MB | 366 B / 1092 B | 2690 B |
| 01:18:20Z | 2 (1st hit the extension's 30 s MPC setup timeout) | 22.6 s | 76.9 MB / 3.7 MB | 366 B / 1090 B | 2690 B |
| 01:20:52Z | 1 | 22.5 s | 77.0 MB / 3.7 MB | 366 B / 1098 B | 2698 B |
| 01:22:24Z | 1 | 21.1 s | 77.0 MB / 3.7 MB | 366 B / 1097 B | 2698 B |

- Phases in the witness log (01:20:52Z run):
  - MPC preprocessing took 17.9 s.
  - MPC-TLS with GitHub Pages took 1.8 s; the /proxy relay carried 703 B up and 5832 B down.
  - Verifying and signing took 0.2 s.
- The same capture without the tunnel (witness at http://127.0.0.1:7048) took 5.3 s, with the same ~77 MB in and 3.7 MB out.
- Traffic is the witness container's eth0 counters, before and after the successful attempt.

## Finding: quick tunnel over QUIC stalls bulk WebSocket data

- With cloudflared's default transport (QUIC, UDP 7844), the first live captures stalled.
  - The witness received only ~22 KB after "Accepting MPC TLS commitment", until the extension's 30 s setup timeout.
- A WebSocket sink behind a second quick tunnel showed the same thing.
  - Over QUIC: a 20 MB push delivered 48 KB in 3 min, then failed with HTTP 524.
  - Over `--protocol http2`: the same 20 MB arrived in about 4 s.
- `scripts/tunnel.sh` therefore runs cloudflared with `--protocol http2` (override: TUNNEL_PROTOCOL).
