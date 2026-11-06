import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
import { Bee, MantarayNode, feedOwnerOf, feedTopic } from '../../packages/net/src/hosting';
import { LOCAL } from '../../packages/net/src/index';
import { BEE_COMPOSE_FAUCET_KEY, OTHER_WALLET_ADDRESS, OTHER_WALLET_KEY } from '../fixtures/keys';

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
  await expect(page.getByRole('heading', { level: 1, name: "The web forgets. Recall doesn't." })).toBeVisible();
  // The old Home tools sit under "More ways to check" on the landing page.
  await page.locator('summary', { hasText: 'More ways to check' }).click();
  await expect(page.getByLabel('Page address')).toBeVisible();

  // Hash routing inside the Swarm path: no server rewrite is involved.
  await page.goto(`${url}#/storage`);
  await expect(page.getByRole('heading', { level: 1, name: 'Buy storage' })).toBeVisible();
  // The header's wordmark links home.
  await page.locator('header a[href="#/"]').first().click();
  await expect(page.getByRole('heading', { level: 1, name: "The web forgets. Recall doesn't." })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`/bzz/${ref}/`);

  // The manifest's error document is the index document: an unknown path serves the app too.
  const unknown = await fetch(`${url}no/such/page`);
  expect(Buffer.from(await unknown.arrayBuffer()).equals(readFileSync(join(ROOT, 'apps/web/dist/index.html')))).toBe(true);

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

    // Interoperability with bee-js itself. (1) The feed manifest is byte for byte what bee-js
    // createFeedManifest stores (same reference). (2) bee-js resolves OUR feed manifest to the
    // site, with its own manifest + feed reader. (3) Its feed reader reads our update.
    const bee = new Bee(BEE);
    const { owner: feedOwnerAddr } = feedOwnerOf(BEE_COMPOSE_FAUCET_KEY);
    const topicValue = feedTopic(topic);
    const stamps = ((await (await fetch(`${BEE}/stamps`)).json()) as { stamps: { batchID: string; usable: boolean }[] }).stamps;
    const nodeBatch = stamps.find((st) => st.usable)!.batchID;
    expect((await bee.feed.createManifest(nodeBatch, topicValue, feedOwnerAddr)).toHex()).toBe(feedRef);
    const manifest = await MantarayNode.unmarshal(bee, feedRef!);
    await manifest.loadRecursively(bee);
    const resolved = await manifest.resolveFeed(bee);
    // Bee 2.x serves the feed's target content from GET /feeds, so the payload bee-js gets is the
    // site's root manifest chunk (the same bytes /bytes/<site reference> returns).
    const siteRoot = Buffer.from(await (await fetch(`${BEE}/bytes/${siteOne}`)).arrayBuffer());
    expect(Buffer.from(resolved.getOrThrow().payload.toUint8Array()).equals(siteRoot)).toBe(true);
    const read = await bee.feed.makeReader(topicValue, feedOwnerAddr).downloadReference();
    expect(read.reference.toHex()).toBe(siteOne);

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

    // A resume on the same (already used) batch: the site manifest is deterministic, so the same
    // directory gives the same site reference, and the feed takes the next index.
    const batchId = /^batch: (0x[0-9a-f]{64})/m.exec(second)?.[1];
    expect(batchId, second).toBeDefined();
    const third = (await publish(['--net', 'local', '--bee', BEE, '--batch', batchId!, '--no-wait', '--dir', dir, '--feed', '--feed-topic', topic], env)).stdout;
    expect(/^bzz reference: ([0-9a-f]{64})$/m.exec(third)?.[1]).toBe(siteTwo);
    expect(/^feed manifest reference: ([0-9a-f]{64})$/m.exec(third)?.[1]).toBe(feedRef);
    expect(third).toContain('feed update: index 2');
    await servesEventually(feedRef!, page('two'));
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

// The spend caps refuse before the build and before any transaction (local fork, no real funds).
test('@p5 live publish spend caps', async () => {
  const live = ['--net', 'live', '--gnosis-rpc', LOCAL.gnosis.rpcUrl, '--bee', BEE, '--yes'];
  const env = { TREASURY_PRIVATE_KEY: BEE_COMPOSE_FAUCET_KEY };
  const fails = async (extra: string[]) => {
    const e = await publish([...live, ...extra], env).then(
      () => undefined,
      (x: { stdout?: string; stderr?: string }) => x,
    );
    expect(e, `${extra.join(' ')} must fail`).toBeDefined();
    expect(e!.stdout ?? '').not.toContain('Building apps/web');
    expect(e!.stdout ?? '').not.toContain('Batch 0x');
    return e!.stderr ?? '';
  };
  expect(await fails(['--days', '91'])).toContain('at most 90');
  expect(await fails(['--max-xbzz', '0.000001'])).toContain('--max-xbzz');
  expect(await fails(['--max-xbzz', 'lots'])).toContain('--max-xbzz');
});

// A live-mode run against the local fork (--net live --gnosis-rpc <fork> --bee <local>, so no real
// funds): the state file records the batch and the last feed index, a second run takes the next
// index and a fresh batch, and a run is refused (before anything is bought) when the state says a
// batch is unfinished or that this machine already wrote a higher feed index than the node reports.
test('@p5 live-mode state file and feed index memory', async () => {
  test.setTimeout(600_000);
  const dir = mkdtempSync(join(tmpdir(), 'recall-state-site-'));
  try {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("state test");\n');
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>state</title><p>state test</p>');
    const stateFile = join(dir, 'state.json');
    const topic = `recall-state-${Date.now()}`;
    // --read: a live run reads back through the public download gateway by default; here the site is only on the local node.
    const base = ['--net', 'live', '--gnosis-rpc', LOCAL.gnosis.rpcUrl, '--bee', BEE, '--read', BEE, '--yes', '--days', '1', '--dir', dir, '--feed', '--feed-topic', topic];
    // A public test key owns the feed (a live run reads HOSTING_FEED_KEY, and .env.local may hold a real one).
    const env = { TREASURY_PRIVATE_KEY: BEE_COMPOSE_FAUCET_KEY, HOSTING_FEED_KEY: OTHER_WALLET_KEY, RECALL_STATE_FILE: stateFile };
    const state = () => JSON.parse(readFileSync(stateFile, 'utf8')) as { batch: Record<string, string>; lastFeed: Record<string, string> };
    const refused = async () => {
      const e = await publish(base, env).then(
        () => undefined,
        (x: { stdout?: string; stderr?: string }) => x,
      );
      expect(e, 'the run must be refused').toBeDefined();
      expect(e!.stdout ?? '').not.toContain('Batch purchase sent');
      expect(e!.stdout ?? '').not.toContain('Building apps/web');
      return e!.stderr ?? '';
    };

    // First run: a fresh batch, feed index 0.
    const first = (await publish(base, env)).stdout;
    expect(first).toMatch(/^Batch purchase sent: 0x[0-9a-f]{64} /m);
    expect(first).toContain('feed update: index 0');
    const batchOne = /^batch: (0x[0-9a-f]{64})/m.exec(first)![1];
    const afterOne = state();
    expect(afterOne.batch).toMatchObject({ status: 'done', batchId: batchOne });
    expect(afterOne.batch.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(afterOne.lastFeed).toMatchObject({ owner: OTHER_WALLET_ADDRESS, topic, index: '0' });
    expect(first.toLowerCase()).not.toContain(OTHER_WALLET_KEY.slice(2).toLowerCase());
    expect(first.toLowerCase()).not.toContain(BEE_COMPOSE_FAUCET_KEY.slice(2).toLowerCase());

    // A batch that was bought and not used up blocks a second purchase, and the text names it.
    const fake = `0x${'ab'.repeat(32)}`;
    writeFileSync(stateFile, JSON.stringify({ ...afterOne, batch: { status: 'bought', batchId: fake, dir, at: 't' } }));
    const stuck = await refused();
    expect(stuck).toContain('not paying again');
    expect(stuck).toContain(`--batch ${fake}`);
    expect(stuck).toContain('--new-batch');

    // A purchase that was only sent (no batch id yet) blocks too, pointing at its transaction.
    writeFileSync(stateFile, JSON.stringify({ ...afterOne, batch: { status: 'sent', txHash: `0x${'12'.repeat(32)}`, dir, at: 't' } }));
    const sent = await refused();
    expect(sent).toContain(`tx 0x${'12'.repeat(32)}`);
    expect(sent).toContain('gnosisscan');

    // The state remembers update 5 was written; the node reports index 1: refused before buying.
    writeFileSync(stateFile, JSON.stringify({ ...afterOne, lastFeed: { ...afterOne.lastFeed, index: '5' } }));
    const stale = await refused();
    expect(stale).toContain('already wrote update 5');
    expect(stale).toContain('Nothing was bought');

    // Back to the true state: the next run takes index 1 on a NEW batch, with a fresh record.
    writeFileSync(stateFile, JSON.stringify(afterOne));
    const second = (await publish(base, env)).stdout;
    expect(second).toContain('feed update: index 1');
    const batchTwo = /^batch: (0x[0-9a-f]{64})/m.exec(second)![1];
    expect(batchTwo).not.toBe(batchOne);
    const afterTwo = state();
    expect(afterTwo.batch).toMatchObject({ status: 'done', batchId: batchTwo });
    expect(afterTwo.batch.txHash).not.toBe(afterOne.batch.txHash);
    expect(afterTwo.lastFeed.index).toBe('1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
