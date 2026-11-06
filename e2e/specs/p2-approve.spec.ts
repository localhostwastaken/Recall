import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Page, type Worker } from '@playwright/test';
import { createWalletClient, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { launchWithExtension, NOTICE_HOST, type ExtensionSession } from '../fixtures/extension';
import { BEE_COMPOSE_FAUCET_KEY, DEV_PRIVATE_KEY, DEVNET_WITNESS_ADDRESS, DEVNET_WITNESS_KEY } from '../fixtures/keys';
import { installMockWallet, type MockWallet } from '../fixtures/mockWallet';
import { canonicalUrl, decodeEvidence, runChecks, urlHash, type EvidenceFile } from '../../packages/evidence/src/index';
import {
  arkivPublic,
  arkivWallet,
  buyBatch,
  downloadBytes,
  listByUrl,
  LOCAL,
  writeCapture,
  writeWitnessProfile,
  type Listed,
} from '../../packages/net/src/index';

// The whole publish flow with the real dev extension, the devnet witness, local Bee and the
// local Arkiv node; MetaMask is the only stand-in (a mock wallet with a real, funded key):
// capture -> evidence on Swarm (or, for unchanged bytes, a confirmation with the evidence
// inline) -> the extension opens the approval tab -> MetaMask writes the Arkiv record -> the
// extension marks it published. Plus the same-page rules (only a VERIFIED identical capture
// suppresses an upload) and witness discovery from an Arkiv profile.
//
// Each run captures its own page address (?run=<random>; the fixture ignores the query), so
// records left on the devnet by earlier runs never change what this run sees.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP = 'http://localhost:5173';
const RUN = Math.random().toString(36).slice(2, 10);
const PAGE = `https://${NOTICE_HOST}/notice?run=${RUN}`;
const JUNK_PAGE = `https://${NOTICE_HOST}/notice?run=${RUN}-junk`;
const hashOf = (page: string) => urlHash(canonicalUrl(page));

type Facts = {
  canonicalUrl: string;
  serverName: string;
  httpStatus: number;
  bodySha256: Hex;
  signedAt: string;
  witness: Address;
};
type Upload =
  | { status: 'uploaded'; captureId: string; evidenceRef: Hex; batchId: Hex }
  | { status: 'confirmation'; captureId: string; captureKey: Hex; since: string }
  | { status: 'no_storage' | 'skipped' | 'failed'; reason?: string; error?: string };
type CaptureResult =
  | { evidence: EvidenceFile; checks: Record<'A' | 'B' | 'C', { status: string }> & { facts?: Facts }; upload?: Upload }
  | { error: string };
type Pool = { batchId: Hex; used: boolean }[];

let ext: ExtensionSession;
let app: Page;
let walletKey: Hex;
let walletAddress: Address;
let v1Body: Hex;
let firstCapture: { entityKey: Hex; evidenceRef: Hex; signedAt: bigint };

const gnosisPayer = createWalletClient({
  account: privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY),
  chain: gnosis,
  transport: http(LOCAL.gnosis.rpcUrl),
});
const devArkiv = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(DEV_PRIVATE_KEY));
const pub = arkivPublic(LOCAL);

/** Other suites use the same faucet and dev keys; a nonce race is retried. */
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

/** One message from the app page to the extension; `{lastError}` when nothing answered. */
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
const unused = async () => (await pool()).filter((b) => !b.used).length;

async function setVersion(v: 1 | 2): Promise<void> {
  const page = await ext.context.newPage();
  try {
    await page.goto(`https://${NOTICE_HOST}/notice`);
    const status = await page.evaluate(
      async (body) => (await fetch('/__admin/version', { method: 'POST', body })).status,
      JSON.stringify({ v }),
    );
    expect(status).toBe(200);
  } finally {
    await page.close();
  }
}

async function capture(page: string): Promise<Exclude<CaptureResult, { error: string }>> {
  const run = () =>
    sw().evaluate(
      async (u) => {
        const g = globalThis as unknown as { recall?: { captureForTest?: (url: string) => Promise<unknown> } };
        if (!g.recall?.captureForTest) return { error: 'no recall.captureForTest in this build' };
        return g.recall.captureForTest(u);
      },
      page,
    ) as Promise<CaptureResult>;
  let r = await run();
  // The witness's known rare setup stall, or its admission limits: one retry.
  if ('error' in r && /witness busy|too many sessions|did not connect in time|timed out/i.test(r.error)) {
    test.info().annotations.push({ type: 'retried capture', description: r.error });
    r = await run();
  }
  if ('error' in r) throw new Error(`capture failed: ${r.error}`);
  return r;
}

/** The approval tab the extension opened for `captureId`, with the mock wallet installed. */
async function approvalTab(captureId: string, chainId = 1337): Promise<{ page: Page; wallet: MockWallet }> {
  let page: Page | undefined;
  await expect
    .poll(() => (page = ext.context.pages().find((p) => p.url().includes(`#/approve/${captureId}`))), {
      timeout: 15_000,
      message: 'the extension opens the approval tab',
    })
    .toBeTruthy();
  const url = page!.url();
  expect(url).toBe(`${APP}/#/approve/${captureId}?ext=${ext.extensionId}`);
  const wallet = await installMockWallet(page!, {
    privateKey: walletKey,
    rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
    chainId,
  });
  await page!.reload(); // the wallet is injected before the page's own scripts on the next load
  return { page: page!, wallet };
}

/** Connect, switch if needed, publish; returns the new record's key. */
async function publish(page: Page, kind: 'capture' | 'confirmation'): Promise<Hex> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    kind === 'capture' ? 'Publish this capture' : 'Publish this confirmation',
  );
  // The page ran the checks itself before offering to publish.
  for (const k of ['A', 'B', 'C']) {
    await expect(page.locator(`.approve-check-list [data-check="${k}"] .badge`)).toHaveAttribute('data-status', 'pass');
  }
  await page.locator('main').getByRole('button', { name: 'Connect MetaMask' }).click();
  await page.getByRole('button', { name: kind === 'capture' ? 'Publish record' : 'Publish confirmation' }).click();
  return published(page);
}

async function published(page: Page): Promise<Hex> {
  await expect(page.getByRole('heading', { name: 'Published', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Record on Arkiv until /)).toBeVisible();
  await expect(page.getByText('Step 3 of 3')).toBeVisible();
  const key = (await page.locator('.approve-record .mono-value').first().getAttribute('title')) as Hex;
  expect(key).toMatch(/^0x[0-9a-f]{64}$/i);
  return key;
}

async function rows(page: string): Promise<Listed[]> {
  const r = await listByUrl(pub, hashOf(page));
  expect(r.truncated).toBe(false);
  return r.rows;
}

/** Checks A-C of downloaded or inline evidence with the devnet witness pinned, plus R13. */
async function verified(bytes: Uint8Array, row: { urlHash: Hex; bodySha256: Hex; witness: Address; signedAt: bigint }) {
  const report = await runChecks(decodeEvidence(bytes), { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
  expect([report.A.status, report.B.status, report.C.status]).toEqual(['pass', 'pass', 'pass']);
  const f = report.facts!;
  expect(f.urlHash).toBe(row.urlHash);
  expect(f.bodySha256).toBe(row.bodySha256);
  expect(f.witness.toLowerCase()).toBe(row.witness.toLowerCase());
  expect(f.signedAt).toBe(row.signedAt);
  return f;
}

/**
 * Opens the popup on a tab showing `page`. A finished capture of the same page takes the
 * place of "Earlier captures"; `later: true` clears it first (a later visit).
 */
async function openPopup(page: string, opts: { later?: boolean } = {}): Promise<{ tab: Page; popup: Page }> {
  if (opts.later) {
    await sw().evaluate(async () => {
      const s = (globalThis as unknown as { chrome: { storage: { session: { remove(k: string): Promise<void> } } } }).chrome.storage
        .session;
      await s.remove('recall.capture');
    });
  }
  const tab = await ext.context.newPage();
  await tab.goto(page);
  // The tab with exactly this address (other tabs show the same page with another ?run=).
  const id = await sw().evaluate(async (u) => {
    const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } })
      .chrome.tabs;
    return (await tabs.query({})).find((t) => t.url === u)?.id ?? null;
  }, page);
  expect(id, `a tab showing ${page}`).not.toBeNull();
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${id}`);
  return { tab, popup };
}

const pendingOf = (captureId: string) => api<Record<string, unknown>>({ type: 'recall.getPending', captureId });

test.describe('@p2 approve', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ext = await launchWithExtension({ dev: true });
    await settleServiceWorker();
    app = await ext.context.newPage();
    await app.goto(`${APP}/`);
    await setVersion(1);

    // Pin the devnet witness: same-page checks and earlier captures verify against it.
    const settings = (await getLocal('recall.settings')) as Record<string, unknown>;
    await setLocal('recall.settings', { ...settings, pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });

    // A fresh MetaMask account with funds on the local Arkiv chain.
    walletKey = generatePrivateKey();
    walletAddress = privateKeyToAccount(walletKey).address;
    const hash = await retrying(() => devArkiv.sendTransaction({ to: walletAddress, value: parseEther('10') }));
    await pub.waitForTransactionReceipt({ hash });

    // Storage for the three uploads this file makes (plus one spare).
    const stamp = (await api<{ address: Address }>({ type: 'recall.getStampAddress' })).address;
    const ids: Hex[] = [];
    for (let i = 0; i < 4; i++) ids.push(await retrying(async () => (await buyBatch(gnosisPayer, { owner: stamp, depth: 17, days: 3 })).batchId));
    const added = await api<{ pool?: Pool; error?: string }>({ type: 'recall.addBatches', batchIds: ids });
    expect(added.error, JSON.stringify(added)).toBeUndefined();
  });

  test.afterAll(async () => {
    if (ext) {
      await setVersion(1).catch(() => undefined);
      await ext.context.close();
    }
  });

  test('capture -> approve -> entity readable', async () => {
    const before = await unused();
    const r = await capture(PAGE);
    expect([r.checks.A.status, r.checks.B.status, r.checks.C.status]).toEqual(['pass', 'pass', 'pass']);
    expect(r.upload?.status, JSON.stringify(r.upload)).toBe('uploaded');
    const up = r.upload as Extract<Upload, { status: 'uploaded' }>;
    expect(await unused()).toBe(before - 1);
    v1Body = r.checks.facts!.bodySha256;

    const { page } = await approvalTab(up.captureId);
    // Design brief 7: the page fits 375 px without horizontal scroll (SHOTS=<dir> saves screenshots).
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Publish this capture');
    await expect(page.locator('.approve-check-list [data-check="C"] .badge')).toHaveAttribute('data-status', 'pass');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/approve-375.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    const entityKey = await publish(page, 'capture');
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/approve-published.png`, fullPage: true });
    await expect(page.getByRole('link', { name: 'View timeline' })).toHaveAttribute('href', `#/u/${hashOf(PAGE)}`);
    await expect(page.getByRole('link', { name: 'View this capture' })).toHaveAttribute('href', `#/c/${entityKey}`);

    // listByUrl finds the record; its evidence downloads (root-checked) and verifies.
    const list = await rows(PAGE);
    const row = list.find((x) => x.entityKey.toLowerCase() === entityKey.toLowerCase());
    expect(row?.kind).toBe('capture');
    const capRow = row as Extract<Listed, { kind: 'capture' }>;
    expect(capRow.owner.toLowerCase()).toBe(walletAddress.toLowerCase());
    expect(capRow.evidenceRef).toBe(up.evidenceRef);
    expect(capRow.batchId).toBe(up.batchId);
    expect(capRow.canonicalUrl).toBe(canonicalUrl(PAGE));
    expect(capRow.httpStatus).toBe(200);
    expect(capRow.expiresAtBlock).toBeGreaterThan(await pub.getBlockNumber());
    const down = await downloadBytes(capRow.evidenceRef, LOCAL.swarm.downloadUrls);
    await verified(down.bytes, capRow);
    firstCapture = { entityKey, evidenceRef: capRow.evidenceRef, signedAt: capRow.signedAt };

    // Published: the extension no longer holds it as pending.
    expect(await pendingOf(up.captureId)).toEqual({ error: expect.any(String) });

    // The popup counts it among the verified earlier captures.
    const { tab, popup } = await openPopup(PAGE, { later: true });
    try {
      await expect(popup.getByText('1 version · 0 confirmations')).toBeVisible({ timeout: 30_000 });
      await expect(popup.getByText(/^Latest: \d+ \w{3} \d{4}, \d\d:\d\d UTC$/)).toBeVisible();
      await expect(popup.getByRole('link', { name: 'View timeline' })).toHaveAttribute(
        'href',
        `${APP}/#/u/${hashOf(PAGE)}`,
      );
    } finally {
      await popup.close();
      await tab.close();
    }
    await page.close();
  });

  test('identical re-capture writes confirmation without upload', async () => {
    const poolBefore = await pool();
    const r = await capture(PAGE);
    expect(r.upload?.status, JSON.stringify(r.upload)).toBe('confirmation');
    const c = r.upload as Extract<Upload, { status: 'confirmation' }>;
    expect(c.captureKey.toLowerCase()).toBe(firstCapture.entityKey.toLowerCase());
    expect(c.since).toBe(firstCapture.signedAt.toString());
    // No upload: the pool (batches, used flags, stamp counters) is exactly as before.
    expect(await pool()).toEqual(poolBefore);
    const pending = await pendingOf(c.captureId);
    expect(pending.kind).toBe('confirmation');
    expect(pending.evidenceRef).toBeUndefined();

    // The popup says so and offers the confirmation.
    const { tab, popup } = await openPopup(PAGE);
    try {
      await expect(popup.getByRole('heading', { name: /^Unchanged since / })).toBeVisible();
      if (process.env.SHOTS) {
        await popup.setViewportSize({ width: 360, height: 560 });
        await popup.screenshot({ path: `${process.env.SHOTS}/popup-unchanged.png` });
      }
      await expect(popup.getByText(/No new upload is needed\./)).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Publish confirmation' })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Keep earlier capture alive' })).toBeVisible();
    } finally {
      await popup.close();
      await tab.close();
    }

    const { page } = await approvalTab(c.captureId);
    await expect(page.getByText(/^Unchanged since .*nothing new is uploaded\.$/)).toBeVisible();
    const entityKey = await publish(page, 'confirmation');
    await expect(page.getByRole('link', { name: 'View the earlier capture' })).toHaveAttribute(
      'href',
      `#/c/${firstCapture.entityKey}`,
    );

    const row = (await rows(PAGE)).find((x) => x.entityKey.toLowerCase() === entityKey.toLowerCase());
    expect(row?.kind).toBe('confirmation');
    const conf = row as Extract<Listed, { kind: 'confirmation' }>;
    expect(conf.captureKey.toLowerCase()).toBe(firstCapture.entityKey.toLowerCase());
    expect(conf.bodySha256).toBe(v1Body);
    // The evidence is inline, and it verifies on its own.
    const f = await verified(conf.evidence, conf);
    expect(f.signedAt).toBeGreaterThan(firstCapture.signedAt);
    expect(await pendingOf(c.captureId)).toEqual({ error: expect.any(String) });
    await page.close();
  });

  test('MetaMask rejection keeps record pending and retry succeeds', async () => {
    const r = await capture(PAGE);
    const c = r.upload as Extract<Upload, { status: 'confirmation' }>;
    expect(c.status).toBe('confirmation');
    const { page } = await approvalTab(c.captureId);
    await page.locator('main').getByRole('button', { name: 'Connect MetaMask' }).click();
    await expect(page.getByRole('button', { name: 'Publish confirmation' })).toBeEnabled();
    await page.evaluate(() => {
      (window as unknown as { __rejectNext: unknown }).__rejectNext = 'eth_sendTransaction';
    });
    await page.getByRole('button', { name: 'Publish confirmation' }).click();
    await expect(page.getByRole('heading', { name: 'Not published' })).toBeVisible({ timeout: 30_000 });
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/approve-rejected.png`, fullPage: true });
    await expect(
      page.getByText('You rejected the request in MetaMask. Your capture is kept as pending in the extension, so you can retry any time.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Published', exact: true })).toHaveCount(0);
    // One way forward: the notice's Try again (the action bar steps aside).
    await expect(page.getByRole('button', { name: 'Publish confirmation' })).toHaveCount(0);
    // Still pending in the extension.
    expect((await pendingOf(c.captureId)).captureId).toBe(c.captureId);

    await page.getByRole('button', { name: 'Try again' }).click();
    const entityKey = await published(page);
    expect(await pendingOf(c.captureId)).toEqual({ error: expect.any(String) });
    expect((await rows(PAGE)).some((x) => x.entityKey.toLowerCase() === entityKey.toLowerCase())).toBe(true);
    await page.close();
  });

  test('discard after a rejection removes the pending capture', async () => {
    const r = await capture(PAGE);
    const c = r.upload as Extract<Upload, { status: 'confirmation' }>;
    expect(c.status).toBe('confirmation');
    const before = (await rows(PAGE)).length;
    const { page } = await approvalTab(c.captureId);
    await page.locator('main').getByRole('button', { name: 'Connect MetaMask' }).click();
    await expect(page.getByRole('button', { name: 'Publish confirmation' })).toBeEnabled();
    await page.evaluate(() => {
      (window as unknown as { __rejectNext: unknown }).__rejectNext = 'eth_sendTransaction';
    });
    await page.getByRole('button', { name: 'Publish confirmation' }).click();
    await expect(page.getByRole('heading', { name: 'Not published' })).toBeVisible({ timeout: 30_000 });

    // The confirm dialog: Esc closes it and focus goes back to the button; nothing changes.
    const discardButton = page.getByRole('button', { name: 'Discard capture' });
    await discardButton.click();
    const dialog = page.getByRole('dialog', { name: 'Discard this confirmation?' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Nothing was uploaded for it, and nothing will be published.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(discardButton).toBeFocused();
    expect((await pendingOf(c.captureId)).captureId).toBe(c.captureId);

    await discardButton.click();
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Capture discarded' })).toBeVisible();
    await expect(page.getByText('The capture was removed from the extension. Nothing was published.')).toBeVisible();
    // Gone from the extension; nothing was written to Arkiv.
    expect(await pendingOf(c.captureId)).toEqual({ error: expect.any(String) });
    expect((await rows(PAGE)).length).toBe(before);
    await page.close();
  });

  test('wrong chain is switched', async () => {
    const r = await capture(PAGE);
    const c = r.upload as Extract<Upload, { status: 'confirmation' }>;
    expect(c.status).toBe('confirmation');
    const { page, wallet } = await approvalTab(c.captureId, 100);
    expect(wallet.chainId()).toBe(100);
    await page.locator('main').getByRole('button', { name: 'Connect MetaMask' }).click();
    await expect(page.getByText('MetaMask is on Gnosis. Records are published on Arkiv local.')).toBeVisible();
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/approve-wrong-network.png`, fullPage: true });
    await page.getByRole('button', { name: 'Switch to Arkiv local' }).click();
    await page.getByRole('button', { name: 'Publish confirmation' }).click();
    await published(page);
    expect(wallet.chainId()).toBe(1337);
    await page.close();
  });

  test('edited page (fixture v2) writes a new capture version', async () => {
    await setVersion(2);
    const before = await unused();
    const r = await capture(PAGE);
    expect(r.upload?.status, JSON.stringify(r.upload)).toBe('uploaded');
    expect(await unused()).toBe(before - 1);
    const up = r.upload as Extract<Upload, { status: 'uploaded' }>;
    const { page } = await approvalTab(up.captureId);
    // Duplicate guard: as if an earlier attempt's transaction landed after the page gave up,
    // this account already wrote the record. Publishing reuses it instead of writing again.
    const f = r.checks.facts!;
    const sameAccount = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(walletKey));
    const { entityKey: already } = await retrying(() =>
      writeCapture(sameAccount, {
        urlHash: hashOf(PAGE),
        bodySha256: f.bodySha256,
        serverName: f.serverName,
        witness: f.witness,
        signedAt: BigInt(f.signedAt),
        httpStatus: f.httpStatus,
        batchId: up.batchId,
        evidenceRef: up.evidenceRef,
        canonicalUrl: f.canonicalUrl,
      }),
    );
    expect((await publish(page, 'capture')).toLowerCase()).toBe(already.toLowerCase());
    expect(await pendingOf(up.captureId)).toEqual({ error: expect.any(String) });
    await page.close();

    const captures = (await rows(PAGE)).filter((x): x is Extract<Listed, { kind: 'capture' }> => x.kind === 'capture');
    expect(captures).toHaveLength(2);
    expect(new Set(captures.map((x) => x.bodySha256)).size).toBe(2);
    expect(captures.map((x) => x.bodySha256)).toContain(v1Body);

    // Two verified versions; the three confirmations of version 1 came before version 2.
    const { tab, popup } = await openPopup(PAGE, { later: true });
    try {
      await expect(popup.getByText('2 versions · 3 confirmations')).toBeVisible({ timeout: 30_000 });
      if (process.env.SHOTS) {
        await popup.setViewportSize({ width: 360, height: 560 });
        await popup.screenshot({ path: `${process.env.SHOTS}/popup-earlier.png` });
      }
    } finally {
      await popup.close();
      await tab.close();
    }
  });

  test('junk entity with matching bodySha256 does not suppress upload', async () => {
    await setVersion(1);
    const h = hashOf(JUNK_PAGE);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const junk = {
      urlHash: h,
      bodySha256: v1Body,
      serverName: NOTICE_HOST,
      witness: DEVNET_WITNESS_ADDRESS as Address,
      httpStatus: 200,
      batchId: `0x${'cd'.repeat(32)}` as Hex,
      canonicalUrl: canonicalUrl(JUNK_PAGE),
    };
    // 1: claims the same bytes, a later time, and points at nothing.
    await retrying(() => writeCapture(devArkiv, { ...junk, signedAt: now + 600n, evidenceRef: generatePrivateKey() }));
    // 2: points at REAL witness-signed evidence with the same bytes, but of another address (R13).
    await retrying(() =>
      writeCapture(devArkiv, { ...junk, signedAt: firstCapture.signedAt, evidenceRef: firstCapture.evidenceRef }),
    );

    const before = await unused();
    const r = await capture(JUNK_PAGE);
    expect(r.checks.facts?.bodySha256).toBe(v1Body);
    expect(r.upload?.status, JSON.stringify(r.upload)).toBe('uploaded');
    expect(await unused()).toBe(before - 1);

    // Junk is never counted as an earlier capture, and it is not "no captures" either: the
    // record whose evidence can't be downloaded is Not checked (design brief 5).
    const { tab, popup } = await openPopup(JUNK_PAGE, { later: true });
    try {
      const earlier = popup.locator('section[aria-labelledby="earlier-captures"]');
      await expect(earlier.getByText(/^Earlier captures couldn't be checked right now/)).toBeVisible({ timeout: 30_000 });
      await expect(earlier.locator('.badge')).toHaveAttribute('data-status', 'unavailable');
      await expect(popup.getByText('No captures of this page yet.')).toHaveCount(0);
      await expect(popup.getByText(/version/)).toHaveCount(0);
    } finally {
      await popup.close();
      await tab.close();
    }
  });

  test('witness discovered from Arkiv profile', async () => {
    const settings = (await getLocal('recall.settings')) as Record<string, unknown>;
    // The announce script writes the profile with the witness key (local: the devnet key).
    const { stdout } = await promisify(execFile)(
      'npx',
      ['tsx', 'scripts/announce-witness.ts', '--net', 'local', '--url', 'http://127.0.0.1:7047'],
      { cwd: ROOT, timeout: 60_000 },
    );
    expect(stdout).toContain('done: the extension will find this URL');
    // It prints addresses and hashes, never the key.
    expect(stdout.toLowerCase()).not.toContain(DEVNET_WITNESS_KEY.slice(2).toLowerCase());
    // A newer profile for the same witness written by ANOTHER key is ignored.
    await retrying(() => writeWitnessProfile(devArkiv, { witness: DEVNET_WITNESS_ADDRESS, url: 'http://localhost:9' }));

    // The settings URL is dead: the popup can only be online through the announced URL.
    await setLocal('recall.settings', { ...settings, witnessUrl: 'http://localhost:9' });
    try {
      const { tab, popup } = await openPopup(PAGE);
      try {
        await expect(popup.locator('.witness-chip')).toHaveText('Witness online', { timeout: 15_000 });
        await expect(popup.getByRole('button', { name: 'Capture this page' })).toBeEnabled();
      } finally {
        await popup.close();
        await tab.close();
      }
      // And a capture runs through it (fixture v2: the same bytes as the newest verified
      // capture, so it ends as a confirmation and uses no storage).
      await setVersion(2);
      const r = await capture(PAGE);
      expect([r.checks.A.status, r.checks.B.status, r.checks.C.status]).toEqual(['pass', 'pass', 'pass']);
      expect(r.upload?.status).toBe('confirmation');
    } finally {
      await setLocal('recall.settings', settings);
      await setVersion(1);
    }
  });

  test('witness offline: popup shows witness offline and Capture disabled', async () => {
    const compose = (cmd: string) =>
      promisify(execFile)('docker', ['compose', '-f', 'devnet/docker-compose.yml', cmd, 'witness'], {
        cwd: ROOT,
        timeout: 60_000,
      });
    await compose('stop');
    try {
      const { tab, popup } = await openPopup(PAGE, { later: true });
      try {
        await expect(popup.locator('.witness-chip')).toHaveText('Witness offline', { timeout: 15_000 });
        await expect(popup.getByRole('button', { name: 'Capture this page' })).toBeDisabled();
        await expect(popup.getByText('The witness is offline, so new captures are paused.')).toBeVisible();
        await expect(popup.getByRole('heading', { name: 'Witness offline' })).toBeVisible();
      } finally {
        await popup.close();
        await tab.close();
      }
    } finally {
      await compose('start');
      await expect
        .poll(async () => (await fetch('http://localhost:7047/info').catch(() => null))?.ok ?? false, {
          timeout: 60_000,
          intervals: [1_000],
        })
        .toBe(true);
    }
  });
});
