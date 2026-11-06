import { expect, test, type Locator, type Page } from '@playwright/test';
import { canonicalUrl, urlHash } from '../../packages/evidence/src/index';

// P3 live check (browse and verify): the deployed web app lists the live captures of the Pages
// notice for its address (`#/u/<urlHash>`, read from Arkiv Rabdi), and the newest one opens and
// verifies A to E against the live networks: signature, request/response, trusted witness,
// and the Swarm copy. This is what each teammate sees after `pnpm fund` + their own capture.
//
//   pnpm test:live --grep p3
//
// A live capture of the notice (the P2 gate: the extension captured it, MetaMask published it)
// has to exist first. Until it does the test SKIPS with a message; it never passes without a
// verified capture. Read-only: nothing is written to any chain.
//
// Optional:
//   RECALL_P3_APP=<url>   The app to open (default: GitHub Pages). For a local build against the
//                         live networks use the dev server with `?net=live`, e.g.
//                         RECALL_P3_APP='http://localhost:5173/?net=live'.
//   RECALL_P3_URL=<url>   The captured page to look up (default: the Pages notice).

const PAGES_APP = 'https://localhostwastaken.github.io/Recall/app/';
const NOTICE_URL = 'https://localhostwastaken.github.io/Recall/notice/';

/** The app to open, ending in `/` (or a query) so that `#/u/...` can be appended. */
function appUrl(): string {
  const app = process.env.RECALL_P3_APP || PAGES_APP;
  return app.includes('?') || app.endsWith('/') ? app : `${app}/`;
}

const check = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => page.locator(`[data-check="${id}"]`);
const status = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => check(page, id).locator('[data-status]');

// The full Chromium (new headless mode) is the browser installed for the other specs too.
test.use({ channel: 'chromium' });

test.describe('@live p3', () => {
  test('p3 the live notice capture lists on the timeline and verifies A to E', async ({ page }) => {
    test.setTimeout(300_000);
    const app = appUrl();
    const url = canonicalUrl(process.env.RECALL_P3_URL || NOTICE_URL);
    const hash = urlHash(url);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // The Pages app can take 25 s or more to finish loading (the `load` event), so wait for content.
    await page.goto(`${app}#/u/${hash}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 120_000 });

    // The timeline settles into one of four states.
    const version = page.locator('[data-timeline] [data-kind="version"]').first();
    const nothingYet = page.getByText('No captures of this page yet.');
    const unreachable = page.getByText("Couldn't reach Arkiv.");
    const nonePassed = page.getByText('No capture of this page passed its checks.');
    await expect(version.or(nothingYet).or(unreachable).or(nonePassed)).toBeVisible({ timeout: 120_000 });

    test.skip(
      await nothingYet.isVisible(),
      `no live capture of ${url} is indexed on Arkiv Rabdi yet (urlHash ${hash}): make the P2 live capture first, then rerun`,
    );
    await expect(unreachable, 'the app could not read Arkiv').toBeHidden();
    await expect(nonePassed, 'records exist for this address but none passed its checks').toBeHidden();

    // At least one capture is listed as verified; open the newest.
    const versions = await page.locator('[data-timeline] [data-kind="version"]').count();
    const confirmations = await page.locator('[data-timeline] [data-kind="confirmation"]').count();
    expect(versions).toBeGreaterThanOrEqual(1);
    const entity = await page.locator('[data-timeline] [data-kind="version"]').last().getAttribute('data-entity');
    expect(entity).toMatch(/^0x[0-9a-fA-F]{64}$/);
    await page.locator(`[data-kind="version"][data-entity="${entity}"] a.tl-link`).click();
    await expect(page).toHaveURL(new RegExp(`#/c/${entity}$`));

    // A, B, E pass; C passes for the app's default (live) witness; D waits for a dropped file.
    for (const id of ['A', 'B', 'C', 'E'] as const) {
      await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass', { timeout: 90_000 });
    }
    await expect(status(page, 'D'), 'check D (no file given)').toHaveAttribute('data-status', 'unavailable');
    await expect(page.locator('[data-verdict]')).toHaveAttribute('data-verdict', 'pass');

    test.info().annotations.push({
      type: 'p3 live',
      description: `app ${app}; ${url} (${hash}); ${versions} version(s), ${confirmations} confirmation(s); opened ${entity}`,
    });
    expect(errors).toEqual([]);
  });
});
