import { expect, test, type Locator, type Page } from '@playwright/test';

// P5 live check (hosting): the web app, served from GitHub Pages and from Swarm, verifies
// the P2 live capture against the live networks (Arkiv Rabdi, Gnosis, the Swarm gateways).
//
// It runs only at the P5 gate, after `pnpm publish:swarm --net live` has put the app on
// Swarm mainnet and the Pages workflow has deployed /Recall/app/:
//
//   RECALL_LIVE_PUBLISH=1 \
//   RECALL_P5_CAPTURE_KEY=0x<entity key of the P2 live capture> \
//   RECALL_P5_REF=<bzz reference printed by publish-swarm>        (or RECALL_P5_SWARM_URL) \
//   pnpm test:live --grep p5
//
// Without RECALL_LIVE_PUBLISH=1 every test here is skipped, so the live project stays green
// before the gate. RECALL_P5_SWARM_URL overrides where the Swarm copy is opened from; by
// default it is the public gateway page for the reference. If the gateway holds HTML back
// before moderation, set RECALL_P5_SWARM_URL=http://localhost:1633/bzz/<ref>/ (a local Bee
// node that has the website) and record that in the evidence log: the test annotates which
// host served the app.

const PAGES_APP = 'https://localhostwastaken.github.io/Recall/app/';

const check = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => page.locator(`[data-check="${id}"]`);
const status = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => check(page, id).locator('[data-status]');
const verdict = (page: Page): Locator => page.locator('[data-verdict]');

function captureKey(): string {
  const key = process.env.RECALL_P5_CAPTURE_KEY ?? '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('RECALL_P5_CAPTURE_KEY must be the 0x entity key of the P2 live capture');
  }
  return key;
}

function swarmApp(): string {
  const url = process.env.RECALL_P5_SWARM_URL;
  if (url) return url.endsWith('/') ? url : `${url}/`;
  const ref = process.env.RECALL_P5_REF ?? '';
  if (!/^[0-9a-f]{64}$/i.test(ref)) throw new Error('set RECALL_P5_SWARM_URL, or RECALL_P5_REF (64 hex characters)');
  return `https://bzz.link/bzz/${ref}/`;
}

async function verifiesTheCapture(page: Page, app: string, label: string): Promise<void> {
  const hosts = new Set<string>();
  const errors: string[] = [];
  page.on('request', (r) => {
    if (/^https?:/.test(r.url())) hosts.add(new URL(r.url()).hostname);
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${app}#/c/${captureKey()}`);
  await expect(page.getByRole('heading', { level: 1 }), `${label}: capture page`).toBeVisible({ timeout: 60_000 });
  // The signature, the signed request/response and the live Swarm copy must all check out.
  // C (is the witness trusted?) may warn until the live witness is in the trusted list.
  for (const id of ['A', 'B', 'E'] as const) {
    await expect(status(page, id), `${label}: check ${id}`).toHaveAttribute('data-status', 'pass', { timeout: 90_000 });
  }
  await expect(status(page, 'C'), `${label}: check C`).toHaveAttribute('data-status', /^(pass|warn)$/);
  await expect(verdict(page), `${label}: verdict`).toHaveAttribute('data-verdict', /^(pass|warn)$/);

  test.info().annotations.push({
    type: `p5 ${label}`,
    description: `app ${app}; hosts contacted: ${[...hosts].sort().join(', ')}; C=${await status(page, 'C').getAttribute('data-status')}`,
  });
  expect(errors).toEqual([]);
}

// The full Chromium (new headless mode) is the browser installed for the other specs too.
test.use({ channel: 'chromium' });

test.describe('@live p5', () => {
  test.skip(process.env.RECALL_LIVE_PUBLISH !== '1', 'runs at the P5 gate: set RECALL_LIVE_PUBLISH=1');

  test('p5 pages app verifies the P2 capture', async ({ page }) => {
    await verifiesTheCapture(page, PAGES_APP, 'pages');
  });

  test('p5 swarm-hosted app verifies the same capture', async ({ page }) => {
    await verifiesTheCapture(page, swarmApp(), 'swarm');
  });
});
