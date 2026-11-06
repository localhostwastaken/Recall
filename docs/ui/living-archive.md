# Recall: a bright living archive

The landing page and reader share one light-only system. This supersedes the prior muted archive palette and web typography guidance; the extension is unchanged.

## Visual decisions

- Cream `#fffdf5` backgrounds and navy `#162743` text keep long reading comfortable. Cobalt `#2455df` identifies primary actions and links. Coral `#f58b76` highlights the schedule change; citrus `#f7d84d` connects the calendar, capture journey and file-opening surface. Large sections stay light.
- Bricolage Grotesque supplies expressive headings and dates. Public Sans supplies interface text, metadata and response content. Both are locally hosted, unmodified Latin variable WOFF2 files with SIL OFL licences. Their combined download is 103,720 bytes. Preloading and `font-display: swap` keep text available, with system fallbacks for other scripts.
- Shared `tokens.css`, `fonts.css`, `base.css`, `web.css` and `product.css` define colour, type, controls, focus, surfaces and spacing. Page CSS controls composition. Controls are at least 48 px high; metadata is 13–15 px, body 16 px and response content 19 px.
- The theme chooser has been removed. Legacy dark/system settings normalise to light without losing the extension ID. Native controls and feedback are light as well.
- The illustration uses normal document flow. Dates and captions are never placed under overlapping layers. Reduced-motion preferences are respected.

## Story and functionality

The ETHGlobal Mumbai illustration shows the earlier 6–8 November 2026 dates and the updated 5–7 November dates. The public announcement confirms a move one day earlier:
https://www.linkedin.com/posts/ethglobal_devconindia-mumbai-ethglobal-activity-7505708854693900289-TCpe

Both illustrations say **Illustrative reconstruction based on the public date change.** They are not genuine Recall captures, verified evidence or a comparison produced by the reader. No endorsement or customer relationship is implied. The buttons switch illustrative dates and calendar highlights only.

The reader preserves the original routes, canonical URL lookup, Arkiv query, Swarm download, local JSON inspection and shared `runChecks` verifier. The original bytes can be downloaded again. Externally retrieved HTML becomes escaped text, never live archived markup. Request guards prevent stale results replacing a newer selection. Keyboard focus moves into an opened record and returns to its trigger when closed.

The code implements the extension/witness flow with signed transcript evidence, unlike the alternative operator-service README proposal. The UI does not blend these architectures. Integrity, response structure and witness signature are separate results. A valid but unpinned witness is unknown. Source authenticity is not independently proven; chain inclusion and publisher permission are not checked. Real version comparison remains unavailable. Development-network and testnet context are visible.

## Verification

- `pnpm --filter web build`: TypeScript and Vite pass. Existing Zod annotation, Bee browser-export and large-bundle warnings remain. Both new fonts are present in the production output.
- `git diff --cached --check`: passes.
- `pnpm --filter web test`: 7 tests pass, exercising the real verifier with synthetic evidence, tampering, invalid signer, unknown witness, unavailable data and index disagreement.
- `pnpm exec tsx apps/web/test/browser-review.ts`: passes in installed headless Chrome. Both routes were captured at 320, 390, 820 and 1440 px with no page overflow. Both local fonts load. Dark system preferences and previously stored dark settings still produce the light UI.
- Browser interactions passed at 390 and 1440 px: keyboard skip/focus/navigation, illustrative date switch, Tools/Escape, URL validation, lookup loading, no-results, controlled index error and retry, malformed local file, real checks of synthetic evidence, unknown witness, tampered transcript, original-byte download, long URL/filename/hash wrapping and non-execution of archived script content.
- Screenshots are under `test-results/recall-ui/` (gitignored). Landing, reader and checked-record screenshots were visually inspected. The refinement pass fixed event-name spacing, the compact reader wordmark, and an initial-focus issue caused by StrictMode effect replay.
- These browser RPC replies and signed evidence are test fixtures. No live index, Swarm gateway or capture-service availability is established by them. Partial index history handling remains implemented but was not exercised by the browser smoke test.
- Calculated contrast: body 14.67:1, muted copy 6.22:1, primary action 6.10:1, input edge 3.45:1; functional status text is at least 5.60:1. This is not a full accessibility certification.
- The broader evidence test collection cannot load two suites without `fixtures/notice/.certs/ca.pem`. The targeted statement suite passes 4 tests. No web lint script exists.

## Run locally

From the repository root, use `pnpm --filter web dev`. Open `http://localhost:5173/` for the landing page or `http://localhost:5173/#/reader` for the reader. Local-file inspection works without a devnet; URL lookup needs the configured index. The browser smoke test expects this dev server and an installed Chrome; it uses the existing root Playwright and tsx dependencies.
