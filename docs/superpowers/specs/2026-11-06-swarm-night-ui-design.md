# Recall UI: "Swarm Night" landing page, public library and brand (design)

Date: 2026-11-06, late evening IST. Deadline: **Sat 7 Nov 2026, 09:00 IST** (ETHGlobal Mumbai).
Branch: `ui/swarm-night` in the worktree `/Users/madkeanuj/Code/Eth-2026/recall-ui`.

## 1. Intent

Today the web app and the extension popup put everything on one screen. A judge who opens the site
does not get, in the first ten seconds, what Recall is, does not see it work, and has no reason to
spend the effort of installing an unpacked extension. This design fixes that with:

1. a **landing page** that walks a judge along one path: understand it, see a real proof check
   itself with no install, browse what others captured, see what each sponsor makes possible, then
   install in three steps;
2. a **public library**: every capture anyone has made, searchable, ranked by how long it will stay
   stored, with "Keep alive" on every card;
3. a **brand**: the "Swarm Night" theme (dark and light), a logo, and two characters (an owl that
   witnesses and an elephant that remembers), with one orchestrated GSAP animation;
4. **one consistent system** of spacing, corners, type and colour meanings across the web app and
   the extension.

The product's theme is **accountability and freedom of speech**: "The web forgets. Recall doesn't."

Prizes targeted (confirmed by the user): Ethereum Foundation "Best CROPS App"; Arkiv "Build on
Arkiv (from scratch)"; the Arkiv + Swarm bonus. Swarm has no separate track.

## 2. Goals, non-goals, anti-goals

**Goals**
- A judge understands Recall in 5 seconds and can watch a real capture verify in their browser in
  one click, with no wallet and no install.
- After that, installing the extension feels worth it and takes three clear steps.
- The library makes Recall feel alive and public: search it, filter it, keep things alive.
- Every screen uses the same spacing, corners, type and colour meanings. **Consistency is the
  user's top priority**, together with "simple, never overwhelming": every section is one heading,
  one sentence and one thing to do; extra detail opens only on a click (progressive disclosure).

**Non-goals (tonight)**
- Re-laying-out the inner app screens (capture page, timeline, approve/publish, storage,
  settings, file check). They get the new look **only through shared tokens** (colours, fonts,
  spacing) plus the new header and footer; their DOM, labels and button text stay as they are.
- New verification logic, new Arkiv schemas, new storage flows.
- Chrome Web Store listing.

**Anti-goals (a failure even if it "works")**
- Breaking the other session's final end-to-end tests or demo flow (see constraints).
- Green shown for anything that is not a check that ran and passed. "Verified" on a library card
  only after this browser verified that capture's evidence.
- Decorative motion everywhere. Exactly one orchestrated story (the landing hero) plus motion that
  answers a person's action (Run the checks, Keep alive re-rank, disclosure open/close).
- Clutter: dense dashboards, walls of hashes, many buttons per card.
- An eye-shaped logo or surveillance imagery (wrong signal for a free-speech product).

## 3. Constraints

- **Time:** about 9 hours. Build in priority order (section 9) so a partial result is still
  shippable.
- **Another session owns `main`** and is doing the final e2e run and the demo-video
  recording on the current screens. This work happens only in the `ui/swarm-night` worktree and is
  merged to `main` only after coordinating with that session (through the user). Never edit the
  main worktree `/Users/madkeanuj/Code/Eth-2026/recall`.
- **Existing e2e must keep passing.** The Playwright specs in `e2e/specs/` select by role, label and
  text on the existing routes and the popup. Do not rename or remove existing labels, headings,
  button texts, `data-*` hooks or routes. The old Home route content is replaced (see 6.3), so any
  spec that drives the old Home must be checked and updated in the same change. Find them first
  with a grep for the Home texts ("Find captures of a page", "Verify an evidence file", "Try it",
  "Verify an example").
- **Repo hard rules:** no AI-assistant attribution anywhere (no Co-Authored-By trailers, no
  "Generated with"); never commit `.env*`, keys, `.superpowers/`. Secrets stay in `.env.local`.
- **UI work must use the `ui-ux-pro-max` skill** (its checklist: contrast 4.5:1, focus rings,
  44 px targets, reduced motion, no emoji icons, no horizontal scroll at 375 px).
- **Extension (MV3) CSP:** no remote scripts or fonts. Anything the popup needs is bundled.
- **Static hosting, no backend:** the web app runs from GitHub Pages and from Swarm. All data comes
  from Arkiv (reads) and Swarm (evidence), as today, through `@recall/net`.
- Fonts are already bundled in both packages: Bricolage Grotesque (display) and Public Sans (text).
  Keep them; do not add web-font requests.
- Accessibility: WCAG AA in **both** themes; `prefers-reduced-motion` shows the final frame of
  every animation; keyboard-complete; visible focus.

## 4. Design system (decided)

### 4.1 Theme: "Swarm Night", dark and light
Both themes ship. The site follows the visitor's system setting; a moon/sun icon button in the
header overrides it and is remembered in `localStorage` (wrapped in try/catch; a per-viewer
convenience only). Theme is applied as `[data-theme=dark|light]` on `<html>`.

Palette, from the sponsors' own brand colours (Swarm orange #f47a20 and its lime glint #def4b6;
Arkiv blue #181ea9; EF lavender #6b7aba for the EF sponsor mark only):

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--bg` | #000000 | #f4f5f2 | page |
| `--bg-alt` | #0b0e0c | #eaede8 | alternating sections, panels |
| `--surface` | #121713 | #ffffff | cards |
| `--surface-2` | #1c231e | #eef1ed | wells, bar tracks, favicon tiles |
| `--border` | #2a322c | #dde1dc | hairlines (decorative) |
| `--border-strong` | #4a544d | #9aa39c | inputs, outline buttons (≥3:1) |
| `--text` | #f2f2f2 | #101411 | |
| `--text-muted` | #a9b2ab | #4f5852 | |
| `--accent` (action) | #f47a20 | #f47a20 | filled primary buttons |
| `--accent-text` | #ff9a52 | #a84300 | orange text and outline buttons |
| `--on-accent` | #000000 | #101411 | text on orange |
| `--pass` / `--pass-bg` | #7fdc9c / #0f2a1a | #126345 / #e5f5eb | |
| `--warn` / `--warn-bg` | #f0b65a / #2e2210 | #7a4f00 / #fff2d1 | |
| `--fail` / `--fail-bg` | #ff8f85 / #341614 | #ae2a37 / #fff0ed | |
| `--life` / `--life-bg` | #9ea4ff / #181c3d | #181ea9 / #e8e9fb | time left in storage |
| `--na` / `--na-bg` | #a9b2ab / #1c231e | #4f5852 / #eef1ed | not checked |

The existing token names in `apps/web/src/ui/tokens.css` and
`extension/packages/extension/src/recall/ui/tokens.css` stay (components already use them; there is
no raw hex outside the token files). Re-map their values to this palette, add `--life*`, add the
dark set, and keep both token files identical as today. Builder verifies every text/background
pair at ≥4.5:1 (≥3:1 for large text and UI glyphs) with a script, in both themes.

### 4.2 Colour meanings (the same everywhere: web app and extension)
- **Orange**: something you can press. Never a status. The landing-hero illustration (honeycomb,
  saddle cloth, logo hexagon) is the one decorative exception.
- **Green**: a check ran and passed ("Verified"). Never decoration.
- **Amber**: needs attention ("ends soon" when < 7 days left, unknown witness, warnings).
- **Red**: failed or tampered.
- **Blue** (`--life`): how long a capture stays stored (days left, life bar, library rank).
- **Grey**: not checked yet / unavailable.
Every status also has an icon and a word (never colour alone).

### 4.3 Spacing, corners, type
- Spacing scale only: 4, 8, 12, 16, 24, 32, 48, 64, 96 px. Cards: 16 inside, 16 between. Section
  vertical padding: 96 desktop, 64 phone. Page gutter: 32 desktop, 16 phone. Max content width
  1120 px.
- Corners by role: 8 (chips, small tiles), 14 (cards, panels, inputs, segmented controls),
  pill (buttons, status pills). Never mixed within a role.
- Type: Bricolage Grotesque 800 for display (hero `clamp(38px, 6vw, 60px)`, section titles 40/28
  phone), Public Sans for text (16 body, 14 secondary, 13 meta, 12 minimum). Tabular numbers for
  counts and days. Line length ≤ ~70 characters.
- Buttons: 44 px tall (36 px "sm" inside cards, with a 44 px hit area). One filled orange primary
  per screen region; secondary is an outline button; the card action is an orange-outline button.
- Icons: one SVG line-icon set (`lucide-react`, already a dependency), stroke 1.75, 14/16/20 px.
  No emoji or text glyphs as icons.

### 4.4 The one card (used for captures everywhere: hero, "See it work", library)
```
[fav] Title (max 2 lines)                     
      host/path (1 line, ellipsis)
[status pill] [#rank] [type icon + Page|Repo] [versions] [date]     <- wraps
[n days left            ] [ Keep alive ]                             <- pushed to the card bottom
[==========-----------  ]
```
- `fav` = a 36 px tile with the site's first letter (no remote favicons: privacy, CSP).
- Status pill: Verified (green), Not checked yet (grey), Unverified (amber; see 6.4). It sits in
  the facts row on every card, so the title always gets the full width.
- `#rank` only where a ranking is shown (library sorted by time left).
- Life bar and "n days left" in `--life`; amber when < 7 days.
- The whole card opens the capture page (`#/c/<entityKey>`); the only button is "Keep alive".
- In a grid all cards are equal height and the bottom row aligns (flex column, footer
  `margin-top: auto`).
- Proof details (witness, hashes, Swarm reference, the checks) never appear on the card; they are on
  the capture page, one click away.

### 4.5 Motion (GSAP)
- Library: `gsap` 3.13 from npm (it includes Flip; all plugins are free). Bundled into the web app
  only. The extension popup uses CSS transitions only (keeps the popup small and CSP-simple).
- One orchestrated story on the landing hero (6.1), played **once** on load, never looping.
- Motion that answers an action: Run the checks (rows tick in order), Keep alive (days count up,
  bar grows, cards re-rank with Flip), disclosures open/close.
- Durations 150–400 ms for UI; the hero story ≈ 4 s total. Transform and opacity only.
- `prefers-reduced-motion`: render the final state immediately; owl eyes do not follow the cursor.

## 5. Brand

### 5.1 Logo (decided: option C, refined)
The letter **R inside a Swarm-orange hexagon**, where the R's bowl is an elephant's head (with a
white eye) and its leg is the trunk. The R is drawn at ~74% so it has clear space inside the
hexagon at every size. Ink R (#101411) and white eye on orange in both themes. Wordmark: logo +
"Recall" in Bricolage Grotesque 800.
Reference SVG: `<symbol id="C">` in
`/Users/madkeanuj/Code/Eth-2026/recall/.superpowers/brainstorm/50119-1793986478/content/logo-final.html`.
Uses: header lockup, favicon (SVG + 32 px PNG), extension icons (16, 32, 48, 128 PNG, replacing
`extension/packages/extension/src/assets/img/icon-34.png` / `icon-128.png` and the manifest
entries), Open Graph image (optional).

### 5.2 Characters (decided: the duo)
An **owl** (the witness: watches and signs) riding an **elephant** (the memory: keeps the receipt,
never forgets). Flat SVG, no outlines, theme-aware skin tones. The elephant's saddle cloth is made
of Swarm hexagons (deep-orange hexes on Swarm orange with a few lime ones, gold fringe and
tassels, a nod to Mumbai's festival elephants). The elephant raises a receipt card with a green
check in its trunk; the owl holds a hexagon seal.
Reference SVG + GSAP: `mascot-duo-v2.html` in the same brainstorm folder (use it as the starting
point; clean up the drawing, keep the proportions and palette).
Where it appears (and nowhere else): landing hero; library empty state ("Nothing forgotten
yet"); the extension popup's success moment (a small static elephant + check, CSS only); the
404 page (optional).

## 6. Web app

### 6.1 Header and footer (all routes)
Header: logo lockup (links to `#/`), nav: Library, How it works (`#/` anchor), Sponsors (`#/`
anchor), theme toggle, and "Get the extension" (filled orange). Phone (< 760 px): logo, Library,
theme toggle, a menu button revealing the rest. Existing routes keep their own page content below
the new header. Footer: "For judges:" GitHub repo, Demo video, Arkiv notes (`arkiv/`), "Run one
query yourself" (README anchor), and the AI-use sentence already in the README.

### 6.2 Landing page `#/` (replaces the old Home)
Five sections, alternating `--bg` / `--bg-alt`, each = heading + one sentence + one thing to do.
Copy below is the approved draft; the builder may tighten it but not add sections.

1. **Hero.** Two columns (stack on phone).
   - Left: "The web forgets. / Recall doesn't." (no single-word colour accent; "forgets." is kept
     together with `white-space: nowrap`). Lead: "Capture any public page or GitHub repo with proof
     of what it said. Anyone can check that proof, even offline, even if we disappear." Primary:
     "See a proof check itself" (scrolls to section 2 and starts the checks). Secondary: "Get the
     extension" (scrolls to section 5). Under them: "No wallet or install needed to look around."
   - Right: one panel holding (top to bottom) the four-step rail (Captured · Witness signed ·
     Stored on Swarm · Indexed on Arkiv), the owl-and-elephant duo, and one capture card.
   - The story (once, ≈4 s): the letters of "forgets" scatter like link rot → rail step 1 fills →
     step 2 fills and the owl stamps its seal → step 3 fills and the saddle-cloth hexagons pop in
     from the centre → step 4 fills, the card springs in, its Verified pill pops, its life bar and
     day count rise → "forgets" reassembles.
   - The hero card shows the real example capture (the same one as section 2), not fake data.
2. **"See it work on a real capture"** (`id="how-it-works"`). Intro: "A page we captured during the
   hackathon. Press the button: your browser fetches the evidence from Swarm and checks it right
   here. Nothing is taken on trust, not even from us." Left: the example capture card with status
   "Not checked yet" and a primary "Run the checks". Right: the checks list. Pressing runs the
   **real** verification pipeline already used by the capture page (`useVerifiedCapture` /
   `verify.ts`, `CheckPanel` models) on the existing example capture (the one behind Home's
   "Verify an example" today; the live P2 capture
   `0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244`, confirm in
   `apps/web/src/defaults.ts` / `TryIt.tsx`). Rows appear in order as their real results arrive,
   using the existing check letters and titles (A "Bytes match the signed hashes", B "Request and
   response are well-formed", C "Signed by a trusted witness", E "Storage"; D only if it applies),
   each with a "How?" disclosure holding one plain sentence on that step of the pipeline (capture,
   witness, Swarm, Arkiv). A failed or unavailable check shows red/grey honestly. When done, the
   pill becomes the real verdict and the button becomes "Open the full proof" (outline) →
   `#/c/<key>`. The old Home's tools (find captures by address, verify an evidence file, compare a
   raw file) move under a small "More ways to check" disclosure at the end of this section, so no
   feature is lost.
3. **"The public library."** Intro: "Every capture anyone has made, searchable. The ones people
   keep alive rise to the top." The top 3 cards by time left (same data as 6.3), then "Open the
   library" (outline). Empty state: the duo + "Nothing forgotten yet. Capture the first page."
4. **"Built on open infrastructure"** (`id="sponsors"`). Intro: "Recall works without us because
   these projects exist. Thank you to the Ethereum Foundation, Arkiv and Swarm." Three equal cards,
   same anatomy: mark tile + name + prize name; one sentence; rows (bold title + one line); a link
   at the bottom.
   - EF, "Best CROPS App": "CROPS is why Recall exists: a record of the public web that no one can
     quietly take down." Rows: Censorship resistant (evidence and this app live on Swarm, not one
     domain) · Open source (MIT, every line public) · Private (your cookies never reach the
     witness) · Secure (every check runs in your own browser). Link: README CROPS section.
   - Arkiv, "Build on Arkiv": "The public index: anyone can ask 'what captures exist of this
     page?' without asking us." Rows: Public index · Read-only records · Anyone keeps it alive.
     Link: `arkiv/friction.md` ("Our Arkiv feedback"), with why-arkiv / how-you-use-arkiv / schema
     linked from that row too.
   - Swarm, "Arkiv + Swarm bonus": "Where the evidence lives, and where this site lives too, so
     neither depends on our servers." Rows: Evidence storage · This website (published to a Swarm
     feed) · No backend (uploads are stamped in the extension). Link: `arkiv/swarm.md`.
   - Sponsor marks are simple coloured tiles with initials (EF lavender, Arkiv blue, Swarm orange);
     we do not redraw or recolour their real logos.
5. **"Capture your own in two minutes"** (`id="install"`). Intro: "The extension isn't in the
   Chrome Web Store yet, so it loads in three steps." Three numbered step cards: Download (the
   GitHub release zip) · Load it (chrome://extensions → Developer mode → Load unpacked) · Capture
   (open any public page, press Capture in the Recall popup). Primary: "Download the extension"
   (the release asset URL).

Hero numbers: the design mock showed captures / sites / repos counts; include them only if they
come from the same library query and are honest (e.g. "4 captures on Arkiv"); omit the row if
the library has fewer than ~10 captures (my call: a tiny number undersells the product).

### 6.3 Library `#/library` (new route)
- **Data:** page through all `recall.v1.capture` rows on Arkiv (`.from(CaptureSchema)`, keyset
  paging on `$key` like `listByUrl`, node max 100 per page; cap at 1,000 rows and say so if
  capped). Add a `listAllCaptures` to `packages/net/src/arkiv.ts` with a unit test against the
  devnet. Attachments (`recall.v1.attachment`, kind `git`) mark repo captures; fetch them the same
  way and join by capture key.
- **One card per page** (group rows by `urlHash`): versions = number of capture rows for that page;
  date = newest `signedAt`; days left = from the newest record's `$expiresAt` (existing
  `readArkivExpiry` / block timing helpers); type = Repo if it has a git attachment, else Page.
- **Verification:** a card shows "Not checked yet" until this browser verifies its newest capture
  (download evidence by `evidenceRef`, run checks A–C, match the row: the same rule as
  `scripts/arkiv-query.ts` and the timeline). Verify the visible cards lazily (the first screenful,
  then on scroll), at most 3 at a time. Cards whose evidence fails go behind "Show unverified (n)",
  as the timeline does today. The title comes from the verified evidence (`captureTitle.ts`);
  until then the card shows host + path.
- **Toolbar:** a search box (client-side over host, path and title; debounced), a segmented
  filter All / Pages / Repos, and a sort select: Most time left (default) · Newest · Ending soon.
  Filter, sort and search are kept in the URL query (`#/library?q=&type=&sort=`) so a judge can
  share a view.
- **Keep alive** on a card opens the existing keep-alive flow (`components/KeepAlive.tsx`,
  `keepalive/flow.ts`, MetaMask) for that page's records, in place (a dialog or the existing panel)
  without leaving the library. On success: days count up, the bar grows, and the grid re-ranks with
  GSAP Flip. On cancel or error: nothing moves, the existing error copy shows.
- **States:** loading = skeleton cards (no spinners longer than 300 ms); Arkiv unreachable = an
  error with "Try again"; empty = the duo + "Nothing forgotten yet".
- Grid: `repeat(auto-fill, minmax(300px, 1fr))`, 16 px gap; one column on phone.

### 6.4 Existing routes
Capture, timeline (`#/u/…`), approve/publish, storage, settings, file check, not-found: **only**
the new tokens (both themes), the new header/footer, and the card component where they already
render an exhibit card (`ExhibitCard.tsx`) if, and only if, its texts and labels stay the same.
Check each route in both themes at 1280 and 375 px for contrast and overflow.

## 7. Extension popup
- New tokens (the popup follows the system theme; no toggle in the popup), new logo in the header,
  new toolbar icons.
- Simplify by disclosure, without changing button labels or flows: anything technical (witness
  URL, hashes, batch ids, advanced settings) folds behind a "Details" disclosure; the popup shows
  one primary action at a time. The exact list is left to the builder, but every existing e2e
  popup spec (`e2e/specs/p1-extension.spec.ts`, `p2-*`, `p3-settings.spec.ts`) must pass
  unchanged or with a selector change reviewed by the controller.
- Success moment after a capture is published: a small static elephant-with-check illustration
  (CSS fade-in only).
- Rebuild the release zip and refresh the GitHub release asset after merge (the fixed extension ID
  key stays the same).

## 8. Left to the builder
Exact SVG clean-up of the duo and logo; component structure; the skeleton design; the phone menu;
copy tightening within the meaning above; which old Home e2e assertions move to the new section
(keep their intent); the contrast script; how the Flip re-rank is wired to the existing keep-alive
callback; the popup disclosure list.

## 9. Build order (so a partial result is still shippable)
1. Tokens (both themes) + theme toggle + header/footer + logo/favicon. Run all e2e.
2. Landing page sections 1, 2, 4, 5 (section 2 uses real verification). Move the old Home tools
   under "More ways to check". Update affected e2e.
3. `listAllCaptures` + Library route + landing section 3.
4. Characters and the hero story (GSAP).
5. Keep alive in the library with Flip re-rank.
6. Extension popup: tokens, logo, icons, disclosure, success moment.
7. Full e2e (local devnet on the AWS test runner, as the main session does), live check on the
   built app, then coordinate the merge to `main`, Pages deploy, Swarm republish, release zip.

## 10. Dependencies and risks (need the user or the main session)
- **The library is nearly empty:** on 2026-11-06 ~23:45 IST, live Arkiv holds 4 capture rows (2 of
  the P2 demo notice on localhostwastaken.github.io, 2 on notice.recall.test, likely not
  verifiable on live). Judges will see an empty-looking library unless ~10-20 real public pages
  and a couple of GitHub repos are captured before judging. Each capture needs storage
  (~0.32 xBZZ per 7-day batch, or free mode). Who captures, and with which budget, is the user's
  call.
- **Demo video:** the main session is recording it on the current UI. After this merges, the
  video shows the old look unless re-recorded.
- **Merge timing:** the main session's uncommitted work in `main` (README, demo-script, demo
  recorder) must land first; this branch then rebases.

## 11. Reference mockups (local, not committed)
Folder: `/Users/madkeanuj/Code/Eth-2026/recall/.superpowers/brainstorm/50119-1793986478/content/`
- `swarm-v6-landing.html`: the approved landing page (layout, copy, cards, tokens, both themes).
- `swarm-v4-gsap.html`: the library toolbar and the Keep-alive Flip re-rank.
- `mascot-duo-v2.html`: the owl-and-elephant duo with the GSAP story.
- `logo-final.html`: logo C, refined.
Open them in a browser directly (they load GSAP and Google Fonts from CDNs; the product must not).
