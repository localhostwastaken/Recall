import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Worker } from '@playwright/test';
import { http, sha256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { launchWithExtension, type ExtensionSession } from '../fixtures/extension';
import { ensureArkivGas, fundWallet } from '../fixtures/fund';
import { DEVNET_WITNESS_ADDRESS } from '../fixtures/keys';
import { installMockWallet } from '../fixtures/mockWallet';
import { Rig } from '../fixtures/verifyRig';
import { buildFixtureRepos } from '../../fixtures/notice/gitRepo';
import { canonicalUrl, decodeEvidence, gitTreeFromTarGz, runChecks, urlHash } from '../../packages/evidence/src/index';
import {
  ATTACHMENT_MAX_DOWNLOAD_BYTES,
  LOCAL,
  POSTAGE_STAMP,
  arkivPublic,
  arkivWallet,
  downloadBytes,
  listAttachments,
  listByUrl,
  writeAttachment,
  type CaptureRow,
  type Listed,
} from '../../packages/net/src/index';

// R46, the .git adapter on the devnet fixture (the notice fixture plays GitHub as
// api.github.recall.test and codeload.github.recall.test). Real dev extension, devnet witness,
// local Bee, local Gnosis fork and local Arkiv; MetaMask is the only stand-in (a mock wallet with a
// real, freshly funded key).
// - recall-fixture/demo: the popup offers "Capture this repository"; the capture notarizes GitHub's
//   branch answer and checks the code; the publish page buys a depth-18 batch, the extension uploads
//   the evidence and the code, the page re-checks the code and writes both records; the record page
//   shows a "Repository snapshot" card that turns Hash-anchored, and the download is the same file.
// - recall-fixture/tampered: its branch JSON names the honest tree but its tarball has one file
//   changed: the capture fails and nothing is kept or published.
// - An attacker's attachment record that names a genuine capture but points at other code is
//   never green (next to the genuine one, and alone).

const APP = 'http://localhost:5173';
const OWNER = 'recall-fixture';
// The dev build accepts github.com and github.recall.test as repository pages; the page itself is
// stubbed by the test (only its URL matters to the popup).
const DEMO_PAGE = `https://github.recall.test/${OWNER}/demo`;
const TAMPERED_PAGE = `https://github.recall.test/${OWNER}/tampered`;
const API_HOST = 'api.github.recall.test';
const DEMO_API = `https://${API_HOST}/repos/${OWNER}/demo/branches/main`;
const TAMPERED_API = `https://${API_HOST}/repos/${OWNER}/tampered/branches/main`;
const MISMATCH = "The repository snapshot doesn't match the commit GitHub reported";
const hashOf = (u: string) => urlHash(canonicalUrl(u));
/** What the web app indexes a code record under (apps/web/src/attachments/git.ts repoUrlHash). */
const repoHash = (repo: string) => urlHash(`https://github.com/${OWNER}/${repo}`.toLowerCase());

const here = dirname(fileURLToPath(import.meta.url));
// The same files the fixture container builds its repositories from (deterministic ids).
const git = buildFixtureRepos(resolve(here, '../../fixtures/notice/content/repo'));

type Pending = {
  captureId?: string;
  kind?: string;
  upload?: { status: string };
  storage?: string;
  attachment?: { sha256: Hex; size: number; files: number; commitSha: string; treeSha: string };
  needsDepth?: number;
  error?: string;
};

let ext: ExtensionSession;
let app: Page;
let walletKey: Hex;
const pub = arkivPublic(LOCAL);

// Set by the first test, used by the attacker test.
let genuine: { captureKey: Hex; codeKey: Hex; row: Extract<Listed, { kind: 'capture' }> } | undefined;

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

const pendingOf = (captureId: string) => api<Pending>({ type: 'recall.getPending', captureId });
const jobState = () =>
  sw().evaluate(async () => {
    const s = (globalThis as unknown as { chrome: { storage: { session: { get(k: string): Promise<Record<string, unknown>> } } } })
      .chrome.storage.session;
    return (await s.get('recall.capture'))['recall.capture'] as
      | { status?: string; error?: string; upload?: { status?: string; captureId?: string } }
      | undefined;
  });

/** Opens the repository page (stubbed) and the popup for its tab. */
async function popupFor(pageUrl: string): Promise<{ tab: Page; popup: Page }> {
  const tab = await ext.context.newPage();
  await tab.goto(pageUrl);
  const tabId = await sw().evaluate(async (u) => {
    const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } }).chrome.tabs;
    return (await tabs.query({})).find((t) => t.url === u)?.id ?? null;
  }, pageUrl);
  expect(tabId, `a tab for ${pageUrl}`).not.toBeNull();
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
  await expect(popup.getByText('Witness online')).toBeVisible({ timeout: 15_000 });
  return { tab, popup };
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
  await installMockWallet(page!, {
    privateKey: walletKey,
    rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
    chainId: 1337,
    ...(onSent ? { onSent } : {}),
  });
  await page!.reload();
  return page!;
}

const snapshotCards = (page: Page) => page.locator('section.repo-snapshot');

test.describe('@p2 repo', () => {
  test.describe.configure({ mode: 'serial', timeout: 600_000 });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    ext = await launchWithExtension({ dev: true });
    // A repository page is only a URL to the popup: serve a stub instead of the real site.
    await ext.context.route('https://github.recall.test/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>repository</title><h1>repository</h1>' }),
    );
    await settleServiceWorker();
    app = await ext.context.newPage();
    await app.goto(`${APP}/`);
    const settings = (await getLocal('recall.settings')) as Record<string, unknown>;
    await setLocal('recall.settings', { ...settings, pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    // A fresh MetaMask account: xDAI for gas and xBZZ for a depth-18 batch on Gnosis, gas on Arkiv.
    walletKey = generatePrivateKey();
    await fundWallet(privateKeyToAccount(walletKey).address, 10n * 10n ** 16n);
  });

  test.afterAll(async () => {
    await ext?.context.close();
  });

  test('a repository: capture, buy depth-18 storage and publish; the snapshot is hash-anchored and downloads', async () => {
    const { tab, popup } = await popupFor(DEMO_PAGE);
    const button = popup.getByRole('button', { name: 'Capture this repository' });
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await expect(popup.getByText("branch main · notarizes GitHub's commit, then checks the code")).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Capture this page' })).toHaveCount(0);
    await button.click();
    await expect(popup.getByRole('heading', { name: 'Continue in the Recall tab' })).toBeVisible({ timeout: 180_000 });
    const job = await jobState();
    expect(job?.upload?.status).toBe('pending');
    const captureId = job!.upload!.captureId!;
    await popup.close();
    await tab.close();

    // Kept without any upload, with the checked code's summary and the depth it needs.
    const kept = await pendingOf(captureId);
    expect(kept).toMatchObject({
      captureId,
      kind: 'capture',
      upload: { status: 'none' },
      needsDepth: 18,
      attachment: { kind: 'git', owner: OWNER, repo: 'demo', branch: 'main', commitSha: git.good.commitSha, treeSha: git.good.treeSha, files: 5 },
    });
    const summary = kept.attachment!;
    expect(summary.sha256).toMatch(/^0x[0-9a-f]{64}$/);

    const sent: { chainId: number; to?: string }[] = [];
    const page = await approvalTab(captureId, (chainId, _hash, to) => sent.push({ chainId, to: to?.toLowerCase() }));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Save this capture');
    for (const k of ['A', 'B', 'C']) {
      await expect(page.locator(`.approve-check-list [data-check="${k}"] .badge`)).toHaveAttribute('data-status', 'pass');
    }
    await expect(page.locator('#repo-title')).toContainText(`Repository ${OWNER}/demo @ ${git.good.commitSha.slice(0, 7)}`);
    await expect(page.getByText(/big enough for the code \(depth 18\): about [\d.]+ xBZZ/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Buy storage and publish' }).click();
    await expect(page.getByRole('heading', { name: 'Which extension should own this storage?' })).toBeVisible();
    await page.getByRole('button', { name: 'Use this extension' }).click();

    await expect(page.getByRole('heading', { name: 'Published', exact: true })).toBeVisible({ timeout: 500_000 });
    await expect(page.locator('.approve-repo')).toHaveAttribute('data-checked', 'true');
    const keys = page.locator('.approve-record .mono-value');
    await expect(keys).toHaveCount(2);
    const captureKey = (await keys.nth(0).getAttribute('title')) as Hex;
    const codeKey = (await keys.nth(1).getAttribute('title')) as Hex;
    expect(captureKey).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(codeKey).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(sent.filter((s) => s.chainId === 100 && s.to === POSTAGE_STAMP.toLowerCase())).toHaveLength(1);
    expect(await pendingOf(captureId)).toEqual({ error: expect.any(String) });
    await page.close();

    // On Arkiv: the capture of GitHub's branch answer, and a code record naming it.
    const listed = await listByUrl(pub, hashOf(DEMO_API));
    const row = listed.rows.find((x) => x.entityKey.toLowerCase() === captureKey.toLowerCase());
    expect(row?.kind).toBe('capture');
    const cap = row as Extract<Listed, { kind: 'capture' }>;
    const evidence = await downloadBytes(cap.evidenceRef, LOCAL.swarm.downloadUrls);
    const report = await runChecks(decodeEvidence(evidence.bytes), { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    expect([report.A.status, report.B.status, report.C.status]).toEqual(['pass', 'pass', 'pass']);
    const codes = (await listAttachments(pub, captureKey)).rows;
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({
      entityKey: codeKey,
      kind: 'git',
      proofLevel: 1,
      commitSha: git.good.commitSha,
      treeSha: git.good.treeSha,
      sha256: summary.sha256,
      size: BigInt(summary.size),
      batchId: cap.batchId,
    });
    expect(codes[0]!.urlHash.toLowerCase()).toBe(repoHash('demo').toLowerCase());
    // The uploaded code is the checked snapshot: it hashes to the notarized tree.
    const code = await downloadBytes(codes[0]!.evidenceRef, LOCAL.swarm.downloadUrls, { maxBytes: ATTACHMENT_MAX_DOWNLOAD_BYTES });
    expect(sha256(code.bytes)).toBe(summary.sha256);
    expect(gitTreeFromTarGz(code.bytes).treeSha).toBe(git.good.treeSha);
    genuine = { captureKey, codeKey, row: cap };

    // The record page: a GitHub branch capture with a hash-anchored snapshot whose download is that file.
    const rec = await ext.context.newPage();
    await rec.goto(`${APP}/#/c/${captureKey}`);
    await expect(rec.getByText(`GitHub branch ${OWNER}/demo@main`)).toBeVisible({ timeout: 60_000 });
    const card = snapshotCards(rec);
    await expect(card).toHaveCount(1, { timeout: 60_000 });
    await expect(card.getByRole('heading', { name: 'Repository snapshot' })).toBeVisible();
    await expect(card.locator('.badge')).toHaveText('Hash-anchored', { timeout: 120_000 });
    await expect(card).toHaveAttribute('data-phase', 'ok');
    await expect(card.getByText(git.good.commitSha.slice(0, 7), { exact: true })).toBeVisible();
    const downloading = rec.waitForEvent('download');
    await card.getByRole('button', { name: 'Download code (.tar.gz)' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`demo-${git.good.commitSha.slice(0, 7)}.tar.gz`);
    const saved = new Uint8Array(readFileSync((await download.path())!));
    expect(sha256(saved)).toBe(summary.sha256);
    expect(gitTreeFromTarGz(saved).treeSha).toBe(git.good.treeSha);
    await rec.close();
  });

  test('a tampered repository: the capture fails on the code check and nothing is published', async () => {
    const { tab, popup } = await popupFor(TAMPERED_PAGE);
    const button = popup.getByRole('button', { name: 'Capture this repository' });
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    await expect(popup.getByText(`${MISMATCH}. Nothing was published.`)).toBeVisible({ timeout: 180_000 });
    await expect(popup.getByRole('heading', { name: 'Continue in the Recall tab' })).toHaveCount(0);
    const job = await jobState();
    expect(job?.status).toBe('error');
    expect(job?.error).toBe(MISMATCH);
    expect(job?.upload).toBeUndefined();
    await popup.close();
    await tab.close();
    // No publish tab, and nothing on Arkiv for this branch.
    expect(ext.context.pages().filter((p) => p.url().includes('#/approve/'))).toHaveLength(0);
    expect((await listByUrl(pub, hashOf(TAMPERED_API))).rows).toHaveLength(0);
  });

  test("an attacker's code record that points at other code is never green", async () => {
    expect(genuine, 'the genuine repository capture from the first test').toBeDefined();
    const { captureKey } = genuine!;
    // The attacker uploads other code (the demo commit with one file changed) and writes a record
    // that claims the genuine commit and tree.
    const rig = await Rig.create();
    const other = new Uint8Array(git.tamperedTarGzOfGood);
    expect(gitTreeFromTarGz(other).treeSha).not.toBe(git.good.treeSha);
    const otherRef = await rig.upload(other);
    const attackerKey = generatePrivateKey();
    await ensureArkivGas(privateKeyToAccount(attackerKey).address);
    const attacker = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(attackerKey));
    const claim = (parentCaptureKey: Hex) => ({
      parentCaptureKey,
      urlHash: repoHash('demo'),
      sha256: sha256(other),
      kind: 'git' as const,
      commitSha: git.good.commitSha,
      treeSha: git.good.treeSha,
      proofLevel: 1 as const,
      evidenceRef: otherRef,
      batchId: rig.batchId,
      size: BigInt(other.length),
      contentType: 'application/gzip',
    });

    // 1. Next to the genuine code record: the genuine one stays green, the attacker's is not.
    await writeAttachment(attacker, claim(captureKey));
    await expect.poll(async () => (await listAttachments(pub, captureKey)).rows.length, { timeout: 30_000 }).toBe(2);
    const rec = await ext.context.newPage();
    await rec.goto(`${APP}/#/c/${captureKey}`);
    const cards = snapshotCards(rec);
    await expect(cards).toHaveCount(2, { timeout: 60_000 });
    await expect(rec.locator('section.repo-snapshot[data-phase="ok"]')).toHaveCount(1, { timeout: 120_000 });
    const bad = rec.locator('section.repo-snapshot[data-phase="mismatch"]');
    await expect(bad).toHaveCount(1, { timeout: 120_000 });
    await expect(bad.locator('.badge')).toHaveText("Doesn't match");
    await expect(bad.getByRole('alert')).toContainText("The downloaded code doesn't match this capture");
    await expect(bad.getByRole('button', { name: 'Download code (.tar.gz)' })).toBeDisabled();
    await rec.close();

    // 2. Alone: a genuine capture (the same verified evidence, indexed again by an honest writer)
    //    whose only code record is the attacker's. Nothing on the page is hash-anchored.
    const r = genuine!.row;
    const honestRow: CaptureRow = {
      urlHash: r.urlHash,
      bodySha256: r.bodySha256,
      serverName: r.serverName,
      witness: r.witness,
      signedAt: r.signedAt,
      httpStatus: r.httpStatus,
      batchId: r.batchId,
      evidenceRef: r.evidenceRef,
      canonicalUrl: r.canonicalUrl,
    };
    const lone = await rig.write(honestRow);
    await writeAttachment(attacker, claim(lone));
    await expect.poll(async () => (await listAttachments(pub, lone)).rows.length, { timeout: 30_000 }).toBe(1);
    const page = await ext.context.newPage();
    await page.goto(`${APP}/#/c/${lone}`);
    await expect(page.getByText(`GitHub branch ${OWNER}/demo@main`)).toBeVisible({ timeout: 60_000 });
    const card = snapshotCards(page);
    await expect(card).toHaveCount(1, { timeout: 60_000 });
    await expect(card).toHaveAttribute('data-phase', 'mismatch', { timeout: 120_000 });
    await expect(card.locator('.badge')).toHaveText("Doesn't match");
    await expect(page.getByText('Hash-anchored')).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Download code (.tar.gz)' })).toBeDisabled();
    await page.close();
  });
});
