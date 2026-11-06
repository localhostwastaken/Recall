# Demo script (3 minutes)

The video tells one story: a university quietly moves a deadline from "15 December" to
"12 December", Recall proves both versions, and the proof survives when our witness, our
website and even the internet connection are gone.

## Opening: why bitchat

The recorded video (`pnpm demo:record`, `e2e/demo/record-demo.ts`) opens on the bitchat case, then
captures that repository:

1. Title card: "July 2026: India ordered GitHub to block the bitchat repositories within 3 hours."
   Small: "Source: CyberInsider, 24 Jul 2026". Then: "Recall keeps verifiable proof of exactly what
   this code was."
2. github.com/permissionlesstech/bitchat, captioned "This is the repository the order named. Can we
   prove what it contained today?"
3. End card: "A takedown can hide the original. It can't erase verifiable proof of exactly what the
   code was."

The facts, if asked: at 11:16 pm on 23 July 2026, India's Indian Cyber Crime Coordination Centre
(I4C, Ministry of Home Affairs) ordered GitHub to disable access to three bitchat repositories within
3 hours, including github.com/permissionlesstech/bitchat, citing Section 79(3)(b) of the IT Act, 2000
and Rule 3(1)(d) of the IT Rules (the Bluetooth mesh app could be used during internet shutdowns and
impedes lawful interception). Jack Dorsey on X: "the government of india does not like technologies
like bitchat and wants it taken down." The Internet Freedom Foundation called the order
"unconstitutional and authoritarian". Don't say the repository was taken down or that GitHub
complied (unconfirmed), and don't say Recall defeats takedowns. Sources:
[CyberInsider, 24 Jul 2026](https://cyberinsider.com/github-ordered-to-remove-decentralized-messaging-app-bitchat-in-india/),
[The Cyber Sec Guru](https://thecybersecguru.com/news/india-github-bitchat-repository-takedown/).

Rehearse steps 6 to 9 any time with `pnpm test:live --grep crops` (`e2e/live/p5-crops.spec.ts`).
`RECALL_P5_STOP_WITNESS=1` makes it stop and restart the real witness container, as step 6 does.

**Where:** **[Mac]** = the Mac that runs Docker (the live witness `recall-witness-live` on
127.0.0.1:7048, the Cloudflare tunnel and the Swarm reader node) and has the Recall extension and
MetaMask. **[Any]** = any computer with a browser. Record everything on the Mac; the [Any] steps are
the ones a teammate could also show from their own laptop.

## Links

| What | URL |
|---|---|
| The notice | https://localhostwastaken.github.io/Recall/notice/ |
| The app (GitHub Pages) | https://localhostwastaken.github.io/Recall/app/ |
| The notice's timeline | https://localhostwastaken.github.io/Recall/app/#/u/0xf5263ed0b125a3d814134d832ca97e9783bbbbfa854b7e8367b52e5d669a61e7 |
| Edit the notice on GitHub | https://github.com/localhostwastaken/Recall/edit/main/site/notice/index.html |
| Pages deploys | https://github.com/localhostwastaken/Recall/actions/workflows/pages.yml |
| The app on Swarm, through our own node | http://127.0.0.1:1733/bzz/e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0/ |
| The app on Swarm, through bzz.link (only once the Swarm team allowlists it) | https://bah5qcgza4abotkyl5zipq5fi5zdb7yctvstry7r34ublsqoysmyary2x7hqa.bzz.link/ |

Why our own Swarm node: no public gateway shows the app in a browser yet.
download.gateway.ethswarm.org sends every file with `Content-Disposition: attachment`, so Chrome
saves `download.html` instead of opening the app. bzz.link and api.gateway redirect to
`/forbidden` until the hash is allowlisted. `scripts/swarm-reader.sh` starts a Swarm node in
ultra-light mode (no wallet, no funds). It reads the app straight from the Swarm network.

## Before recording (about 30 minutes ahead)

1. **[Mac] Witness.** Start Docker Desktop, then run:
   ```bash
   cd ~/Code/Eth-2026/recall
   docker ps --format '{{.Names}} {{.Status}}' | grep recall-witness-live
   curl -s http://127.0.0.1:7048/info                              # "signer":"0xC9319e18…D37D"
   curl -s "$(grep '^WITNESS_PUBLIC_URL=' .env.local | cut -d= -f2-)/info"   # same signer
   ```
   If the container is missing, run `pnpm tunnel:up`. That gives a new tunnel URL, so also run
   `pnpm witness:announce --net live` (it costs about 0.0002 tGLM).
2. **[Mac] Swarm reader node.** Run `bash scripts/swarm-reader.sh`. The first time it pulls
   `ethersphere/bee:2.8.1`, and it takes about 1 minute in all. Open the URL it prints once, so the
   app is already cached by the node.
3. **[Mac] The notice says 15 December.** Run
   `curl -s https://localhostwastaken.github.io/Recall/notice/ | grep deadline`. If it says 12, use
   "Reset the notice" below and wait for the deploy.
4. **[Mac] Chrome.**
   - Use one profile with the Recall extension (pinned to the toolbar) and MetaMask (unlocked).
   - In the app's Settings, the extension ID is saved and shows Connected.
   - Hide the bookmarks bar, set zoom to 125%, close other tabs and turn on Do Not Disturb.
5. **[Mac] Storage for two captures.** Each capture uses one prepaid batch. Open the Recall popup.
   If it says "No storage left", or you have fewer than 3 unused batches (2 for the take plus 1
   spare), open the app's Storage page and click Connect. Then set Number of batches, pick 7 days
   and click Buy. Each 7-day batch costs about 0.32 xBZZ. The fallback is extension Settings, Upload
   mode, "Gateway free storage". It needs no batch, but keep-alive doesn't work for those captures.
6. **[Mac] Rehearse once, off camera**, on https://localhostwastaken.github.io/Recall/notice/?try=1:
   - Click Capture this page, then Publish record in the approval tab, then confirm in MetaMask.
   - This connects MetaMask to the app and adds Arkiv Rabdi, so on camera you only click Publish
     record and confirm.
   - GitHub Pages ignores `?try=1`, but Recall treats it as its own page with its own timeline, so
     the real notice stays clean.
   - **If the capture fails with "timed out"**, the network is too slow for the tunnel. Each capture
     sends about 77 MB through Cloudflare and back. Point the extension at the witness on this Mac
     instead. In the extension's Settings:
     1. Set Witness URL to `http://127.0.0.1:7048`.
     2. Under Trusted witnesses, remove `0xC931…D37D`.
     3. Add `0x000000000000000000000000000000000000dEaD`, then add
        `0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D` again.
     4. Click Save settings.

     The first witness on the list is the one looked up on Arkiv. The placeholder has no announced
     address, so the extension uses the Witness URL. Check C still requires the real witness's
     signature. Undo this after recording.
7. **[Mac] Which page to capture on camera.** The plain notice URL had no captures on 6 Nov
   (about 11:45 UTC). Keep it for the final take. If a take fails after the first publish, don't
   reuse the plain URL: reset the notice and record the next take on `notice/?take=2`, then
   `?take=3`. Each query gives a fresh timeline.
8. **[Mac] Open these tabs** in this order:
   1. The notice.
   2. The app's Home page.
   3. The GitHub editor of `site/notice/index.html` (signed in).
   4. A terminal, cd'd to the repo, with large text.

## Run of order

Target: 2:55. Speed up the waits in editing: the capture progress (about 20 to 30 s) to 4x,
publishing (about 15 s) to 2x, and cut the Pages deploy (about 1 minute) completely.

| Time | Where | On screen: exact clicks | Say |
|---|---|---|---|
| 0:00–0:12 | [Mac] | Notice tab. Point at "Deadline: 15 December". | "Official notices get edited quietly. Here's a deadline: 15 December." |
| 0:12–0:40 | [Mac] | 1. Click the Recall icon. The popup shows "Witness online" and, under Earlier captures, "No captures of this page yet."<br>2. Click **Capture this page**. The steps tick by (speed up), then "Checks passed" and "Evidence uploaded".<br>3. The approval tab opens by itself. Click **Publish record** and confirm in MetaMask. "Published" appears. | "Recall fetches the page together with an independent witness, which signs what the server sent. The evidence goes to Swarm. One MetaMask transaction indexes it on Arkiv." |
| 0:40–0:55 | [Mac] | 1. Switch to the GitHub editor tab and change `15 December` to `12 December`.<br>2. Click **Commit changes…**, keep "Commit directly to the main branch", then click **Commit changes**.<br>3. Cut to after the Pages deploy is green (about 40 to 75 s).<br>4. On the notice tab press **Cmd+Shift+R**. It shows "Deadline: 12 December". | "Now the university moves the deadline, and the old page is gone." |
| 0:55–1:20 | [Mac] | 1. Click the Recall icon. Earlier captures shows "1 version · 0 confirmations".<br>2. Click **Capture this page** (speed up), then "Evidence uploaded".<br>3. In the approval tab, click **Publish record**, confirm, wait for "Published", then click **View timeline**. | "Capture it again." |
| 1:20–1:45 | [Any] | 1. The timeline shows Version 1 and Version 2.<br>2. Scroll to "What changed: Version 1 → Version 2": 15 is struck out and 12 is added.<br>3. Click Version 1. Checks A, B, C and E pass, and the page reads "15 December". | "Anyone can see both versions and exactly what changed. Every check runs in the browser, from Arkiv and Swarm." |
| 1:45–2:10 | [Mac] | 1. Terminal: `docker stop recall-witness-live`.<br>2. Click the Recall icon. After a few seconds it shows **Witness offline**: "New captures are paused until the witness is back." **Capture this page** is greyed out.<br>3. Switch to the app tab and press Cmd+R on Version 1. A, B and C pass again. | "Now our witness goes down. New captures pause, but every existing capture still verifies, because the app never needs the witness." |
| 2:10–2:35 | [Any] | 1. On Version 2, click **Download evidence file**.<br>2. Click Recall (Home).<br>3. Turn Wi-Fi off from the menu bar.<br>4. Drag the downloaded `recall-….json` onto "Drop an evidence file to verify".<br>5. A, B and C pass, E shows "not checked", and the notice reads "Checked offline. A–C ran in your browser; storage (E) was not checked." | "Even with no internet at all, the file proves itself." |
| 2:35–2:52 | [Mac] | 1. Turn Wi-Fi on.<br>2. Open the Swarm URL from Links and add `#/u/0xf5263ed0b125a3d814134d832ca97e9783bbbbfa854b7e8367b52e5d669a61e7`. For a `?take=N` take, copy the `#/u/…` part from the Pages timeline instead.<br>3. The same timeline and checks appear, served by Swarm, not GitHub. | "And if our website disappears, the app itself lives on Swarm. Same timeline, no server of ours." |
| 2:52–3:00 | — | The app tab with the green checks. | "Recall: prove what a page said, long after it changes." |

Fallbacks, so the take keeps going:

- **The Pages deploy is slow.** Cut, and wait until
  `curl -s https://localhostwastaken.github.io/Recall/notice/ | grep deadline` says 12. The capture
  reads the page from GitHub's servers, not from the browser cache.
- **The capture says "timed out".** Click **Try again** once, then switch to the local witness
  (Before recording, step 6).
- **The popup shows "Witness offline" while the witness is up.** The first popup after a browser
  start can miss the Arkiv lookup. Close the popup and open it again.
- **You reloaded the app tab while Wi-Fi was off.** It won't load. Turn Wi-Fi on, open Home,
  turn it off again and drop the file. The app is already loaded, so it needs nothing more.

## After recording

1. **[Mac] Start the witness again:** `docker start recall-witness-live`, then
   `curl -s http://127.0.0.1:7048/info` and the tunnel `/info` from step 1. Both must show the
   signer. The tunnel URL does not change, so no new announcement is needed.
2. **[Mac] Undo the local-witness settings**, if you used them: remove `0x…dEaD`, clear Witness URL
   and click Save settings.
3. **Leave the notice at 12 December**, so the live page matches the video and the judges' timeline.
   Reset it only between takes, or before you re-run `pnpm test:live --grep "p1|p2"`: those checks
   expect "15 December".
4. Keep the Swarm reader running while judging, or stop it: `bash scripts/swarm-reader.sh stop`.

## Edit or reset the notice from the terminal (instead of the GitHub editor)

One file changes, and Pages redeploys in about 1 minute (39 to 73 s on 6 Nov). Only
`site/notice/index.html` is committed, whatever else is in the working tree.

```bash
cd ~/Code/Eth-2026/recall && git pull --ff-only
# Edit (15 -> 12):
sed -i '' 's/Deadline: 15 December/Deadline: 12 December/' site/notice/index.html
git commit -m "notice: move the deadline to 12 December" -- site/notice/index.html && git push
# Reset the notice (12 -> 15):
sed -i '' 's/Deadline: 12 December/Deadline: 15 December/' site/notice/index.html
git commit -m "notice: restore the 15 December deadline" -- site/notice/index.html && git push
```

After an edit in the GitHub web editor, run `git pull --ff-only` before your next local push.
