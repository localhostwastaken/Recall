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

## 2026-11-06 live P2 check: real batch, stamped gateway upload, Rabdi record (UTC)

Run: `pnpm test:live --grep p2` (`e2e/live/p2-live.spec.ts`), release extension build from commit 0ac96f4 plus the fixes below, live web build (`VITE_RECALL_NET=live`).

Setup:
- Live witness: container `recall-witness-live` recreated from image `recall-witness-live:0ac96f4` (same layers as the devnet image, so the driver-abort guard is in), same key, 127.0.0.1:7048 only, TRUST_CF_HEADER=1. `/info` through the tunnel: signer 0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D, git_hash 0ac96f4.
- Witness profile on Rabdi (`pnpm witness:announce --net live`, Rabdi blocks 277425 and 277430):
  - top-up 0.05 tGLM from the treasury 0xd46480d1Ec02B8ce92aE383914026efD5F73f835: tx 0xf95dabaae0195a12b284c18b5d9c39ff0ac3742eccf798b79fc99f5532bc6fdf;
  - profile entity 0xf7c813892f290fbb35aaa129e04759434b833d4f47d629a6917144ac28aa913a, tx 0x5a7f3b3e47dd042beb0a4cbcabd0f12cb597a06328e83cb497871bdc0a5ab616;
  - `latestWitnessUrl(0xC931…B37D)` returns https://americans-beautiful-nail-vote.trycloudflare.com.
- Extension stamp address (persistent test profile): 0x5455B84fcB0a05C0B68F8262a183D7e28f2a4212.

Postage batch (bought once, 05:06Z, with `buyBatch` from the treasury; the Storage page offers 7 or 30 days, and 7 days cost 0.319 xBZZ, over the 0.2 cap):
- batchId 0xde1b6b808de55064687e6c1ef7eae9aef91d9d9167d44719a2350fb3c6d8dd63, depth 17, bucket depth 16, immutable, 3 days, owner 0x5455B84fcB0a05C0B68F8262a183D7e28f2a4212.
- approve tx 0x57969134d16aff5883a3f163e6f45fa7813889adca1a60e7e50811ab9093325f (block 49134082), createBatch tx 0x603c269cf0fbe031e1a58a91bdb1e2a9281209fb6fb16e25d41cfb1b81a44cd4 (block 49134085).
- Cost 0.1367189760376832 xBZZ, fees 9.4e-12 xDAI. Handed to the extension with `recall.addBatches` (the external API, from the app origin).
- Usable by the chain rule (12 blocks after the batch block) right away on reruns; the gateway's `/batches` never listed it in 60 s windows, and the upload was accepted anyway.

Green run (06:10Z):
- Page: https://localhostwastaken.github.io/Recall/notice/?run=0tzgmo55 (the query keeps every run a fresh URL).
- Witness: the popup showed "Witness online" with no witness URL in settings, so it found the tunnel URL from the Arkiv profile.
- Capture: two attempts through the tunnel failed (`setupProver timed out after 90000ms`; see the finding below). The third went to the same live witness on 127.0.0.1:7048 (test fallback). Checks A, B and C pass, C pinned to the live signer. The job (capture, lookup on Rabdi, upload) took 20.1 s.
- Upload: client-side stamped chunks, `POST https://api.gateway.ethswarm.org/chunks`.
  - evidenceRef 0x4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202, 2723 bytes.
  - Batch 0xde1b…dd63 (reused under the spend cap; its stamper state was kept, so no stamp slot was reused).
- Approval tab (opened by the extension, served from the live web build at https://localhostwastaken.github.io/Recall/app/): mock wallet with the treasury key, Connect, Switch to Arkiv Rabdi, Publish. The page re-ran A to C and the Swarm root check itself. Publishing took 13 s.
  - entityKey 0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244
  - tx 0x512ad75ec7002990307ba29f763d2e3f9aa343b851abc4b39e6ab89bf4175d4f (Rabdi block 279811, fee 0.000201535 tGLM)
  - owner 0xd46480d1Ec02B8ce92aE383914026efD5F73f835; urlHash 0x1dcb2cebcb3bd31e55a91320ca7523c83abc0faaad0b5b32c0cdd4ecce872540; bodySha256 0x99bb0a8d8c7026af50281298955f0447def7c5069c66de0566914ffe26932273; signedAt 1793945366.
  - `listByUrl` on Rabdi finds it; the extension's pending copy is gone (markPublished).
- Downloads, each gateway on its own, root-checked, then checks A to C plus the record cross-check (urlHash, bodySha256, witness, signedAt):
  - https://download.gateway.ethswarm.org/bytes/4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202: 2723 bytes in 2.7 s.
  - https://bzz.link/bytes/4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202: 2723 bytes in 1.5 s, byte-equal.
  - The CID form https://bah5acgzajxphed5hafm7jyzv4fs2fofzhnnoyq42zh25xudm6oeyk25rgiba.bzz.link/ answers 404: bzz.link's subdomain form serves manifests (`/bzz`), and the evidence is raw bytes.

Earlier run (05:59Z) that got as far as the download (the test then failed on its own report formatting):
- Page …/notice/?run=xbvmqf0p; entityKey 0x6c488161621f449b4b21f165f9717a9c2da183ea45a7da28a4eb3084ca88123c; evidenceRef 0xd2e1d35391f0eec3c238918471adcded6e121b517b5b72560c34da1815cc6b1c; same batch; signedAt 1793944871.

Spend for the whole check: 0.1367189760376832 xBZZ, about 9.4e-12 xDAI, about 0.0504 tGLM (0.05 of it now in the witness wallet for its profile writes; 0.0001507 tGLM paid by the witness for the profile).

Manual: real MetaMask approval: pending user.

## Finding: the quick tunnel cannot carry a capture on a slow venue link

- Each capture moves about 77 MB from the browser to the witness during MPC setup. Through the quick tunnel that traffic leaves this Mac and comes back (browser → Cloudflare → cloudflared on the same Mac), so it crosses the uplink and the downlink.
- At 05:48Z to 06:11Z networkQuality measured 5.5/4.6, 16.7/5.0 and 21.3/0.7 Mbps (up/down), against 102/42 at P1. Every capture through the tunnel in that window hit the extension's 90 s setup limit (7 attempts), or lost the connection.
- cloudflared also dropped its single edge connection for 5 to 60 s about every 5 to 10 minutes (05:12, 05:24, 05:25, 05:32, 05:33Z).
- Chromium's QUIC attempts made the tunnel's `/info` slow (6.5 s cold, versus 1.4 s with `--disable-quic`), so the live spec runs Chromium with `--disable-quic`. The extension's witness probe now allows 6 s (it was 2 s).
- The P1 regression (`pnpm test:live --grep p1`, 06:11 to 06:15Z, tunnel only) failed the same way: both attempts ended with `setupProver timed out after 90000ms`.
- The same live witness on 127.0.0.1:7048 captured in about 5 s. For the demo, run the witness on a machine with a good link (or capture on another machine), and re-run `pnpm test:live --grep p1` once the network is fast again.
