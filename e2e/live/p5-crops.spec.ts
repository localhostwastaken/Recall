import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { getAddress, type Address, type Hex } from 'viem';
import { decodeEvidence, runChecks } from '../../packages/evidence/src/index';
import { arkivPublic, downloadBytes, latestWitnessUrl, liveConfig } from '../../packages/net/src/index';

// P5 live check (CROPS): the three "Recall is gone, the evidence is not" moments of the demo, on
// the live networks, against the P2 live capture (docs/evidence-log.md, "2026-11-06 live P2 check").
//
// 1. Witness down: the RELEASE extension's popup says "Witness offline" and Capture is disabled,
//    while the deployed GitHub Pages app still verifies the capture (A to C pass). Then the
//    witness comes back and the popup says "Witness online" again.
//    - By default the witness is made unreachable for this browser only: the extension's service
//      worker (where the popup's /info probe runs) refuses the witness's origins, and Playwright
//      routes refuse them for pages. The real container and tunnel are not touched.
//    - RECALL_P5_STOP_WITNESS=1 stops the real container (`docker stop recall-witness-live`), as the
//      demo does on camera. It is ALWAYS started again (finally block and afterAll), and the run
//      waits until /info answers locally and through the tunnel. If a run is killed in that mode,
//      run `docker start recall-witness-live` by hand.
// 2. Mirror gone: with every request to GitHub Pages refused, the copy of the app on Swarm (its
//    feed manifest) loads, verifies the capture by its record link, lists it on its timeline and
//    downloads its evidence file. On that shared /bzz/ origin the app ignores stored settings (R38)
//    and uses its defaults, which is all this needs.
//    - The app is opened through a Swarm node of our own, by default an ultra-light reader on
//      127.0.0.1:1733 (no wallet, no chain, no funds; docs/demo-script.md starts one). The public
//      gateways cannot show it in a browser yet: download.gateway.ethswarm.org sends every /bzz/ file
//      with `Content-Disposition: attachment` (the browser saves index.html instead of showing it),
//      and bzz.link and api.gateway redirect to bzz.link/forbidden until the hash is allowlisted.
//      The spec checks that the download gateway holds the same index.html bytes as our node.
//    - RECALL_P5_SWARM_URL opens another copy instead (the bzz.link URL once it is allowlisted);
//      RECALL_P5_BEE_URL names another node.
// 3. Fully offline: this checkout's live web build (apps/web/dist, `VITE_RECALL_NET=live pnpm
//    --filter web build`), served from 127.0.0.1, loads; then the browser goes offline (and every
//    request is refused as well) and the capture's evidence file, downloaded from Swarm, is dropped
//    in: A to C pass, E is not checked, and the app says it checked offline.
//
// Nothing here spends anything.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_BUILD_DIR = join(ROOT, 'extension/packages/extension/build-release');
const APP_DIST = resolve(process.env.RECALL_P5_APP_DIST || join(ROOT, 'apps/web/dist'));

const PAGES_HOST = 'localhostwastaken.github.io';
const PAGES_APP = `https://${PAGES_HOST}/Recall/app/`;
const NOTICE_URL = `https://${PAGES_HOST}/Recall/notice/`;
/** The app on Swarm: the feed manifest (stable across republishes; docs/evidence-log.md). */
const FEED_MANIFEST = 'e002e9ab0bee50f874a8ee461fe053aca71c7e3be502b941d8933008e357f9e0';
/** A Swarm node of our own (an ultra-light reader is enough). */
const SWARM_NODE = (process.env.RECALL_P5_BEE_URL || 'http://127.0.0.1:1733').replace(/\/$/, '');
const GATEWAY_APP = `https://download.gateway.ethswarm.org/bzz/${FEED_MANIFEST}/`;

/** The P2 live capture: its Arkiv record, its evidence on Swarm and the page it holds. */
const ENTITY: Hex = '0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244';
const EVIDENCE_REF: Hex = '0x4dde720fa70159f4e335e165a2b8b93b5aec439ac9f5dbd06cf389856bb13202';
const CAPTURED_URL = `${NOTICE_URL}?run=0tzgmo55`;
const CAPTURED_URL_HASH: Hex = '0x1dcb2cebcb3bd31e55a91320ca7523c83abc0faaad0b5b32c0cdd4ecce872540';
const DOWNLOAD_GATEWAYS = ['https://download.gateway.ethswarm.org', 'https://bzz.link'];

const LIVE_WITNESS: Address = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';
const LIVE_CONTAINER = 'recall-witness-live';
const LOCAL_WITNESS_URL = 'http://127.0.0.1:7048';
/** The public Rabdi endpoint (no access key in any URL this test could print). */
const RABDI_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
const STOP_FOR_REAL = process.env.RECALL_P5_STOP_WITNESS === '1';

// UDP to Cloudflare-fronted hosts is throttled on this network (see p2-live).
const ARGS = ['--disable-quic'];

const check = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => page.locator(`[data-check="${id}"]`);
const status = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => check(page, id).locator('[data-status]');
const verdict = (page: Page): Locator => page.locator('[data-verdict]');
// getByLabel matches substrings, and a drop zone's group name contains its input's name.
const fileInput = (page: Page, name: string): Locator => page.getByLabel(name, { exact: true });

/** Notes a result in the report and on the console (nothing secret goes in). */
function note(type: string, value: object): void {
  const description = JSON.stringify(value);
  console.log(`P5 CROPS ${type}`, description);
  test.info().annotations.push({ type: `p5 crops ${type}`, description });
}

/** The capture's evidence, from Swarm, checked against its reference (memoised). */
let evidenceCache: Promise<Uint8Array> | undefined;
function evidenceFromSwarm(): Promise<Uint8Array> {
  evidenceCache ??= downloadBytes(EVIDENCE_REF, DOWNLOAD_GATEWAYS).then(({ bytes, rootVerified }) => {
    if (!rootVerified) throw new Error('the evidence downloaded from Swarm was not checked against its reference');
    return bytes;
  });
  return evidenceCache;
}

/** /info of a witness URL: its signer, or why there is none. */
async function infoSigner(url: string): Promise<string> {
  try {
    const res = await fetch(new URL('/info', url), { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (!res.ok) return `HTTP ${res.status}`;
    const body = (await res.json()) as { signer?: string };
    return body.signer ?? 'no signer';
  } catch (e) {
    return `unreachable (${(e as Error).message})`;
  }
}

/** The capture page of `app` verifies the P2 capture: A, B and C pass, and so does the verdict. */
async function verifiesTheCapture(page: Page, app: string, label: string): Promise<void> {
  await page.goto(`${app}#/c/${ENTITY}`);
  await expect(page.getByRole('heading', { level: 1 }), `${label}: capture page`).toContainText(PAGES_HOST, { timeout: 60_000 });
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id), `${label}: check ${id}`).toHaveAttribute('data-status', 'pass', { timeout: 120_000 });
  }
  await expect(verdict(page), `${label}: verdict`).toHaveAttribute('data-verdict', 'pass');
  await expect(page.locator('.exhibit'), `${label}: the captured address`).toContainText(CAPTURED_URL);
  // E reads the storage end dates from Gnosis and Arkiv: it passes, or warns when under a week is left.
  await expect(status(page, 'E'), `${label}: check E`).toHaveAttribute('data-status', /^(pass|warn)$/, { timeout: 60_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('@live p5 crops', () => {
  test.beforeAll(async () => {
    // The capture's evidence must be on Swarm before anything else means something.
    const bytes = await evidenceFromSwarm();
    const report = await runChecks(decodeEvidence(bytes), { pinnedWitnesses: [LIVE_WITNESS] });
    expect([report.A.status, report.B.status, report.C.status], [report.A.detail, report.B.detail, report.C.detail].join(' | ')).toEqual([
      'pass',
      'pass',
      'pass',
    ]);
    expect(report.facts?.canonicalUrl).toBe(CAPTURED_URL);
    expect(new TextDecoder().decode(report.facts!.body)).toContain('15 December');
  });

  // --- 1. Witness down -----------------------------------------------------------------------

  let extContext: BrowserContext | undefined;
  let extensionId = '';
  /** Set while this run has the real container stopped; cleared once it answers again. */
  let containerStopped = false;

  /** Starts the real container again (if this run stopped it) and waits until /info answers. Idempotent. */
  async function restoreWitness(): Promise<void> {
    if (!containerStopped) return;
    execFileSync('docker', ['start', LIVE_CONTAINER], { encoding: 'utf8', timeout: 60_000 });
    const tunnel = (process.env.WITNESS_PUBLIC_URL ?? '').replace(/\/$/, '');
    const deadline = Date.now() + 90_000;
    let local = '';
    let viaTunnel = '';
    while (Date.now() < deadline) {
      local = await infoSigner(LOCAL_WITNESS_URL);
      viaTunnel = tunnel ? await infoSigner(tunnel) : LIVE_WITNESS;
      if (local === LIVE_WITNESS && viaTunnel === LIVE_WITNESS) {
        containerStopped = false;
        return;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(`the witness did not come back after docker start: local ${local}, tunnel ${viaTunnel}`);
  }

  test.afterAll(async () => {
    // Belt and braces: a failed or timed-out test still leaves the witness running.
    await restoreWitness();
    await extContext?.close();
  });

  /** The extension's live service worker (Chrome may replace the first one right after launch). */
  function sw(): Worker {
    const live = extContext!.serviceWorkers().filter((w) => w.url().includes(extensionId));
    if (!live.length) throw new Error('the extension service worker is gone');
    return live[live.length - 1]!;
  }

  /** Makes the witness's origins unreachable for the extension's service worker, or reachable again. */
  async function swBlocks(origins: string[]): Promise<void> {
    await sw().evaluate((blocked) => {
      type G = { fetch: typeof fetch; __p5RealFetch?: typeof fetch; __p5Blocked?: string[] };
      const g = globalThis as unknown as G;
      g.__p5RealFetch ??= g.fetch;
      g.__p5Blocked = blocked;
      g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        let origin = '';
        try {
          origin = new URL(href).origin;
        } catch {
          /* a relative URL: never the witness */
        }
        if (g.__p5Blocked!.includes(origin)) return Promise.reject(new TypeError('Failed to fetch'));
        return g.__p5RealFetch!(input, init);
      }) as typeof fetch;
    }, origins);
  }

  test('p5 crops witness down: captures pause while the app still verifies', async () => {
    test.setTimeout(420_000);
    if (!existsSync(join(RELEASE_BUILD_DIR, 'manifest.json'))) {
      throw new Error(`No release build at ${RELEASE_BUILD_DIR}. Run: pnpm extension:release`);
    }
    // Before: the live witness is up, locally and through the tunnel, and announced on Arkiv.
    const tunnel = (process.env.WITNESS_PUBLIC_URL ?? '').replace(/\/$/, '');
    expect(tunnel, 'WITNESS_PUBLIC_URL (.env.local) must be the tunnel URL').toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
    expect(await infoSigner(LOCAL_WITNESS_URL), `the live witness on ${LOCAL_WITNESS_URL}`).toBe(LIVE_WITNESS);
    expect(await infoSigner(tunnel), 'the live witness through the tunnel').toBe(LIVE_WITNESS);
    const rabdi = arkivPublic({ ...liveConfig({}), arkiv: { chain: 'rabdi', rpcUrl: RABDI_RPC } });
    expect(await latestWitnessUrl(rabdi, LIVE_WITNESS), 'run pnpm witness:announce --net live').toBe(tunnel);
    const witnessOrigins = [new URL(tunnel).origin, new URL(LOCAL_WITNESS_URL).origin, 'http://localhost:7048'];

    // The release extension, as a person installs it: default settings, so it finds the witness
    // from the witness's Arkiv profile (the tunnel URL).
    extContext = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${RELEASE_BUILD_DIR}`, `--load-extension=${RELEASE_BUILD_DIR}`, ...ARGS],
    });
    const first =
      extContext.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://')) ??
      (await extContext.waitForEvent('serviceworker', { timeout: 15_000 }));
    extensionId = new URL(first.url()).host;
    for (let i = 0, settled = false; !settled; i++) {
      if (i === 10) throw new Error('the extension service worker keeps restarting');
      const w = sw();
      let closed = false;
      w.once('close', () => (closed = true));
      await new Promise((r) => setTimeout(r, 1_500));
      settled = !closed && sw() === w;
    }
    const manifest = await sw().evaluate(() => {
      const g = globalThis as unknown as { chrome: { runtime: { getManifest(): { name: string } } }; recall?: unknown };
      return { name: g.chrome.runtime.getManifest().name, hook: typeof g.recall };
    });
    expect(manifest).toEqual({ name: 'Recall', hook: 'undefined' });

    const tab = await extContext.newPage();
    await tab.goto(NOTICE_URL);
    const tabId = await sw().evaluate(async (u) => {
      const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } })
        .chrome.tabs;
      return (await tabs.query({})).find((t) => t.url === u)?.id ?? null;
    }, NOTICE_URL);
    expect(tabId, `a tab showing ${NOTICE_URL}`).not.toBeNull();
    const popup = await extContext.newPage();
    const captureButton = popup.locator('.popup-footer').getByRole('button', { name: 'Capture this page' });
    /** Opens the popup until the witness chip settles on `want` (a cold profile read can miss once). */
    const popupShows = async (want: 'Witness online' | 'Witness offline', tries: number) => {
      for (let i = 1; ; i++) {
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
        await expect(popup.getByText(/^(Witness online|Witness offline)$/).first()).toBeVisible({ timeout: 30_000 });
        if (await popup.getByText(want, { exact: true }).first().isVisible()) return i;
        if (i >= tries) throw new Error(`the popup did not show "${want}": ${(await popup.locator('body').innerText()).replace(/\s+/g, ' ')}`);
      }
    };

    // Control: with the witness up, the popup finds it and Capture can be pressed.
    const onlineTries = await popupShows('Witness online', 3);
    await expect(captureButton).toBeEnabled();

    // Witness down.
    const appPage = await extContext.newPage();
    const witnessRequests: string[] = [];
    appPage.on('request', (r) => {
      if (witnessOrigins.some((o) => r.url().startsWith(o))) witnessRequests.push(r.url());
    });
    try {
      if (STOP_FOR_REAL) {
        containerStopped = true;
        execFileSync('docker', ['stop', LIVE_CONTAINER], { encoding: 'utf8', timeout: 60_000 });
        await expect.poll(() => infoSigner(LOCAL_WITNESS_URL), { timeout: 30_000 }).toMatch(/^unreachable|^HTTP/);
        await expect.poll(() => infoSigner(tunnel), { timeout: 30_000 }).toMatch(/^unreachable|^HTTP/);
      } else {
        await swBlocks(witnessOrigins);
        for (const o of witnessOrigins) await extContext.route(`${o}/**`, (r) => r.abort('connectionrefused'));
      }

      // The popup: "Witness offline", new captures paused, Capture disabled.
      await popupShows('Witness offline', 1);
      await expect(popup.getByText('New captures are paused until the witness is back.', { exact: false })).toBeVisible();
      await expect(popup.getByText('Existing captures can still be verified by anyone.', { exact: false })).toBeVisible();
      await expect(captureButton).toBeDisabled();
      await expect(popup.locator('#capture-helper')).toHaveText('The witness is offline, so new captures are paused.');
      const popupText = (await popup.locator('main').innerText()).replace(/\s+/g, ' ');

      // Meanwhile the deployed app verifies the capture: it never needs the witness.
      await verifiesTheCapture(appPage, PAGES_APP, 'pages, witness down');
      expect(witnessRequests, 'the app never calls the witness').toEqual([]);

      note('witness down', {
        how: STOP_FOR_REAL ? `docker stop ${LIVE_CONTAINER}` : 'witness origins refused in this browser',
        onlineTries,
        popup: popupText,
        app: `${PAGES_APP}#/c/${ENTITY}`,
        checks: Object.fromEntries(
          await Promise.all((['A', 'B', 'C', 'E'] as const).map(async (id) => [id, await status(appPage, id).getAttribute('data-status')])),
        ),
      });
    } finally {
      if (STOP_FOR_REAL) await restoreWitness();
      else {
        await swBlocks([]).catch(() => undefined);
        await extContext.unrouteAll({ behavior: 'ignoreErrors' });
      }
    }

    // Back up: "Try again" finds the witness, and Capture can be pressed again.
    const again = popup.getByRole('button', { name: 'Try again' });
    await again.click();
    await expect
      .poll(
        async () => {
          await expect(popup.getByText(/^(Witness online|Witness offline)$/).first()).toBeVisible({ timeout: 30_000 });
          if (await popup.getByText('Witness online', { exact: true }).first().isVisible()) return 'online';
          if (await again.isVisible()) await again.click();
          return 'offline';
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe('online');
    await expect(captureButton).toBeEnabled();
  });

  // --- 2. Mirror gone ------------------------------------------------------------------------

  test('p5 crops mirror gone: the Swarm-hosted app loads and verifies', async () => {
    test.setTimeout(300_000);
    // Which copy: the one named, else the app through our own Swarm node.
    let SWARM_APP = process.env.RECALL_P5_SWARM_URL ?? '';
    if (!SWARM_APP) {
      const health = await fetch(`${SWARM_NODE}/health`, { signal: AbortSignal.timeout(5_000) })
        .then((r) => (r.ok ? 'ok' : `HTTP ${r.status}`))
        .catch((e: Error) => e.message);
      expect(health, `no Swarm node at ${SWARM_NODE}: start the reader node (docs/demo-script.md) or set RECALL_P5_SWARM_URL`).toBe('ok');
      SWARM_APP = `${SWARM_NODE}/bzz/${FEED_MANIFEST}/`;
    }
    if (!SWARM_APP.endsWith('/')) SWARM_APP += '/';
    // The same index.html bytes come from Swarm through the public download gateway, which offers
    // them as a download (Content-Disposition), not as a page: noted, so a change there shows up.
    const [ours, viaGateway] = await Promise.all(
      [SWARM_APP, GATEWAY_APP].map((u) =>
        fetch(u, { signal: AbortSignal.timeout(120_000) }).then(async (r) => ({
          status: r.status,
          disposition: r.headers.get('content-disposition'),
          feedIndex: r.headers.get('swarm-feed-index'),
          body: Buffer.from(await r.arrayBuffer()),
        })),
      ),
    );
    expect(ours!.status, `${SWARM_APP} answers`).toBe(200);
    expect(viaGateway!.status, `${GATEWAY_APP} answers`).toBe(200);
    expect(Buffer.compare(ours!.body, viaGateway!.body), 'the gateway serves the same index.html').toBe(0);

    const browser: Browser = await chromium.launch({ channel: 'chromium', headless: !process.env.HEADED, args: ARGS });
    try {
      const context = await browser.newContext({ colorScheme: 'light', acceptDownloads: true });
      // GitHub Pages is gone: every request to it is refused.
      const toPages: string[] = [];
      await context.route((url) => url.hostname === PAGES_HOST, (route) => {
        toPages.push(route.request().url());
        return route.abort('connectionrefused');
      });
      const probe = await context.newPage();
      await expect(probe.goto(PAGES_APP), 'the Pages mirror is unreachable in this browser').rejects.toThrow();
      await probe.close();
      toPages.length = 0;
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await verifiesTheCapture(page, SWARM_APP, 'swarm');
      // The page really is the Swarm copy.
      const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src));
      expect(scripts.length).toBeGreaterThan(0);
      for (const src of scripts) expect(src.startsWith(SWARM_APP), src).toBe(true);

      // The timeline of the captured address lists the capture.
      await page.locator('.page-actions').getByRole('link', { name: 'View timeline' }).click();
      await expect(page).toHaveURL(new RegExp(`#/u/${CAPTURED_URL_HASH}$`));
      await expect(page.locator(`.tl-item[data-entity="${ENTITY}"]`)).toBeVisible({ timeout: 120_000 });

      // Its evidence file downloads from this copy, byte for byte what Swarm holds.
      await page.goto(`${SWARM_APP}#/c/${ENTITY}`);
      await expect(status(page, 'A')).toHaveAttribute('data-status', 'pass', { timeout: 120_000 });
      const download = page.locator('.page-actions').getByRole('button', { name: 'Download evidence file' });
      await expect(download).toBeEnabled();
      const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
      const saved = readFileSync((await file.path())!);
      expect(Buffer.compare(saved, Buffer.from(await evidenceFromSwarm())), 'the downloaded file is the evidence on Swarm').toBe(0);

      expect(toPages, 'the Swarm copy never asks GitHub Pages for anything').toEqual([]);
      expect(errors).toEqual([]);
      note('mirror gone', {
        app: `${SWARM_APP}#/c/${ENTITY}`,
        feedIndex: ours!.feedIndex,
        disposition: { ours: ours!.disposition, downloadGateway: viaGateway!.disposition },
        download: file.suggestedFilename(),
        bytes: saved.length,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  });

  // --- 3. Fully offline ----------------------------------------------------------------------

  test('p5 crops fully offline: a dropped evidence file verifies', async () => {
    test.setTimeout(180_000);
    const index = join(APP_DIST, 'index.html');
    if (!existsSync(index)) throw new Error(`No web build at ${APP_DIST}. Run: VITE_RECALL_NET=live pnpm --filter web build`);
    const bundle = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(readFileSync(index, 'utf8'))?.[1];
    expect(bundle, 'the build names its bundle').toBeTruthy();
    const code = readFileSync(join(APP_DIST, bundle!), 'utf8');
    // A local (devnet) build trusts the devnet witness, so check C would fail for the live capture.
    if (code.includes('"local"==="local"')) {
      throw new Error(`${APP_DIST} is a devnet build. Run: VITE_RECALL_NET=live pnpm --filter web build`);
    }
    const evidence = await evidenceFromSwarm();

    // The build, served from this machine.
    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.json': 'application/json',
    };
    const server: Server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
      const file = resolve(APP_DIST, path || 'index.html');
      if (!file.startsWith(APP_DIST + sep) || !existsSync(file)) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const browser = await chromium.launch({ channel: 'chromium', headless: !process.env.HEADED, args: ARGS });
    try {
      const context = await browser.newContext({ colorScheme: 'light' });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${local}#/`);
      await expect(page.getByRole('heading', { level: 1, name: 'Recall' })).toBeVisible();
      await page.waitForLoadState('networkidle'); // the app has loaded everything it needs
      await expect(page.getByText('Works offline. The file never leaves your browser.')).toBeVisible();

      // Fully offline from here on: the browser has no network, and any request is refused anyway.
      await context.setOffline(true);
      const requested: string[] = [];
      await context.route(/.*/, (route) => {
        requested.push(route.request().url());
        return route.abort('internetdisconnected');
      });
      page.on('request', (r) => {
        if (/^https?:/.test(r.url()) && !requested.includes(r.url())) requested.push(r.url());
      });
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      const reachable = await page.evaluate(
        (u) => fetch(u, { cache: 'no-store' }).then(() => true, () => false),
        `${DOWNLOAD_GATEWAYS[0]}/bytes/${EVIDENCE_REF.slice(2)}`,
      );
      expect(reachable, 'Swarm must be unreachable from the offline page').toBe(false);
      requested.length = 0;

      await fileInput(page, 'Evidence file').setInputFiles({
        name: `recall-${CAPTURED_URL_HASH.slice(2, 10)}-1793945366.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(evidence),
      });
      await expect(page).toHaveURL(/#\/file$/);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(PAGES_HOST);
      for (const id of ['A', 'B', 'C'] as const) {
        await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass');
      }
      await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
      await expect(check(page, 'E')).toContainText('not checked');
      await expect(page.getByText('Checked offline. A–C ran in your browser; storage (E) was not checked.')).toBeVisible();
      await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
      await expect(page.locator('.exhibit')).toContainText(CAPTURED_URL);
      // C names the live witness, the one this build trusts by default.
      expect(getAddress(decodeEvidence(evidence).signer)).toBe(LIVE_WITNESS);

      expect(requested, 'nothing was requested while offline').toEqual([]);
      expect(errors).toEqual([]);
      note('offline', { app: local, bundle, evidenceBytes: evidence.length });
      await context.close();
    } finally {
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  });
});
