# Swarm Night UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Swarm Night theme (dark + light), the judge-funnel landing page, the public library, and the owl-and-elephant brand without breaking existing flows or e2e.

**Architecture:** Re-theme everything through the shared token files (no DOM change on existing routes); add a new landing page (replacing Home's content), a new `#/library` route fed by a new `listAllCaptures` Arkiv read, one shared `CaptureCard`, and SVG brand components animated with GSAP (web only). The extension gets tokens, icons and small disclosures.

**Tech Stack:** React 19 + Vite 6 + TypeScript 5.7, vitest 3 (jsdom), Playwright 1.49 e2e, `@arkiv-network/sdk` 1.0.1 via `@recall/net`, `gsap` 3.13 (new, web only), `lucide-react` icons.

**Spec:** `docs/superpowers/specs/2026-11-06-swarm-night-ui-design.md` (read sections 4, 5, 6, 7, 12 before any task).

## Global Constraints

- Work only in `/Users/madkeanuj/Code/Eth-2026/recall-ui` (branch `ui/swarm-night`). Never touch `/Users/madkeanuj/Code/Eth-2026/recall`.
- No AI-assistant attribution in commits, code or docs. Never commit `.env*`, keys, `.superpowers/`.
- Use the `ui-ux-pro-max` skill for every UI task; after each UI task, screenshot the changed screens at 1280 px and 375 px in **both** themes and look at them before reporting done.
- Tokens: exactly the values in spec §4.1; colour meanings §4.2; spacing scale 4/8/12/16/24/32/48/64/96; corners 8 / 14 / pill; fonts Bricolage Grotesque (display) + Public Sans (text), already bundled; no new web-font or CDN requests.
- Do not rename or remove existing labels, headings, button texts, `data-*` hooks or routes. If an e2e selector must change, say so in the task report.
- `prefers-reduced-motion: reduce` → every animation renders its final state; WCAG AA in both themes; 44 px targets; no emoji icons; no horizontal scroll at 375 px.
- Web unit tests: `pnpm -C apps/web test`. Extension unit tests: `pnpm -C extension/packages/extension test`. Net tests: `pnpm vitest run packages/net`. Typecheck: `pnpm -C apps/web typecheck`.
- **Cut-off: branch ready for merge by 04:00 IST Sat 7 Nov** (main session then merges, redeploys and re-records the demo). If behind, drop from the end of the execution order (T8 first, then T7's idle loops), never ship a half task.
- **Main session's hot files (avoid; conflicts expected only where listed):** `apps/web/src/routes/{Approve,Capture,Settings,Storage}.tsx`, `apps/web/src/{storage,attachments,verify}/*`, `apps/web/src/components/{RepoSnapshot,KeepAlive,TryIt}.tsx`, `extension/packages/extension/src/entries/Popup/*`, `extension/packages/extension/src/recall/*` (job, captureView, pendingUpload, chunkPush, repoSnapshot, errors), `e2e/demo/record-demo.ts`, `e2e/specs/p2-*.spec.ts`, `README.md`, `docs/demo-script.md`. Import from them freely; do not edit them. `routes/Home.tsx` is hot too but must change (T4/T6): keep the edit to replacing its JSX composition, so the rebase conflict is one block.
- **The AWS runner is shared with the main session (one devnet, global fixture state).** Before every runner use, the controller messages session `eth-2026-a2` and waits for "box free"; implementers never start runner jobs themselves, they hand the exact command to the controller.
- Docker is off on the Mac. Anything needing the devnet (net tests against Arkiv, Playwright e2e) runs on the AWS test runner via `/Users/madkeanuj/Code/Eth-2026/recall/.superpowers/sdd/2026-11-06-recall-mvp/testrunner.sh` (read it first; it rsyncs a worktree to the box and runs a command). If the runner is unavailable, report BLOCKED for that step only and continue.

## Review Focus

1. **Arkiv slow, rate-limited or down** (public endpoint without key, 100-row page cap): the library and "See it work" must show an honest error with "Try again", never a green or a blank page. Test in Task 6 (`useLibrary` error state) and Task 4 (example check unavailable → grey "Not checked").
2. **Hostile rows** (anyone can write `recall.v1.capture`): a `<title>` with markup, 10 kB titles, rows whose evidence mismatches. Titles go through `textContent` only and are capped at 120 chars; mismatching rows land in "Show unverified (n)". Tests in Task 6 (`pageTitle`, `groupByPage`).
3. **Many rows** (up to the 1,000 cap): only cards in view are verified, at most 3 at once; search is debounced; no layout jump when titles resolve. Test in Task 6 (`createVerifyQueue` concurrency).
4. **Theme persistence edge cases:** `localStorage` throwing (private mode) → system theme, no crash; no light flash on dark systems (theme set before first paint). Test in Task 1.
5. **Keyboard and reduced motion:** disclosures operable by keyboard; the disabled "Keep alive" has an accessible description; story/Flip skip to the final state under reduced motion. Tests in Task 7 and Task 8.

---

### Task 1: Tokens, dark theme and theme toggle

**Files:**
- Modify: `apps/web/src/ui/tokens.css`, `extension/packages/extension/src/recall/ui/tokens.css` (identical content)
- Modify: `apps/web/index.html` (inline pre-paint theme script; it must be CSP-safe for Pages and Swarm, i.e. plain inline is fine for the web app)
- Create: `apps/web/src/theme.ts`
- Create: `apps/web/test/theme.test.ts`, `apps/web/test/contrast.test.ts`
- Modify: `e2e/specs/p3-settings.spec.ts` (the light-only assertions near lines 547, 685, 760 → assert the theme follows `prefers-color-scheme` and the toggle)

**Interfaces:**
- Produces: `type Theme = 'light' | 'dark'`; `getStoredTheme(): Theme | null`; `systemTheme(): Theme`; `currentTheme(): Theme`; `setTheme(t: Theme): void` (stores, sets `document.documentElement.dataset.theme`); `ThemeToggle` is built in Task 3 on top of these.
- Token names: keep every existing name; add `--life`, `--life-bg`, `--accent-text`, `--surface-2`, spacing `--space-9: 96px`, `--radius-pill: 999px`, `--radius-2: 14px`. Light values under `:root, [data-theme=light]`, dark under `[data-theme=dark]` and `@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) {…} }`. Remove `color-scheme: light` and set `color-scheme` per theme.

- [ ] **Step 1: Write failing tests.** `theme.test.ts`: `setTheme('dark')` sets `data-theme="dark"` and `getStoredTheme()` returns `'dark'`; with `localStorage.getItem` throwing, `currentTheme()` returns `systemTheme()` and `setTheme` does not throw. `contrast.test.ts`: parse both theme blocks of `tokens.css`, compute WCAG ratios, assert ≥ 4.5 for `--text`, `--text-muted`, `--accent-text`, `--pass`, `--warn`, `--fail`, `--life`, `--info` on `--bg`, `--surface`, `--surface-sunken`, and each status on its `-bg`; ≥ 3 for `--border-strong` on `--surface`; `--on-accent` on `--accent` ≥ 4.5; and assert the web and extension token files are byte-identical.
- [ ] **Step 2:** `pnpm -C apps/web test -- theme contrast` → FAIL.
- [ ] **Step 3:** Implement `theme.ts` and the token values from spec §4.1 (map: `--bg`, `--bg-alt`→ new token, `--surface`, `--surface-sunken`=`--surface-2`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--accent`=#f47a20, `--accent-hover` (dark #ff8c3a / light #d9650f), `--on-accent`, `--focus` (= `--accent-text`), `--accent-soft` (dark #2a1608 / light #ffe4cc), status pairs, `--info` = `--life`, `--citrus`/`--coral` kept but re-pointed to orange/glint so old CSS still resolves). Add the pre-paint script to `index.html`: read `localStorage['recall.theme']` in try/catch, else `matchMedia`, set `data-theme`.
- [ ] **Step 4:** Tests pass; `pnpm -C apps/web typecheck` clean; `pnpm -C extension/packages/extension test` still green.
- [ ] **Step 5:** Screenshot `#/`, `#/c/<example key>`, `#/settings`, `#/storage` in both themes (vite dev with the live config is fine for looks) and fix any unreadable pair you see.
- [ ] **Step 6: Commit** `feat(ui): Swarm Night tokens with dark and light themes`.

### Task 2: Brand assets (logo, icons, favicon, duo mascot)

**Files:**
- Create: `apps/web/src/brand/Logo.tsx`, `apps/web/src/brand/Duo.tsx`, `apps/web/src/brand/brand.css`
- Create: `apps/web/public/favicon.svg`, `apps/web/public/favicon-32.png`; modify `apps/web/index.html` (`<link rel="icon">` both)
- Create: `scripts/gen-icons.mjs` (renders the logo SVG to PNG with the repo's Playwright Chromium)
- Replace: `extension/packages/extension/src/assets/img/icon-34.png`, `icon-128.png`; create `icon-16.png`, `icon-32.png`, `icon-48.png`; modify `extension/packages/extension/src/manifest.json` (`icons` 16/32/48/128, `action.default_icon` 16/32/48) and the build copy step if it lists icon files explicitly
- Copy the same `Logo` SVG into the extension: `extension/packages/extension/src/recall/ui/Logo.tsx`
- Test: `apps/web/test/brand.test.tsx`

**Interfaces:**
- Produces: `<Logo size?: number; title?: string />` (decorative unless `title`; renders the hexagon + R-elephant, spec §5.1, from `logo-final.html` symbol `C`, R at scale .74); `<Wordmark />` (Logo 28 + "Recall"); `<Duo className?: string />` an inline SVG with stable hook ids/classes used by Task 7: `.duo-owl-pupil` (×2), `.duo-owl-lid` (×2), `#duo-seal-arm`, `.duo-cloth-hex` (×N), `#duo-receipt-check`, `#duo-trunk`, `#duo-ear`, `#duo-eye`, `#duo-tail`; skin colours from CSS vars `--duo-skin`, `--duo-skin-2`, `--duo-skin-3`, `--duo-owl`, `--duo-owl-2` defined in `brand.css` per theme (values from `mascot-duo-v2.html`).
- Source drawings: `/Users/madkeanuj/Code/Eth-2026/recall/.superpowers/brainstorm/50119-1793986478/content/logo-final.html` and `mascot-duo-v2.html`. Clean the drawing (consistent shapes, no stray overlaps), keep proportions and palette; the cloth hexes are static SVG in the component (no runtime generation).

- [ ] **Step 1: Failing test** `brand.test.tsx`: `Logo` renders an `svg` with `aria-hidden="true"` by default and `role="img"` + `<title>` when `title` is given; `Duo` contains exactly 2 `.duo-owl-pupil`, ≥ 20 `.duo-cloth-hex`, and an element `#duo-receipt-check`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Run `node scripts/gen-icons.mjs` to write all PNGs (16/32/48/128 for the extension, 32 favicon).
- [ ] **Step 4:** Tests pass; open the PNGs (Read tool) and check the 16 px one is legible; `pnpm -C extension/packages/extension test` green.
- [ ] **Step 5: Commit** `feat(brand): R-elephant logo, owl-and-elephant duo, icons and favicon`.

### Task 3: Shell (header, footer, theme toggle, library route)

**Files:**
- Modify: `apps/web/src/App.tsx`, `apps/web/src/app.css` (or `ui/web.css` where header styles live), `apps/web/src/router.ts`
- Create: `apps/web/src/components/ThemeToggle.tsx`, `apps/web/src/components/SiteHeader.tsx`, `apps/web/src/components/SiteFooter.tsx`
- Create: `apps/web/src/routes/Library.tsx` (placeholder page with `<h1>Library</h1>`; filled in Task 6)
- Test: `apps/web/test/router.test.ts` (new) or extend an existing router test if present

**Interfaces:**
- Consumes: `setTheme/currentTheme` (Task 1), `Wordmark` (Task 2).
- Produces: `Route` gains `{ name: 'library'; q: string; type: 'all' | 'page' | 'repo'; sort: 'time' | 'newest' | 'ending' }` parsed from `#/library?q=&type=&sort=` (defaults `''`, `'all'`, `'time'`; unknown values fall back to defaults); `libraryHash(p: Partial<{q;type;sort}>): string` builds it (omits defaults). Landing anchors: `#/` sections have ids `how-it-works`, `library-preview`, `sponsors`, `install`; header links scroll to them (hash router: use `onClick` + `scrollIntoView`, keep `href="#/"`).
- Header (spec §6.1): Wordmark → `#/`; nav: Library, How it works, Sponsors; `ThemeToggle` (icon button, `aria-label="Switch to dark theme"` / `"Switch to light theme"`, 40 px); "Get the extension" (filled, scrolls to `#install` on `#/`, else navigates to `#/` then scrolls); keep `WalletChip` in the header (an e2e clicks "Connect MetaMask" inside `header`). Below 760 px: Wordmark, Library, ThemeToggle, a menu button (`aria-expanded`) revealing the rest.
- Footer: "For judges:" links (GitHub repo `https://github.com/localhostwastaken/Recall`, Demo video = README anchor `#demo-video`, Arkiv notes = repo `arkiv/` folder, Run one query = README anchor `#run-one-query`), keep the existing "Advanced settings" link and the existing footer sentence.

- [ ] **Step 1: Failing test:** `parseHash('#/library?q=gov&type=repo&sort=newest')` equals the route above; `parseHash('#/library?type=bogus')` → defaults; `libraryHash({ sort: 'time' })` → `'#/library'`; `routeId` distinguishes two library queries.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Tests + typecheck pass; screenshot header/footer 1280 + 375, both themes; keyboard-tab through the header.
- [ ] **Step 5: Commit** `feat(web): new header, footer, theme toggle and library route`.

### Task 4: Landing page (hero static, See it work, sponsors, install) and CaptureCard

**Files:**
- Create: `apps/web/src/components/CaptureCard.tsx`, `apps/web/src/components/captureCard.css`
- Create: `apps/web/src/landing/Hero.tsx`, `apps/web/src/landing/SeeItWork.tsx`, `apps/web/src/landing/Sponsors.tsx`, `apps/web/src/landing/Install.tsx`, `apps/web/src/landing/landing.css`
- Modify: `apps/web/src/routes/Home.tsx` (becomes the landing composition; the existing `Search`, `VerifyEvidence`, `CompareFile` components move unchanged into a `MoreWaysToCheck` disclosure at the end of section 2; `TryIt.tsx` constants stay exported, its panel is no longer rendered)
- Modify: `e2e/specs/p3-verify.spec.ts`, `e2e/specs/p5-hosting-local.spec.ts` (open "More ways to check" before using those tools; keep every other assertion)
- Test: `apps/web/test/captureCard.test.tsx`, `apps/web/test/landing.test.tsx`

**Interfaces:**
- Produces: `CaptureCardProps = { title: string; address: string; href: string; status: 'verified' | 'checking' | 'unchecked' | 'unverified'; rank?: number; kind: 'page' | 'repo'; versions: number; date?: Date; daysLeft: number | null; keepAlive?: ReactNode }` → `<CaptureCard {...props} />`, anatomy spec §4.4 (status pill in the facts row; whole card is a link except the keep-alive slot; `daysLeft < 7` → amber; `null` → "Time left unknown" grey; bar width = min(100, daysLeft / 240 · 100)%).
- `useExampleCheck(): { report: VerifiedReport | null; storage: StorageState; verdict: Verdict; record: CaptureRecord | null }` in `SeeItWork.tsx`, a thin wrapper over `useVerifiedCapture(EXAMPLE_CAPTURE_KEY)` lifted into `Home` so Hero and SeeItWork share one run (pass it down as a prop).
- Copy: spec §6.2 sections 1, 2, 4, 5 and §12.6 verbatim (headings, intros, button labels, sponsor rows). Check rows use the existing letters and titles from `CheckPanel.tsx` rows A, B, C, E, each with a "How?" `<details>`.
- "Run the checks": reveals the rows one by one (150 ms apart, CSS transition; real statuses from the shared report; rows still pending show "Checking…"), then the button becomes "Open the full proof" (outline) linking `#/c/<key>`.

- [ ] **Step 1: Failing tests.** `captureCard.test.tsx`: status `'verified'` renders the text "Verified" and a check icon; `'checking'` renders "Checking…" and no element with class `pill-pass`; `daysLeft: 4` gives the life row class `is-soon`; `rank: 1` renders "#1"; the card root is an `<a href>` and the keep-alive slot is outside the link. `landing.test.tsx` (mock `useVerifiedCapture`): headings "See it work on a real capture", "The public library", "Built on open infrastructure", "Capture your own in two minutes" exist; with report pending the hero card shows "Checking…"; pressing "Run the checks" then resolving the mock to a passing report shows the four rows and the button text "Open the full proof"; with an unavailable report no "Verified" text appears anywhere.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (hero right panel: rail + `<Duo />` static + `CaptureCard` of the example; no GSAP yet). **Step 4:** Unit tests + typecheck pass.
- [ ] **Step 5:** e2e on the runner: `p3-verify`, `p5-hosting-local` pass. Screenshots 1280/375 both themes; compare against `swarm-v6-landing.html`.
- [ ] **Step 6: Commit** `feat(web): landing page with live example check, sponsors and install`.

### Task 5: `listAllCaptures` and `listAllAttachments` in @recall/net

**Files:**
- Modify: `packages/net/src/arkiv.ts`
- Test: `packages/net/test/listAll.test.ts` (devnet, like `arkiv.test.ts`)

**Interfaces:**
- Produces: `listAllCaptures(pub: ArkivPublic, opts?: { pageSize?: number; maxRows?: number }): Promise<{ rows: (CaptureRow & { entityKey: Hex; owner: Address; creator: Address; expiresAtBlock: bigint })[]; truncated: boolean }>` (defaults pageSize 100, maxRows 1000; keyset paging on `$key` exactly like `listByUrl` via `collectPages`; same field decoding as `listByUrl`'s capture branch; `creator` from `$creator`). `listAllAttachments(pub, opts?)` → `{ rows: ListedAttachment[]; truncated: boolean }` reusing the decoding in `listAttachments`.

- [ ] **Step 1: Failing test:** on the devnet, write 3 captures (2 sharing a `urlHash`) and 1 git attachment with existing helpers; `listAllCaptures(pub, { pageSize: 2 })` returns all 3 with correct `urlHash`/`evidenceRef`/`expiresAtBlock` and `truncated: false`; with `maxRows: 2` → 2 rows and `truncated: true`; `listAllAttachments` returns the attachment with `kind: 'git'`.
- [ ] **Step 2:** Run on the runner → FAIL. **Step 3:** Implement. **Step 4:** Runner → PASS; `pnpm vitest run packages/net` unit-only tests still pass locally.
- [ ] **Step 5: Commit** `feat(net): list every capture and attachment with keyset paging`.

### Task 6: Library (model, lazy verification, page, landing preview)

**Files:**
- Create: `apps/web/src/library/model.ts`, `apps/web/src/library/title.ts`, `apps/web/src/library/useLibrary.ts`, `apps/web/src/library/queue.ts`
- Modify: `apps/web/src/routes/Library.tsx` (Task 3 placeholder), create `apps/web/src/routes/library.css`
- Create: `apps/web/src/landing/LibraryPreview.tsx`; modify `Home.tsx` to render it as section 3 (`id="library-preview"`)
- Modify: `apps/web/src/timeline/useTimeline.ts` only to export its `checkRow` logic as `checkCaptureRow(cfg, row, signal): Promise<Checked>` (no behaviour change; timeline keeps using it)
- Test: `apps/web/test/library.model.test.ts`, `apps/web/test/library.title.test.ts`, `apps/web/test/library.queue.test.ts`, `apps/web/test/library.page.test.tsx`

**Interfaces:**
- Consumes: `listAllCaptures`, `listAllAttachments` (Task 5); `CaptureCard` (Task 4); `checkCaptureRow`; `readArkivExpiry` + block timing helpers already used for check E; route params (Task 3).
- Produces:
  - `type PageEntry = { urlHash: Hex; address: string /* host+path */; kind: 'page' | 'repo'; repo?: string /* owner/repo */; versions: number; newest: CaptureRow & { entityKey: Hex; batchId: Hex; expiresAtBlock: bigint }; signedAt: bigint }`
  - `groupByPage(rows, attachments): PageEntry[]` (one entry per `urlHash`; newest by `signedAt`, tie → larger `$key`; `kind: 'repo'` when any capture of the page has a git attachment).
  - `daysLeft(expiresAtBlock: bigint, currentBlock: bigint, blockSeconds: number): number` (floor, min 0).
  - `filterSort(entries, view: { q: string; type; sort }, titles: Map<Hex, string>, days: Map<Hex, number | null>): PageEntry[]` (q matches address, repo or title, case-insensitive; sort `time` = days desc, `newest` = signedAt desc, `ending` = days asc with null last).
  - `pageTitle(body: Uint8Array, contentType?: string): string | null` in `title.ts`: decode UTF-8, `DOMParser` `text/html`, `document.title` text only, whitespace collapsed, trimmed, cut to 120 chars with "…"; `null` when empty or not HTML.
  - `createVerifyQueue(limit = 3)`: `{ run<T>(job: () => Promise<T>): Promise<T>; cancelAll(): void }`.
  - `useLibrary(): { status: 'loading' | 'ready' | 'error'; error?: string; entries: PageEntry[]; truncated: boolean; check: Map<Hex /*urlHash*/, 'checking' | 'verified' | 'unverified'>; titles: Map<Hex, string>; days: Map<Hex, number | null>; requestCheck(urlHash: Hex): void; retry(): void; refreshDays(urlHash: Hex): Promise<void> }` — cards call `requestCheck` when they scroll into view (IntersectionObserver, `rootMargin: '200px'`).
- Page (spec §6.3): toolbar = labelled search input (debounce 200 ms, writes `?q=`), segmented All/Pages/Repos, sort select ("Most time left", "Newest", "Ending soon"); grid; "Show unverified (n)" switch as on the timeline; skeleton cards while loading; error notice with "Try again"; empty state = `<Duo />` + "Nothing forgotten yet" + "Capture the first page" (→ `#/` `#install`); truncated note "Showing the first 1,000 captures."; ranks shown only when `sort === 'time'`. Card `status`: queue state → `'checking'` | `'verified'` | hidden (unverified); keep-alive slot = disabled outline button "Keep alive" with `aria-describedby` → "Available after this capture is checked" until verified (Task 8 enables it).
- Hero stats (spec §6.2 note): `LibraryPreview` also exports `useLibraryCounts()`; Hero renders "N captures · M sites · R repos" only when N ≥ 10.

- [ ] **Step 1: Failing tests.** model: two rows same `urlHash` → one entry, `versions: 2`, newest is the later `signedAt`; attachment on either → `kind: 'repo'`; `filterSort` with `q: 'GOV'` matches `gov.example/notice`; `ending` puts `null` days last; `daysLeft` floors and never goes negative. title: `<title> Hello <b>x</b> </title>` → `"Hello <b>x</b>"` as plain text (no element created in the document); 10 kB title → 121 chars ending "…"; non-HTML body → `null`; `<script>` inside the body never executes (spy on `window.alert`). queue: 10 jobs with limit 3 never exceed 3 in flight; `cancelAll` rejects pending jobs with an `AbortError`-named error. page (mock `useLibrary`): error state shows "Try again" and calls `retry`; empty state shows "Nothing forgotten yet"; `?type=repo` hides page entries; an unverified entry is hidden until the switch is on; with `sort=newest` no "#1" text renders.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Unit tests + typecheck pass.
- [ ] **Step 5:** Live look: `pnpm -C apps/web dev` with the live config (no secrets printed), open `#/library`, screenshot 1280/375 both themes with whatever live data exists; check the error path by blocking the Arkiv host.
- [ ] **Step 6: Commit** `feat(web): public library with search, filters, ranking and lazy verification`.

### Task 7: Hero story and mascot motion (GSAP)

**Files:**
- Modify: `apps/web/package.json` (add `gsap@3.13.0`)
- Create: `apps/web/src/landing/heroStory.ts`
- Modify: `apps/web/src/landing/Hero.tsx`
- Test: `apps/web/test/heroStory.test.ts`

**Interfaces:**
- Consumes: `Duo` hook ids/classes (Task 2); the hero card from Task 4 (wrap its status pill in an element with class `hero-pill`).
- Produces: `playHeroStory(root: HTMLElement, opts: { reducedMotion: boolean }): { kill(): void }` (one `gsap.timeline`, ≈4 s, sequence spec §6.2.1; never repeats; under reduced motion sets the final state synchronously and returns); `followPointer(root: HTMLElement): () => void` (owl pupils follow the pointer, max 5 px offset, only when `matchMedia('(pointer: fine)')` and not reduced motion; returns cleanup). The hero pill shows the real verdict whenever it arrives (no timing coupling; spec §12.1).

- [ ] **Step 1: Failing test** (jsdom, gsap real): with `reducedMotion: true`, after `playHeroStory` returns, every `.duo-cloth-hex` has `transform` scale 1 / opacity 1 and the "forgets" letters have no transform; `kill()` leaves no active tweens (`gsap.globalTimeline.getChildren().length === 0`); calling it twice does not double-split the word.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (split "forgets" into spans once, `aria-hidden` on the spans with the heading's `aria-label` intact; idle loops limited to blink and ear flap, each ≥ 3 s apart). **Step 4:** Pass; typecheck.
- [ ] **Step 5:** Record a short Playwright video or 4 screenshots (0 s, 1.5 s, 3 s, 5 s) of `#/` at 1280 in both themes and look at them; verify the reduced-motion render with `page.emulateMedia({ reducedMotion: 'reduce' })`.
- [ ] **Step 6: Commit** `feat(web): hero story with the owl and the elephant`.

### Task 8: Keep alive from the library with Flip re-rank

**Files:**
- Modify: `apps/web/src/routes/Library.tsx`, `apps/web/src/landing/LibraryPreview.tsx`
- Create: `apps/web/src/library/rerank.ts`
- Test: `apps/web/test/library.keepalive.test.tsx`

**Interfaces:**
- Consumes: `KeepAlive` (`components/KeepAlive.tsx`, props `target: KeepAliveTarget`, `onChanged`), `useLibrary().refreshDays`, `filterSort`.
- Produces: on a verified card the keep-alive slot renders `<KeepAlive target={{ entityKeys: [entry.newest.entityKey], batchId: entry.newest.batchId }} onChanged={() => refreshDays(entry.urlHash)} />` (spec §12.3: newest verified capture only). `flipRerank(grid: HTMLElement, mutate: () => void, opts: { reducedMotion: boolean }): void` in `rerank.ts` (GSAP Flip `getState` → mutate → `Flip.from`, 0.8 s `power3.inOut`; reduced motion → just mutate). After `refreshDays` resolves with a larger value, the card's day count tweens up and the grid re-ranks through `flipRerank`. Nothing moves on cancel or error.

- [ ] **Step 1: Failing test** (mock `KeepAlive` to call `onChanged`, mock `refreshDays` to raise entry B from 4 to 34 days): order goes A(212), C(21), B(4) → A, B, C; ranks re-label "#2" on B; with reduced motion the order changes without calling `Flip.from` (spy); an unverified card renders a disabled "Keep alive" with `aria-describedby` text "Available after this capture is checked".
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass; typecheck.
- [ ] **Step 5:** e2e on the runner: add `@p4 library keep-alive` to `e2e/specs/p4-keepalive.spec.ts` reusing its mock-wallet fixture: open `#/library`, the seeded capture verifies, press Keep alive, complete the dialog, assert its days increased. Existing `@p4` specs still pass.
- [ ] **Step 6: Commit** `feat(web): keep alive from the library with a live re-rank`.

### Task 9: Extension look (tokens, icons, logo) without touching Popup/*

**Files:**
- Modify: `extension/packages/extension/src/recall/ui/base.css` and `recall/ui/settings.css` only if they force a light background (the popup then follows `prefers-color-scheme` through the shared tokens)
- (Icons and manifest were done in Task 2.)
- Test: `extension/packages/extension` existing unit tests; add `test/tokensParity.test.ts` asserting the extension tokens file equals the web one.

**Interfaces:** consumes the tokens (Task 1) and icons (Task 2). **No edits to `entries/Popup/*` or `src/recall/*.ts`** (main session's hot files). The popup disclosure and success art from spec §7/§12.5 are deferred to after the hackathon; note this in the report.

- [ ] **Step 1:** Failing parity test. **Step 2:** FAIL. **Step 3:** Fix any forced-light CSS. **Step 4:** `pnpm -C extension/packages/extension test` green; build the extension; screenshot the popup (onboarding + idle) in dark and light via the repo's Playwright extension fixture.
- [ ] **Step 5: Commit** `feat(extension): Swarm Night colours and icons`.

### Task 10: Whole-branch verification and hand-off

**Files:** none new (fixes go to the owning task's files).

- [ ] **Step 1:** Rebase `ui/swarm-night` onto the latest local `main` (main session's commits); resolve conflicts keeping main's logic and this branch's styling.
- [ ] **Step 2:** On the runner, run all suites: root `pnpm test`, web + extension unit, and Playwright `--project=local` (all specs). Expected: all green, or only failures the main session already knows about (list them).
- [ ] **Step 3:** Build the live web app (`pnpm -C apps/web build` with the live config) and screenshot every route (`#/`, `#/library`, `#/c/<example>`, `#/u/<example urlHash>`, `#/approve`, `#/storage`, `#/settings`, `#/file`, not-found) at 1280 and 375 in both themes; run the contrast test; fix anything unreadable or overflowing.
- [ ] **Step 4:** Report to the controller: commits, test counts, screenshots folder, and the merge/deploy steps for the main session (merge to `main`, Pages deploy, Swarm feed republish, release zip rebuild with the fixed key, re-record the demo).

---

## Execution order and parallelism

`[T1, T2, T5]` in parallel (disjoint files; T5's runner step waits for the box) → `[T3, T9]` → `T4` → `[T6, T7]` (T6 owns `Home.tsx` section 3 + library files; T7 owns `Hero.tsx` + `heroStory.ts`; coordinate the single `Home.tsx` edit by landing T6 first) → `T8` → `T10`.
