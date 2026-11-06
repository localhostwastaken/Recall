import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page, type Worker } from '@playwright/test';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { dumpTabsOnFailure, launchWithExtension, NOTICE_HOST, type ExtensionSession } from '../fixtures/extension';
import { fundWallet } from '../fixtures/fund';
import { BEE_COMPOSE_FAUCET_KEY, DEVNET_WITNESS_ADDRESS } from '../fixtures/keys';
import { installMockWallet } from '../fixtures/mockWallet';
import { canonicalUrl, decodeEvidence, runChecks, urlHash } from '../../packages/evidence/src/index';
import { POSTAGE_STAMP, arkivPublic, buyBatch, downloadBytes, listByUrl, LOCAL, type Listed } from '../../packages/net/src/index';

// R44, capture first: the extension captures and checks a page with NO storage decision made,
// keeps it as pending and opens the publish page; the person chooses there. Real dev extension,
// devnet witness, local Bee, local Gnosis fork and local Arkiv; MetaMask is the only stand-in (a
// mock wallet with a real, freshly funded key).
// - An EMPTY pool: Buy storage and publish (one batch, bought once, owned by the stamp key) ->
//   the extension uploads with it -> MetaMask publishes -> the record is readable and verifies.
// - An upload that fails (the upload node answers 500): the capture is kept, "Try upload again"
//   publishes it; when the storage ran out meanwhile, the retry goes back to the storage choice.
// - Never a second purchase: a purchase sent earlier for the capture is settled first, and a tab
//   closed while the new storage gets ready reopens with "Upload and publish".

const APP = 'http://localhost:5173';
const RUN = Math.random().toString(36).slice(2, 10);
const PAGE = `https://${NOTICE_HOST}/notice?run=cf-${RUN}`;
const FAIL_PAGE = `https://${NOTICE_HOST}/notice?run=cf-${RUN}-fail`;
const EMPTIED_PAGE = `https://${NOTICE_HOST}/notice?run=cf-${RUN}-emptied`;
const SETTLE_PAGE = `https://${NOTICE_HOST}/notice?run=cf-${RUN}-settle`;
const REOPEN_PAGE = `https://${NOTICE_HOST}/notice?run=cf-${RUN}-reopen`;
const hashOf = (page: string) => urlHash(canonicalUrl(page));

type Pool = { batchId: Hex; used: boolean }[];
type Pending = {
  captureId?: string;
  kind?: string;
  upload?: { status: string; reason?: string; evidenceRef?: Hex; batchId?: Hex };
  storage?: string;
  error?: string;
};

let ext: ExtensionSession;
let app: Page;
let walletKey: Hex;
let stamp: Address;

const gnosisPayer = createWalletClient({
  account: privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY),
  chain: gnosis,
  transport: http(LOCAL.gnosis.rpcUrl),
});
const pub = arkivPublic(LOCAL);

async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 3 || !/nonce|underpriced|already known/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

function sw(): Worker {
  const live = ext.context.serviceWorkers().filter((w) => w.url().includes(ext.extensionId));
  return live[live.length - 1] ?? ext.serviceWorker;
}

async function settleServiceWorker(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const w = sw();
    let closed = false;
    w.once('close', () => (closed = true));
    await new Promise((r) => setTimeout(r, 1_500));
    if (!closed && sw() === w) return;
  }
  throw new Error('the extension service worker keeps restarting');
}

async function api<T = Record<string, unknown>>(msg: object): Promise<T> {
  return app.evaluate(
    ([id, m]) =>
      new Promise<unknown>((resolve) => {
        const rt = (window as unknown as { chrome?: { runtime?: { sendMessage?: Function; lastError?: { message?: string } } } })
          .chrome?.runtime;
        if (!rt?.sendMessage) return resolve({ lastError: 'chrome.runtime is not exposed to this page' });
        rt.sendMessage(id, m, (res: unknown) => resolve(res ?? { lastError: rt.lastError?.message ?? 'no answer' }));
      }),
    [ext.extensionId, msg] as const,
  ) as Promise<T>;
}

async function getLocal(key: string): Promise<unknown> {
  return sw().evaluate(async (k) => {
    const s = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } })
      .chrome.storage.local;
    return (await s.get(k))[k];
  }, key);
}

async function setLocal(key: string, value: unknown): Promise<void> {
  await sw().evaluate(
    async ([k, v]) => {
      const s = (globalThis as unknown as { chrome: { storage: { local: { set(i: object): Promise<void> } } } }).chrome.storage.local;
      await s.set({ [k]: v });
    },
    [key, value] as const,
  );
}

const pool = async () => ((await getLocal('recall.pool')) as Pool | undefined) ?? [];
const pendingOf = (captureId: string) => api<Pending>({ type: 'recall.getPending', captureId });
const jobState = () =>
  sw().evaluate(async () => {
    const s = (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<Record<string, unknown>> } } } })
      .chrome.storage.session;
    return (await s.get('recall.capture'))['recall.capture'] as { upload?: { status?: string; captureId?: string } } | undefined;
  });

async function capture(page: string): Promise<{ upload?: { status: string; captureId?: string } }> {
  const run = () =>
    sw().evaluate(async (u) => {
      const g = globalThis as unknown as { recall?: { captureForTest?: (url: string) => Promise<unknown> } };
      if (!g.recall?.captureForTest) return { error: 'no recall.captureForTest in this build' };
      return g.recall.captureForTest(u);
    }, page) as Promise<{ upload?: { status: string; captureId?: string } } | { error: string }>;
  let r = await run();
  if ('error' in r && /witness busy|too many sessions|did not connect in time|timed out/i.test(r.error)) r = await run();
  if ('error' in r) throw new Error(`capture failed: ${r.error}`);
  return r;
}

/** The publish tab the extension opened for `captureId`, with the mock wallet installed. */
async function approvalTab(captureId: string, onSent?: (chainId: number, hash: Hex, to: Address | undefined) => void): Promise<Page> {
  let page: Page | undefined;
  await expect
    .poll(() => (page = ext.context.pages().find((p) => p.url().includes(`#/approve/${captureId}`))), {
      timeout: 15_000,
      message: 'the extension opens the publish tab',
    })
    .toBeTruthy();
  expect(page!.url()).toBe(`${APP}/#/approve/${captureId}?ext=${ext.extensionId}`);
  await installMockWallet(page!, {
    privateKey: walletKey,
    rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
    chainId: 1337,
    ...(onSent ? { onSent } : {}),
  });
  await page!.reload();
  return page!;
}

/** As if MetaMask had been connected to this page (the header chip): the page can read the wallet's xBZZ. */
async function connectWallet(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { ethereum: { request(a: { method: string }): Promise<unknown> } }).ethereum.request({
      method: 'eth_requestAccounts',
    }),
  );
}

/** A server that answers 500 to everything (an upload node that is down). */
async function brokenServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end('down');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const createBatchesIn = (sent: { chainId: number; to?: string }[]) =>
  sent.filter((s) => s.chainId === 100 && s.to === POSTAGE_STAMP.toLowerCase()).length;

async function published(page: Page): Promise<Hex> {
  await expect(page.getByRole('heading', { name: 'Published', exact: true })).toBeVisible({ timeout: 280_000 });
  const key = (await page.locator('.approve-record .mono-value').first().getAttribute('title')) as Hex;
  expect(key).toMatch(/^0x[0-9a-f]{64}$/i);
  return key;
}

/** The record is listed for the page, its evidence downloads (root-checked) and verifies A-C. */
async function readable(page: string, entityKey: Hex): Promise<Extract<Listed, { kind: 'capture' }>> {
  const r = await listByUrl(pub, hashOf(page));
  const row = r.rows.find((x) => x.entityKey.toLowerCase() === entityKey.toLowerCase());
  expect(row?.kind).toBe('capture');
  const cap = row as Extract<Listed, { kind: 'capture' }>;
  const down = await downloadBytes(cap.evidenceRef, LOCAL.swarm.downloadUrls);
  const report = await runChecks(decodeEvidence(down.bytes), { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
  expect([report.A.status, report.B.status, report.C.status]).toEqual(['pass', 'pass', 'pass']);
  expect(report.facts!.bodySha256).toBe(cap.bodySha256);
  return cap;
}

test.describe('@p2 capture first', () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ext = await launchWithExtension({ dev: true });
    await settleServiceWorker();
    app = await ext.context.newPage();
    await app.goto(`${APP}/`);
    const notice = await ext.context.newPage();
    await notice.goto(`https://${NOTICE_HOST}/notice`);
    expect(await notice.evaluate(async () => (await fetch('/__admin/version', { method: 'POST', body: '{"v":1}' })).status)).toBe(200);
    await notice.close();
    const settings = (await getLocal('recall.settings')) as Record<string, unknown>;
    await setLocal('recall.settings', { ...settings, pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    // A fresh MetaMask account: xDAI for gas and xBZZ for one batch on Gnosis, gas on Arkiv.
    walletKey = generatePrivateKey();
    await fundWallet(privateKeyToAccount(walletKey).address, 10n * 10n ** 16n);
    stamp = (await api<{ address: Address }>({ type: 'recall.getStampAddress' })).address;
  });

  test.afterEach(async ({}, testInfo) => {
    await dumpTabsOnFailure(ext?.context, testInfo);
  });

  test.afterAll(async () => {
    await ext?.context.close();
  });

  test('empty pool: capture first, then buy storage and publish; the record is readable', async () => {
    expect(await pool()).toEqual([]);

    // The popup offers Capture with no storage prompt, and nothing is uploaded after it.
    const tab = await ext.context.newPage();
    await tab.goto(PAGE);
    const tabId = await sw().evaluate(async (u) => {
      const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } }).chrome.tabs;
      return (await tabs.query({})).find((t) => t.url === u)?.id ?? null;
    }, PAGE);
    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
    await expect(popup.getByText('Witness online')).toBeVisible({ timeout: 15_000 });
    await expect(popup.getByRole('heading', { name: 'No storage left' })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Buy storage' })).toHaveCount(0);
    await popup.getByRole('button', { name: 'Capture this page' }).click();
    await expect(popup.getByRole('heading', { name: 'Continue in the Recall tab' })).toBeVisible({ timeout: 150_000 });
    await expect(popup.getByRole('button', { name: 'Open Recall tab' })).toBeVisible();
    const job = await jobState();
    expect(job?.upload?.status).toBe('pending');
    const captureId = job!.upload!.captureId!;
    await popup.close();
    await tab.close();

    // Kept without any upload: the extension has the evidence and no reference yet.
    const kept = await pendingOf(captureId);
    expect(kept).toMatchObject({ captureId, kind: 'capture', upload: { status: 'none' }, storage: 'empty' });
    expect(await pool()).toEqual([]);

    const sent: { chainId: number; to?: string }[] = [];
    const page = await approvalTab(captureId, (chainId, _hash, to) => sent.push({ chainId, to: to?.toLowerCase() }));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Save this capture');
    for (const k of ['A', 'B', 'C']) {
      await expect(page.locator(`.approve-check-list [data-check="${k}"] .badge`)).toHaveAttribute('data-status', 'pass');
    }
    await expect(page.getByText('Your extension has no storage left.', { exact: false })).toBeVisible();
    // MetaMask not connected yet, so the xBZZ balance is unknown: free storage comes first, buying second.
    await expect(page.getByRole('button', { name: 'Publish with free storage' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Your xBZZ balance isn't known yet", { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buy storage and publish' })).toBeEnabled();
    // Connected (this wallet holds xBZZ): buying is the primary action, with the price.
    await connectWallet(page);
    await expect(page.getByText(/One storage batch for 7 days: about [\d.]+ xBZZ/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Publish with free storage' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use free storage instead' })).toBeVisible();
    await expect(page.getByText('Step 1 of 6')).toBeVisible();
    await page.getByRole('button', { name: 'Buy storage and publish' }).click();

    // The link names an extension that is not in Settings: its stamp address is shown first.
    await expect(page.getByRole('heading', { name: 'Which extension should own this storage?' })).toBeVisible();
    await expect(page.locator('.notice .mono-value').first()).toHaveAttribute('title', stamp);
    await page.getByRole('button', { name: 'Use this extension' }).click();

    const entityKey = await published(page);
    await expect(page.getByText('Step 6 of 6')).toBeVisible();
    await expect(page.getByRole('link', { name: 'View timeline' })).toHaveAttribute('href', `#/u/${hashOf(PAGE)}`);

    // One batch bought (one createBatch), owned by the stamp key; it took this upload.
    const purchases = sent.filter((s) => s.chainId === 100 && s.to === POSTAGE_STAMP.toLowerCase());
    expect(purchases).toHaveLength(1);
    const after = await pool();
    expect(after).toHaveLength(1);
    expect(after[0]!.used).toBe(true);
    const row = await readable(PAGE, entityKey);
    expect(row.batchId.toLowerCase()).toBe(after[0]!.batchId.toLowerCase());

    // Published: the extension no longer holds it, and the popup is idle again.
    expect(await pendingOf(captureId)).toEqual({ error: expect.any(String) });
    expect(await jobState()).toBeUndefined();
    await page.close();
  });

  test('an upload that fails keeps the capture; Try upload again publishes it', async () => {
    // Storage in the pool, and an upload node that answers 500 to everything.
    const id = await retrying(async () => (await buyBatch(gnosisPayer, { owner: stamp, depth: 17, days: 3 })).batchId);
    const added = await api<{ error?: string }>({ type: 'recall.addBatches', batchIds: [id] });
    expect(added.error, JSON.stringify(added)).toBeUndefined();
    const broken: Server = createServer((req, res) => {
      res.writeHead(500, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }).end('down');
    });
    await new Promise<void>((r) => broken.listen(0, '127.0.0.1', r));
    const settings = (await getLocal('recall.settings')) as Record<string, unknown>;
    await setLocal('recall.settings', { ...settings, uploadUrl: `http://127.0.0.1:${(broken.address() as AddressInfo).port}` });
    try {
      const r = await capture(FAIL_PAGE);
      expect(r.upload?.status).toBe('pending');
      const captureId = r.upload!.captureId!;
      const page = await approvalTab(captureId);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Save this capture');
      await page.getByRole('button', { name: 'Upload and publish' }).click();
      await expect(page.getByRole('heading', { name: 'Upload failed' })).toBeVisible({ timeout: 200_000 });
      await expect(page.getByText(/Your capture is kept in the extension, so nothing is lost/)).toBeVisible();
      // Kept: still pending, with the reason; nothing was published.
      const kept = await pendingOf(captureId);
      expect(kept.upload?.status).toBe('failed');
      expect((await listByUrl(pub, hashOf(FAIL_PAGE))).rows).toHaveLength(0);
      // A reload shows the same failure (the extension remembers it).
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Upload failed' })).toBeVisible({ timeout: 30_000 });

      // The node is back: the retry uploads and publishes, with no new capture.
      await setLocal('recall.settings', settings);
      await page.getByRole('button', { name: 'Try upload again' }).click();
      const entityKey = await published(page);
      await readable(FAIL_PAGE, entityKey);
      expect(await pendingOf(captureId)).toEqual({ error: expect.any(String) });
      await page.close();
    } finally {
      await setLocal('recall.settings', settings);
      broken.closeAllConnections();
      broken.close();
    }
  });

  test('a stamped upload fails and the storage runs out: Try upload again goes back to the storage choice', async () => {
    const id = await retrying(async () => (await buyBatch(gnosisPayer, { owner: stamp, depth: 17, days: 3 })).batchId);
    expect((await api<{ error?: string }>({ type: 'recall.addBatches', batchIds: [id] })).error).toBeUndefined();
    const broken = await brokenServer();
    const settings = (await getLocal('recall.settings')) as Record<string, unknown>;
    await setLocal('recall.settings', { ...settings, uploadUrl: broken.url });
    try {
      const r = await capture(EMPTIED_PAGE);
      const captureId = r.upload!.captureId!;
      const page = await approvalTab(captureId);
      await page.getByRole('button', { name: 'Upload and publish' }).click();
      await expect(page.getByRole('heading', { name: 'Upload failed' })).toBeVisible({ timeout: 200_000 });
      expect((await pendingOf(captureId)).upload).toMatchObject({ status: 'failed', mode: 'stamped' });
      // Every way out: try again, discard (the batch is still there, so no Buy here yet).
      await expect(page.getByRole('button', { name: 'Try upload again' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Discard capture' })).toBeVisible();

      // The batch is gone meanwhile (used elsewhere): the retry does not loop on "no storage".
      await setLocal('recall.pool', (await pool()).map((b) => ({ ...b, used: true })));
      await setLocal('recall.settings', settings);
      await page.getByRole('button', { name: 'Try upload again' }).click();
      await expect(page.getByRole('heading', { name: 'Choose the storage again' })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { name: 'Upload failed' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Buy storage and publish' })).toBeVisible();
      expect((await pendingOf(captureId)).upload?.status).toBe('failed');
      await page.close();
    } finally {
      await setLocal('recall.settings', settings);
      broken.server.closeAllConnections();
      broken.server.close();
    }
  });

  test('a purchase sent earlier for this capture is settled first, never bought again', async () => {
    const r = await capture(SETTLE_PAGE);
    const captureId = r.upload!.captureId!;
    expect(await pendingOf(captureId)).toMatchObject({ storage: 'empty' });
    // As if this tab bought a batch and was closed before handing it over: the hash is kept per
    // capture in localStorage.
    const earlier = await retrying(() => buyBatch(gnosisPayer, { owner: stamp, depth: 17, days: 7 }));
    const key = `recall.approve.sentTx.v1.${captureId}`;
    await app.evaluate(([k, v]) => localStorage.setItem(k, v), [key, earlier.txHash] as const);
    const sent: { chainId: number; to?: string }[] = [];
    const page = await approvalTab(captureId, (chainId, _h, to) => sent.push({ chainId, to: to?.toLowerCase() }));
    await page.getByRole('button', { name: 'Buy storage and publish' }).click();
    const entityKey = await published(page);
    expect(createBatchesIn(sent)).toBe(0);
    const row = await readable(SETTLE_PAGE, entityKey);
    expect(row.batchId.toLowerCase()).toBe(earlier.batchId.toLowerCase());
    expect(await app.evaluate((k) => localStorage.getItem(k), key)).toBeNull();
    await page.close();
  });

  test('a tab closed while new storage gets ready reopens with Upload and publish: one purchase only', async () => {
    const r = await capture(REOPEN_PAGE);
    const captureId = r.upload!.captureId!;
    const sent: { chainId: number; to?: string }[] = [];
    const onSent = (chainId: number, _h: Hex, to: Address | undefined) => sent.push({ chainId, to: to?.toLowerCase() });
    const first = await approvalTab(captureId, onSent);
    const unusedBefore = (await pool()).filter((b) => !b.used).length;
    await first.getByRole('button', { name: 'Buy storage and publish' }).click();
    // Bought and handed over: the extension holds the batch while Bee gets it ready.
    await expect.poll(async () => (await pool()).filter((b) => !b.used).length, { timeout: 120_000 }).toBe(unusedBefore + 1);
    await first.close();
    expect(createBatchesIn(sent)).toBe(1);

    const again = await ext.context.newPage();
    await installMockWallet(again, {
      privateKey: walletKey,
      rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
      chainId: 1337,
      onSent,
    });
    await again.goto(`${APP}/#/approve/${captureId}?ext=${ext.extensionId}`);
    await expect(again.getByRole('button', { name: 'Upload and publish' })).toBeVisible({ timeout: 30_000 });
    await expect(again.getByRole('button', { name: 'Buy storage and publish' })).toHaveCount(0);
    await again.getByRole('button', { name: 'Upload and publish' }).click();
    await readable(REOPEN_PAGE, await published(again));
    expect(createBatchesIn(sent)).toBe(1);
    await again.close();
  });
});
