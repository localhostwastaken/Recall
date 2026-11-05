# Recall UI/UX design brief (v1, 2026-11-06)

Method: `ui-ux-pro-max` design-system search, then domain searches (style, colour, typography, ux), then a contrast check of every token pair below.
- **Style chosen:** "Minimalism & Swiss Style" (rated WCAG AAA, low complexity, suits documentation/tools), given archive cues: a paper background, thin rules, labelled metadata, serif exhibit titles and mono hashes. In one phrase: **court exhibit, not crypto dashboard**.
- **Overridden:** the tool's first picks ("Exaggerated Minimalism", "Data-Dense Dashboard"), its orange CTA (#F97316) and its Google font pairings (EB Garamond/Lato, Newsreader/Roboto). We have a no-web-fonts rule, so the type uses system stacks with the same mood. The palette comes from the tool's "Legal Services" navy and "Government/Public Service" neutrals.
- **Build:** one shared `tokens.css` + `base.css` + about 15 plain-CSS React components, used by both the extension popup and the web app. Use native `<dialog>`, `<details>`, `<progress>` and `<input type=file>`. No UI framework. Icons: `lucide-react`, bundled at build time and never loaded from a CDN. Stroke 1.75, sizes 16/20.

## 1. Design principles
1. **Evidence first, claims second.** Show what was observed (site, URL, time, bytes, witness) before any verdict. Every verdict names the check behind it.
2. **Green is earned.** A pass colour/icon appears only next to a check that ran and passed. If a check is unknown, skipped or still loading, it is never green.
3. **Plain words, exact facts.** No jargon in primary copy ("witness", not "notary"; "storage", not "postage batch"). Hashes and addresses go behind "Details".
4. **Works when we're gone.** Verification needs no Recall server. Say so where it matters (drop zone, witness offline, footer).
5. **Calm and keyboard-complete.** One primary action per screen, no decorative motion, full keyboard paths, and status shown by icon + text + colour.

## 2. Tokens (`tokens.css`)
Light is the default; `[data-theme=dark]` or `prefers-color-scheme: dark` switches the theme. Contrast was checked with a WCAG script. Text and status pairs are all ≥ 5.2:1. `--border` is for decoration only. Inputs and controls use `--border-strong` (≥ 3.1:1).
```css
:root {
  --bg:#F6F5F1; --surface:#FFFFFF; --surface-sunken:#EDECE7; --surface-raised:#FFFFFF;
  --text:#16181C; --text-muted:#4A4F57; --border:#D6D3CB; --border-strong:#8C8A83;
  --accent:#1F3A80; --accent-hover:#172D63; --on-accent:#FFFFFF; --focus:#1D4ED8;
  --pass:#17673A; --pass-bg:#E6F2EA;  --fail:#B3261E; --fail-bg:#FCEBE9;
  --warn:#8A4B00; --warn-bg:#FCF1DE;  --na:#575C64;   --na-bg:#ECEBE6;
  --info:#1F4FA8; --info-bg:#E7EEFA;  --diff-add-bg:#DDF0E3; --diff-rem-bg:#FAE1DE;
  --danger:#B3261E; --on-danger:#FFFFFF; --scrim:rgb(0 0 0 / .5);
  --shadow-1:0 1px 2px rgb(0 0 0 / .06); --shadow-2:0 8px 24px rgb(0 0 0 / .16);
}
[data-theme=dark] {
  --bg:#111316; --surface:#191C20; --surface-sunken:#0C0E10; --surface-raised:#20242A;
  --text:#ECEAE4; --text-muted:#A9AEB6; --border:#33373E; --border-strong:#6B7079;
  --accent:#A8BDF2; --accent-hover:#C2D1F7; --on-accent:#0E1A3A; --focus:#8FB0FF;
  --pass:#6FCF8F; --pass-bg:#11291B;  --fail:#FF8F85; --fail-bg:#341614;
  --warn:#F0B65A; --warn-bg:#2E2210;  --na:#A9AEB6;   --na-bg:#23262B;
  --info:#93B2FF; --info-bg:#15213A;  --diff-add-bg:#123020; --diff-rem-bg:#3A1714;
  --danger:#FF8F85; --on-danger:#2A0A07; --scrim:rgb(0 0 0 / .6);
  --shadow-1:none; --shadow-2:0 8px 24px rgb(0 0 0 / .5);
}
```
**Status pairs.** Every status = icon + word + colour, on its `-bg` tint with a 1px border in the same hue.

| Status | Token | Lucide icon | Badge word | Used for |
|---|---|---|---|---|
| pass | `--pass` | `CircleCheck` | Passed | a check that ran and passed; "Published" after a confirmed receipt |
| fail | `--fail` | `CircleX` | Failed | a check that ran and failed; tamper; invalid signature |
| warn | `--warn` | `TriangleAlert` | Warning | unknown witness, HTTP non-200, expiring in < 7 days, spam notice |
| unavailable | `--na` | `CircleDashed` | Not checked | could not run (offline, RPC down, no file given) |
| pending | `--info` | `LoaderCircle` (spins; static if reduced motion) | Checking… | a check in progress |
| info | `--info` | `Info` | (none) | neutral notices |

**Type.**
- `--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif`
- `--font-serif: ui-serif, "Iowan Old Style", Charter, "Palatino Linotype", Georgia, serif`. Use it only for h1/h2 and exhibit titles.
- `--font-mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`. Use it for URLs, hashes, addresses and sizes, with `font-variant-numeric: tabular-nums` on all times and numbers.
- Scale (size/line-height): `--text-xs` 12/16 (mono metadata only), `--text-sm` 14/20, `--text-md` 16/24 (web body), `--text-lg` 18/26, `--text-xl` 20/28, `--text-2xl` 24/32, `--text-3xl` 32/40.
- Weights are 400 and 600 only. The popup body is `--text-sm`; popup headings are `--text-md`/600. Section labels use `--text-xs`, uppercase, letter-spacing .06em, `--text-muted`.

**Spacing, shape, motion and layout.**
- Spacing: `--space-1` 4, `-2` 8, `-3` 12, `-4` 16, `-5` 24, `-6` 32, `-7` 48, `-8` 64 (px).
- Radius: `--radius-1` 4px (buttons, inputs, badges), `--radius-2` 8px (cards, dialogs). No pills and no gradients.
- Shadows: cards use a border, not a shadow. `--shadow-1` is for the sticky header; `--shadow-2` is for the dialog/popover only.
- Motion: `--dur-fast` 120ms, `--dur-base` 200ms, `--ease-out` cubic-bezier(.2,.8,.2,1). Under `prefers-reduced-motion`, set durations to 0 and stop spinners. The progress text still updates.
- Layout: `--measure` 68ch; `--page-max` 64rem; breakpoints 600 / 960px; `--control-h` 44px web, 40px popup; z-index `--z-header` 10, `--z-dialog` 100, `--z-toast` 200.
- Focus: `outline: 2px solid var(--focus); outline-offset: 2px` on every interactive element. Never remove it.

## 3. Components (each lists its required states)
- **Button** (primary / secondary / ghost / danger)
  - States: default, hover, active, focus-visible, disabled (`disabled` attr, .45 opacity, reason shown in helper text), loading.
  - Loading keeps the width, shows a spinner, swaps the label ("Capture this page" → "Capturing…") and sets `aria-busy`.
- **StatusBadge**: pass / fail / warn / unavailable / pending (table above). The icon is `aria-hidden`; the word is the accessible name.
- **CheckRow**: letter (A–E), title, badge and a one-line result. `<details>` holds "How this was checked" with the hashes. States: pending → one final status.
- **Notice**: info / warn / error / success. Errors use `role="alert"`, the others `role="status"`. Each notice has a title, a body and ≤ 2 actions. Notices never auto-dismiss.
- **Steps**: a numbered list (`<ol>`). Each step is waiting / active / done / failed / skipped, and shows "Step 2 of 3" text. Used in the popup, Approve and Keep-alive.
- **Progress**: `<progress>`. It is determinate when the MB count is known, otherwise indeterminate. It always has a text twin ("0:12 elapsed · 11 MB of ~30 MB").
- **ExhibitCard**: a `<dl>` of Site, Address, Captured, Size, HTTP status, Witness, Evidence. It has a hairline frame, a serif title and a "Copy" button for each mono value.
- **MonoValue**: middle-truncated (`0x12ab…9f3c`). The full value is in `title` and `aria-label`. Copying shows the toast "Copied".
- **Field**: visible label, helper text, error text below the field (`aria-describedby`), validated on blur. Secret fields have a "Show" toggle. States: default, focus, invalid, disabled, read-only.
- **Segmented** (radio group): 7 days / 30 days; System / Light / Dark.
- **Switch**: "Show unverified (n)" (`role="switch"`, `aria-checked`).
- **Dialog**: native `<dialog>` with a focus trap, Esc to close, focus returned to the trigger, and the scrim. While a wallet step is pending, closing asks "Leave? Steps already confirmed in MetaMask stay done."
- **DropZone**: a labelled region plus a "Choose file" button (keyboard path). States: idle, drag-over (2px dashed `--focus` border), reading, invalid file.
- **TimelineItem**: the kinds are version, confirmation and unverified. Each has a date rail, a title, meta and a badge, and the whole row is a link.
- **DiffView**: inline or side-by-side. Removed text uses `<del>` (strikethrough, `--diff-rem-bg`, "−" gutter); added text uses `<ins>` (underline, `--diff-add-bg`, "+" gutter). Visually hidden "removed:" / "added:" labels keep it readable without colour.
- **WalletChip**: Not connected / Connected 0xab…12 · Arkiv Rabdi / Wrong network.
- **WitnessChip**: Checking… / Witness online / Witness offline.
- **Shared basics**: Toast (`aria-live="polite"`, 4s, copy confirmations only), Skeleton (lists > 300ms), EmptyState (message + one action).
- **Web shell**: header with "Recall", nav "Home · Settings", WalletChip and theme menu; skip link "Skip to content". Hash routes: `#/` home, `#/url/:urlHash` timeline, `#/capture/:key` detail, `#/approve`, `#/storage`, `#/settings`. On each route change, focus moves to the h1.

## 4. Surfaces: layout and exact copy
Formats used in all copy:
- Dates: `4 Nov 2026, 14:02 UTC`, with local time on hover/`title`.
- Sizes: `18.2 KB`. Placeholders: `<host>`, `<date>`, `<n>`.

**4.1 Extension popup (360×560).**
- Layout:
  - Header 48px: "Recall" + WitnessChip.
  - Body scrolls: "THIS PAGE" (host in 600 weight, then the URL in mono, 2 lines max), a rule, then "EARLIER CAPTURES".
  - Sticky footer 72px: the primary button + helper text.
  - Progress and errors replace the "EARLIER CAPTURES" block. The page context stays visible.
- Earlier captures: loaded "<n> versions · <m> confirmations" / "Latest: <date>" / link "View timeline"; none "No captures of this page yet."; loading = skeleton; error "Couldn't load earlier captures. You can still capture this page."
- Witness: "Checking witness…" / "Witness online" / "Witness offline".
- Button "Capture this page"; helper "Takes about 30 s and ~30 MB of data. Pages up to 64 KB."; disabled on non-https tabs with "Only https:// pages can be captured."
- Progress (Steps + Progress): 1 "Connecting to the witness" → 2 "Proving the page with the witness" ("0:12 elapsed · usually 15–30 s") → 3 "Checking the witness signature" → 4 "Uploading evidence to Swarm" → 5 "Opening the approval tab". Secondary [Cancel capture]; note "You can close this popup. The capture keeps running."
- Errors (title / body / actions). Every error that stops a capture ends with "Nothing was published."
  - **Too large:** "Page too large" / "This page is <size>. Recall can capture pages up to 64 KB for now." / [OK]
  - **TLS:** "This site can't be captured" / "<host> doesn't support TLS 1.2, which the witness needs." / [OK]
  - **Witness offline:** "Witness offline" / "New captures are paused until the witness is back. Existing captures can still be verified by anyone." / [Try again] [Witness settings]
  - **No storage:** "No storage left" / "Your prepaid storage is used up. Buy more to keep capturing." / [Buy storage] (opens `#/storage`)
  - **Generic:** "Capture failed" / "<reason>." / [Try again] [Copy details]
  - **Cancelled:** "Capture cancelled. Nothing was published."
- Identical body (info, not an error): "Unchanged since <date>" / "This page is byte-for-byte the same as your capture from <date>. You can publish a confirmation that it was still unchanged today. No new upload is needed." / [Publish confirmation] [Keep earlier capture alive].
- Success: "Evidence uploaded" / "Finish in the approval tab to publish the record." The approval tab opens automatically. Fallback button: "Open approval tab".

**4.2 Approve (`#/approve`).**
- Layout: h1 "Publish this capture" (or "Publish this confirmation"), the ExhibitCard, a "What this proves" box, Steps (Connect → Network → Publish) and a sticky action bar.
- What this proves: "The witness saw these exact bytes from <host> at <date>. It does not show that the content is true."
- Witness row: "Recall Witness · 0x12ab…9f3c · In your trusted list" (pass), or "Unknown witness" (warn).
- Connect: [Connect MetaMask]; missing: "MetaMask not found. Install it, then reload this page."
- Wrong network: "MetaMask is on <network>. Records are published on Arkiv (Rabdi)." / [Switch to Arkiv Rabdi]
- Ready: [Publish record]; helper "MetaMask will show the network fee. The record lasts 30 days; anyone can extend it."
- Signing: button "Confirm in MetaMask…" (disabled), then "Publishing… waiting for the network". No pass state before the receipt.
- Rejected (warn): "Not published" / "You rejected the request in MetaMask. Your capture is kept as pending in the extension, so you can retry any time." / [Try again] [Discard capture]. Discard is the danger button and asks to confirm: "Discard this capture? The uploaded evidence stays on Swarm but won't be listed."
- Failed: "Publishing failed" / "<reason>. Your capture is still pending." / [Try again]
- Success (pass): "Published" / "Record on Arkiv until <date>." / [View timeline] [View this capture]
- No pending capture: "No capture waiting for approval. Start a capture from the Recall extension."

**4.3 Home (`#/`).**
- Header: h1 "Recall"; lede "Prove what a web page said, even after it changes."
- Search: label "Page address", placeholder `https://example.org/notice`, [Show captures]; invalid "Enter a full address starting with https://"
- DropZone: "Drop an evidence file to verify" / "Works offline. The file never leaves your browser." / [Choose file]; wrong file "This isn't a Recall evidence file. Choose the .json file you downloaded from Recall."
- Footer: "No trackers. Verification runs in your browser. TLSNotary alpha (unaudited) · testnet."

**4.4 Timeline (`#/url/:urlHash`).**
- Header: h1 = host; subtitle = full URL (mono); summary "<n> versions · <m> confirmations · first captured <date>"; [Copy link].
- Items load metadata from Arkiv, then each item is checked (A–C) in the browser. Until then it shows pending "Checking…". Default view shows only items whose A–C passed. Displayed text and dates come from the verified evidence, never from Arkiv index fields.
- Version item: "Version 3 · <date>" / "18.2 KB · HTTP 200 · Recall Witness" / badge "Passed".
- Confirmation item: indented under its version: "Still unchanged on <date>" (pass icon). It never says "never changed".
- Diff block between consecutive versions: heading "What changed: Version 2 (1 Nov) → Version 3 (4 Nov)"; controls "Compare [Version ▾] with [Version ▾]" · Inline / Side by side; caption "Text only. HTML tags and whitespace-only changes are ignored." Example: `Deadline: ~~15 December~~ 12 December`.
- Spam notice (warn, shown when the query hits its limit): "Results may be incomplete" / "Showing the newest <n> records. Anyone can publish records for any address, so spam can push real captures out of this list. To check one capture directly, open its link or drop its evidence file."
- Switch: "Show unverified (<n>)". Unverified items show their failing badge and reason: "Unknown witness", "Signature invalid", "Bytes don't match", "Evidence couldn't be downloaded".
- Empty: "No captures of this page yet." / "Capture it with the Recall extension."
- Error: "Couldn't reach Arkiv." / [Retry] [Check settings]

**4.5 Capture detail (`#/capture/:key`).**
- Layout: ExhibitCard (top) → Verdict line → Check panel A–E → Preview → actions [Download evidence file] [Keep alive…] [Copy link].
- Verdict comes from A, B, C (plus D if a file was given). E never counts toward it.
  - All passed: "Checks passed. The witness saw these exact bytes from <host> at <date>."
  - Any failed: "A check failed. Don't rely on this capture."
  - C warn only: "Valid signature, but from a witness you haven't trusted."
  - Any unavailable: "Couldn't fully verify." (na; never green)

| | Title | Passed | Failed / Warning / Not checked |
|---|---|---|---|
| A | Bytes match the signed hashes | "The evidence matches the hashes the witness signed." | F: "The evidence was changed after signing." |
| B | Request and response are well-formed | "GET <url> to <host>, no cookies sent, complete response (HTTP 200)." | F: "The request doesn't match the address claimed." W: "The witness saw HTTP <code>, not a normal page." |
| C | Signed by a trusted witness | "Signed by <label> (0x12ab…9f3c), which is in your trusted list." | F: "The signature is invalid." W: "Signed by an unknown witness 0x…. Trust it only if you trust its operator." [Witness settings] |
| D | Your file matches | "Your file matches this capture (sha256 3f9a…)." | F: "Your file is different from this capture." N: "No file given. Drop a file to compare." |
| E | Storage | "Evidence paid on Swarm until <date> · record on Arkiv until <date>." | W: "Expires in <n> days. Keep it alive or download the evidence file." N: "Storage status not checked (offline or RPC unreachable)." |

- Preview heading "Preview of the captured bytes"; caption "Sandboxed: scripts and outside resources are blocked, so it may look plain." HTML in `<iframe sandbox="">`, PDF in a sandboxed blob; fallback "No preview for this file type." / [Download evidence file].
- Offline (dropped file): an info notice "Checked offline. A–C ran in your browser; storage (E) was not checked."

**4.6 Keep-alive dialog.**
- Title "Keep this capture available"; body "Anyone can pay to keep evidence online. This extends the Swarm storage and the Arkiv record."; Segmented "7 days" / "30 days".
- Cost preview: "Storage: <x> xBZZ on Gnosis · network fees ~<y> xDAI · Arkiv fee shown in MetaMask" / "New end dates: Swarm <date> · Arkiv <date>".
- Steps: 1 "Top up storage (Gnosis)" (note "MetaMask may ask twice: approve xBZZ, then top up.") → 2 "Extend record (Arkiv Rabdi)". Buttons [Start: step 1 of 2] [Cancel], then [Continue: step 2 of 2].
- Errors: "Not enough xBZZ. You need <x> xBZZ on Gnosis." · rejected "Step <k> cancelled in MetaMask. Nothing more was charged." [Try again] · partial "Storage extended to <date>. The record wasn't extended yet." [Retry step 2]
- Success: "Kept alive until <date>." [Done]

**4.7 Buy storage (`#/storage`).**
- Lede: "Each capture uses one prepaid storage batch, owned by your extension's stamp key."
- Owner row: "Owner (extension): 0xab…12". If no extension is found: "Recall extension not found. Install it, or set its ID in Settings."
- Field "Number of batches" (1–20, default 5), helper "One batch = one capture."; preview "<n> × <x> xBZZ = <total> xBZZ + network fees ~<y> xDAI"; [Buy <n> batches].
- Progress: "Buying batch 2 of 5…", then "Waiting for batches to become usable (about 1–2 min)", with a per-batch list.
- Success "<n> batches ready. You can make <n> more captures." · partial "3 of 5 bought." [Buy remaining 2]

**4.8 Settings (`#/settings`).**
- Note: "Saved in this browser only."
- **Trusted witnesses:** list of label + MonoValue + [Remove] (default "Recall Witness (default)"); add form "Witness address (0x…)", "Label", [Add witness]; invalid "Enter a 0x address (42 characters)."
  - Warning: "Check C passes only for witnesses in this list. Add a witness only if you trust whoever runs it."
- **Endpoints:** "Arkiv RPC URL", "Arkiv access key" (secret, Show toggle), "Swarm upload gateway", "Swarm download gateway", "Gnosis RPC URL", each with [Reset to default]. Download gateway helper: "Use a different gateway from upload, so checks don't rely on one node."
- **Extension:** field "Extension ID"; status "Connected · v<x>" or "Not connected. Check the ID matches chrome://extensions."
- **Appearance:** "Theme": System / Light / Dark.
- Actions: [Save settings] → toast "Settings saved". [Reset all] asks to confirm first.

## 5. Trust-language rules
- **May say:** "The witness saw these exact bytes from <host> at <date>" · "Passed" (per check) · "Signed by a trusted witness" (only if the address is pinned) · "Unchanged since <date>" / "Still unchanged on <date>" (only between two verified captures) · "Checks passed" (only if A–C, plus D when given, all passed).
- **May not say:** "true", "authentic", "official", "proven fact" · "verified page" or a bare "Verified" with no check named · "tamper-proof", "permanent", "forever", "trustless", "on-chain proof of content" · "deleted" or "removed by the site" (say "not captured since <date>") · "Recall verified". The one allowed use of "true" is the disclaimer "It does not show that the content is true."
- Always say "the witness", never "we", for who observed. Name the witness and its address; once per surface, link "Why trust one witness?". The explainer: "Recall uses one witness. If it was compromised or worked with the site, it could sign false bytes."
- No green before the facts: "Published" turns pass only after the transaction receipt, and E only after a live read of the batch TTL and Arkiv expiry.
- "Unknown witness" is always warn, never pass. Offline or unreachable is "Not checked", never pass and never fail.
- Never show the counts of hidden unverified items as successes. Totals exclude them.
- Times shown are the witness's signed time in UTC. Arkiv block time, if shown, is labelled "Published at".

## 6. Flows (text)
```
Popup: open → [load URL + earlier captures + witness status]
  ├─ non-https / witness offline / no storage → error notice (+ Buy storage → web #/storage)
  └─ Capture this page → connect → MPC proof (15–30 s) → check signature
       ├─ page > 64 KB / TLS 1.2 missing / failure → error, "Nothing was published."
       ├─ body identical → "Unchanged since <date>" → [Publish confirmation] ─┐
       │                                         └─ [Keep earlier alive] → web Keep-alive dialog
       └─ new body → upload to Swarm → "Evidence uploaded" ─────────────────────┤
Approve tab (#/approve): ExhibitCard → Connect MetaMask → (wrong network → Switch)  ◄┘
       → Publish record → Confirm in MetaMask → waiting → receipt
       ├─ rejected / failed → pending kept → [Try again] | [Discard]
       └─ success "Published" → [View timeline] → #/url/:hash (new item "Checking…" → Passed)
Timeline → item → Capture detail (A–E) → [Keep alive…] → Dialog step 1 (Gnosis) → step 2 (Arkiv)
Home → drop evidence file → Capture detail (offline: A–D run, E "Not checked")
```

## 7. Reviewer checklist (each UI task should pass every item)
- [ ] Uses only `tokens.css` variables; no raw hex, px font sizes or shadows in components.
- [ ] Both themes checked by eye; text ≥ 4.5:1 and controls/focus ≥ 3:1 (use `--border-strong` for input edges).
- [ ] No web fonts, CDN, analytics or remote images. The network tab shows only the configured RPCs and gateways.
- [ ] Every status shows icon + word + colour; nothing is understood by colour alone (diff has −/+ and del/ins).
- [ ] Green appears only on a check that ran and passed; pending, unknown and offline states are never green.
- [ ] Verdict text names what was checked. No forbidden words from §5 (grep the copy).
- [ ] Copy matches §4 exactly, or a change was agreed. Errors give cause + recovery + "Nothing was published" where it applies.
- [ ] Full keyboard path: Tab order follows the layout, focus ring is visible, Esc closes dialogs, focus returns to the trigger, the drop zone has a button.
- [ ] Route change moves focus to the h1; the skip link works; headings go h1 → h2 → h3 with no gaps.
- [ ] Async actions disable their button and show progress within 100ms; anything over 300ms shows a skeleton or step text.
- [ ] MetaMask states covered: no wallet, connect, wrong network, signing, rejected, failed, success.
- [ ] Empty, loading and error states exist for every list (captures, timeline, witnesses, batches).
- [ ] Hashes and addresses use MonoValue (middle-truncated, full value in title, Copy works).
- [ ] Times are shown in UTC with local time on hover; numbers use tabular figures.
- [ ] Popup fits 360×560 without horizontal scroll, and the footer button stays visible during progress.
- [ ] Web layout works at 375px and 1280px; text lines ≤ 68ch.
- [ ] `prefers-reduced-motion` stops spinners and transitions; the progress text still updates.
- [ ] The preview iframe has `sandbox=""` (no allow-scripts) and the page never runs captured scripts.
- [ ] Notices use the right roles (`alert` for errors, `status` otherwise); toasts don't steal focus.
- [ ] Settings validate on blur with the error below the field; the secret field has a Show toggle.
