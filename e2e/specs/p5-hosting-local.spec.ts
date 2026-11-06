import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { LOCAL } from '../../packages/net/src/index';
import { BEE_COMPOSE_FAUCET_KEY } from '../fixtures/keys';

// The app, hosted from Swarm instead of a web server: scripts/publish-swarm.ts builds
// apps/web, stamps every chunk with a key we hold (a depth-18 batch bought on the local
// Gnosis fork), pushes the chunks to the local Bee node and prints the website's
// reference. This spec then loads http://localhost:1633/bzz/<ref>/ like any visitor
// would, so the relative asset URLs, the manifest's index document and the hash routing
// are all proven under the exact path shape a Swarm gateway uses.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BEE = LOCAL.swarm.uploadUrl;
// The full Chromium (new headless mode) is the browser installed for the other specs too.
test.use({ channel: 'chromium' });

test('@p5 local swarm hosting', async ({ page }) => {
  test.setTimeout(480_000);

  // The real CLI, against the devnet: buys the batch, waits until Bee accepts its stamps
  // (about a minute on the fork), builds, uploads.
  const { stdout } = await promisify(execFile)(
    'pnpm',
    ['exec', 'tsx', 'scripts/publish-swarm.ts', '--net', 'local', '--bee', BEE, '--days', '1'],
    { cwd: ROOT, timeout: 420_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const ref = /^bzz reference: ([0-9a-f]{64})$/m.exec(stdout)?.[1];
  expect(ref, stdout).toBeDefined();
  const url = `${BEE}/bzz/${ref}/`;
  expect(stdout).toContain(url);
  // bzz.link takes the CID form as a subdomain (a 64-character hex label would exceed DNS's 63),
  // and the hex reference in the path form.
  expect(stdout).toMatch(/^bzz\.link: https:\/\/bah5[a-z2-7]+\.bzz\.link\/$/m);
  expect(stdout).toContain(`https://bzz.link/bzz/${ref}/`);
  // The payer key is also the stamp key; the output never carries it.
  expect(stdout.toLowerCase()).not.toContain(BEE_COMPOSE_FAUCET_KEY.slice(2).toLowerCase());

  // Every request the page makes: only this machine, never a CDN, font host or tracker.
  const hosts = new Set<string>();
  const failed: string[] = [];
  page.on('request', (req) => {
    if (/^https?:/.test(req.url())) hosts.add(new URL(req.url()).hostname);
  });
  page.on('requestfailed', (req) => failed.push(req.url()));
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  // Home, served from the manifest's index document at the bare /bzz/<ref>/ path.
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: 'Recall' })).toBeVisible();
  await expect(page.getByText('Prove what a web page said, even after it changes.')).toBeVisible();
  await expect(page.getByLabel('Page address')).toBeVisible();

  // Hash routing inside the Swarm path: no server rewrite is involved.
  await page.goto(`${url}#/storage`);
  await expect(page.getByRole('heading', { level: 1, name: 'Buy storage' })).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByText('Prove what a web page said, even after it changes.')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/bzz/${ref}/`);

  // The bare /bzz/<ref> (no trailing slash) lands on the same app.
  await page.goto(`${BEE}/bzz/${ref}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Recall' })).toBeVisible();

  // The JS and CSS came out of Swarm with the right types (a wrong type would have
  // stopped the module script, and the heading above would never have rendered).
  const assets = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src], link[rel=stylesheet]')].map(
      (el) => ('src' in el && el.src) || (el as HTMLLinkElement).href,
    ),
  );
  expect(assets.length).toBeGreaterThanOrEqual(2);
  for (const a of assets) expect(a.startsWith(`${BEE}/bzz/${ref}/assets/`), a).toBe(true);

  expect([...hosts]).toEqual(['localhost']);
  expect(failed).toEqual([]);
  expect(pageErrors).toEqual([]);
});
