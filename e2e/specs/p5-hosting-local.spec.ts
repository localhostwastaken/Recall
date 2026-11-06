import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
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
  // The index document and one script (read through the manifest) were read back and compared.
  expect(stdout).toContain('Verified: index document');
  expect(stdout).toContain('Verified: JS asset');
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

const publish = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  promisify(execFile)('pnpm', ['exec', 'tsx', 'scripts/publish-swarm.ts', ...args], {
    cwd: ROOT,
    timeout: 420_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...env },
  });

// A feed gives the site a stable address: the feed manifest reference stays the same while each
// publish adds an update that points at the new site. Two publishes of a small site (a bought
// batch each, about a minute apart on the fork) under one topic.
test('@p5 local swarm feed', async () => {
  test.setTimeout(900_000);
  const dir = mkdtempSync(join(tmpdir(), 'recall-feed-site-'));
  try {
    mkdirSync(join(dir, 'assets'));
    // Over 4 KB, so the script splits across several chunks and builds a chunk tree.
    const big = Buffer.from(Array.from({ length: 12_000 }, (_, i) => `// line ${i}\n`).join(''));
    writeFileSync(join(dir, 'assets', 'app.js'), big);
    const page = (v: string) => `<!doctype html><title>feed ${v}</title><p>version ${v}</p>`;
    const topic = `recall-test-${Date.now()}`;
    // HOSTING_FEED_KEY may be in .env.local; the local run must use the payer key.
    const args = ['--net', 'local', '--bee', BEE, '--days', '1', '--dir', dir, '--feed', '--feed-topic', topic];
    const env = { HOSTING_FEED_KEY: '' };
    const owner = privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY).address;
    const served = async (ref: string, path = '') => {
      const res = await fetch(`${BEE}/bzz/${ref}/${path}`);
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
    };
    const servesEventually = async (ref: string, want: string) => {
      // A node may need a few seconds to resolve a feed it has just been given an update for.
      let got = '';
      for (let i = 0; i < 40 && got !== want; i++) {
        const r = await served(ref);
        got = r.status === 200 ? r.bytes.toString() : `HTTP ${r.status}`;
        if (got !== want) await new Promise((r2) => setTimeout(r2, 1500));
      }
      expect(got).toBe(want);
    };

    writeFileSync(join(dir, 'index.html'), page('one'));
    const first = (await publish(args, env)).stdout;
    const feedRef = /^feed manifest reference: ([0-9a-f]{64})$/m.exec(first)?.[1];
    const siteOne = /^bzz reference: ([0-9a-f]{64})$/m.exec(first)?.[1];
    expect(feedRef, first).toBeDefined();
    expect(siteOne, first).toBeDefined();
    expect(first).toContain(`feed owner: ${owner}`);
    expect(first).toContain('feed update: index 0');
    expect(first).toContain('Verified: the feed');
    expect(first).toMatch(/^feed bzz\.link: https:\/\/bah5[a-z2-7]+\.bzz\.link\/$/m);
    expect(first).toContain(`https://bzz.link/bzz/${feedRef}/`);
    expect(first.toLowerCase()).not.toContain(BEE_COMPOSE_FAUCET_KEY.slice(2).toLowerCase());
    await servesEventually(feedRef!, page('one'));
    // A file below the root of the site, through the feed.
    expect((await served(feedRef!, 'assets/app.js')).bytes.equals(big)).toBe(true);

    // Publish a new version: same feed manifest, the next index, the new content.
    writeFileSync(join(dir, 'index.html'), page('two'));
    const second = (await publish(args, env)).stdout;
    expect(/^feed manifest reference: ([0-9a-f]{64})$/m.exec(second)?.[1]).toBe(feedRef);
    expect(second).toContain('feed update: index 1');
    const siteTwo = /^bzz reference: ([0-9a-f]{64})$/m.exec(second)?.[1];
    expect(siteTwo).not.toBe(siteOne);
    await servesEventually(feedRef!, page('two'));
    // The first version is still there by its own reference.
    expect((await served(siteOne!)).bytes.toString()).toBe(page('one'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The run that would spend xBZZ on Gnosis mainnet needs --yes, and says so before it builds the
// app or buys anything. Pointed at the local fork (--gnosis-rpc) with the public faucet key, so
// nothing leaves this machine.
test('@p5 live publish without --yes stops before building', async () => {
  const run = publish(['--net', 'live', '--gnosis-rpc', LOCAL.gnosis.rpcUrl, '--bee', BEE], {
    TREASURY_PRIVATE_KEY: BEE_COMPOSE_FAUCET_KEY,
  });
  const err = await run.then(
    () => undefined,
    (e: { code?: number; stdout?: string; stderr?: string }) => e,
  );
  expect(err, 'the run must fail without --yes').toBeDefined();
  expect(err!.stderr).toContain('--yes');
  expect(err!.stdout ?? '').not.toContain('Building apps/web');
  expect(err!.stdout ?? '').not.toContain('Batch 0x');
});
