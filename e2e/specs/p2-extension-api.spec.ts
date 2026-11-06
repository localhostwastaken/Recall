import { expect, test, type Page, type Worker } from '@playwright/test';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { launchWithExtension, NOTICE_HOST, tabIdFor, type ExtensionSession } from '../fixtures/extension';
import { BEE_COMPOSE_FAUCET_KEY, DEV_PRIVATE_KEY } from '../fixtures/keys';
import { encodeEvidence, runChecks, urlHash, type EvidenceFile } from '../../packages/evidence/src/index';
import { arkivWallet, buyBatch, downloadBytes, LOCAL, writeCapture } from '../../packages/net/src/index';

// The extension's app-facing API (chrome.runtime.onMessageExternal), called from a page on
// the web app's origin (http://localhost:5173, listed in externally_connectable), plus the
// upload that follows a capture: the stamp key signs client-side postage stamps for one
// batch from the pool, and the evidence file goes to the local Bee node.

const APP = 'http://localhost:5173';
const NOTICE = `https://${NOTICE_HOST}/notice`;

type Pool = { batchId: Hex; used: boolean; usable?: boolean }[];
type Upload =
  | { status: 'uploaded'; captureId: string; evidenceRef: Hex; batchId: Hex }
  | { status: 'no_storage' | 'skipped' | 'failed'; reason?: string; error?: string };
type CaptureResult =
  | { evidence: EvidenceFile; checks: Record<'A' | 'B' | 'C', { status: string }>; upload?: Upload }
  | { error: string };
type Pending = {
  captureId: string;
  kind: 'capture' | 'confirmation';
  evidence: EvidenceFile;
  evidenceRef?: Hex;
  batchId?: Hex;
};

let ext: ExtensionSession;
let app: Page;
let stampAddress: Address;

const gnosisPayer = createWalletClient({
  account: privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY),
  chain: gnosis,
  transport: http(LOCAL.gnosis.rpcUrl),
});

/** Other suites use the same faucet key; a nonce race is retried. */
/** Batches need at least 2 days left to join the pool, so tests buy 3 unless told otherwise. */
async function buy(owner: Address, days = 3): Promise<Hex> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await buyBatch(gnosisPayer, { owner, depth: 17, days })).batchId;
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
      new Promise((resolve) => {
        const rt = (window as unknown as { chrome?: { runtime?: { sendMessage?: Function; lastError?: { message?: string } } } })
          .chrome?.runtime;
        if (!rt?.sendMessage) return resolve({ lastError: 'chrome.runtime is not exposed to this page' });
        rt.sendMessage(id, m, (res: unknown) => resolve(res ?? { lastError: rt.lastError?.message ?? 'no answer' }));
      }),
    [ext.extensionId, msg] as const,
  ) as Promise<T>;
}

async function storageLocal(key: string): Promise<unknown> {
  return sw().evaluate(async (k) => {
    const s = (globalThis as unknown as { chrome: { storage: { local: { get(k: string | null): Promise<Record<string, unknown>> } } } })
      .chrome.storage.local;
    return k === '*' ? s.get(null) : (await s.get(k))[k];
  }, key);
}

/** Writes (or, with undefined, removes) one chrome.storage.local key in the extension. */
async function setLocal(key: string, value: unknown): Promise<void> {
  await sw().evaluate(
    async ([k, v]) => {
      const s = (globalThis as unknown as {
        chrome: { storage: { local: { set(i: object): Promise<void>; remove(k: string): Promise<void> } } };
      }).chrome.storage.local;
      await (v === undefined ? s.remove(k) : s.set({ [k]: v }));
    },
    [key, value] as const,
  );
}

const pool = async () => ((await storageLocal('recall.pool')) as Pool | undefined) ?? [];
const unused = async () => (await pool()).filter((b) => !b.used).length;
const pendingKeys = async () =>
  Object.keys((await storageLocal('*')) as Record<string, unknown>).filter((k) => k.startsWith('recall.pending.'));

async function captureForTest(overrides?: object): Promise<CaptureResult> {
  const run = () =>
    sw().evaluate(
      async ([u, o]) => {
        const g = globalThis as unknown as { recall?: { captureForTest?: (url: string, o?: object) => Promise<unknown> } };
        if (!g.recall?.captureForTest) return { error: 'no recall.captureForTest in this build' };
        return g.recall.captureForTest(u, o);
      },
      [NOTICE, overrides] as const,
    ) as Promise<CaptureResult>;
  const first = await run();
  // The witness's known rare setup stall, or its admission limits: one retry.
  if ('error' in first && /witness busy|too many sessions|did not connect in time|timed out/i.test(first.error)) {
    test.info().annotations.push({ type: 'retried capture', description: first.error });
    return run();
  }
  return first;
}

async function openPopup(): Promise<{ tab: Page; popup: Page }> {
  const tab = await ext.context.newPage();
  await tab.goto(NOTICE);
  const tabId = await tabIdFor(sw(), NOTICE);
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
  return { tab, popup };
}

test.describe('@p2 extension api', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test.beforeAll(async () => {
    ext = await launchWithExtension({ dev: true });
    await settleServiceWorker();
    app = await ext.context.newPage();
    await app.goto(`${APP}/`);
    // The notice fixture serves version 1 unless a test changed it.
    const page = await ext.context.newPage();
    await page.goto(NOTICE);
    expect(await page.evaluate(async () => (await fetch('/__admin/version', { method: 'POST', body: '{"v":1}' })).status)).toBe(200);
    await page.close();
  });

  test.afterAll(async () => {
    await ext?.context.close();
  });

  test('stamp address is stable across reloads', async () => {
    const first = await api<{ address?: string; lastError?: string }>({ type: 'recall.getStampAddress' });
    expect(first.address, JSON.stringify(first)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Only the address leaves the extension, never the key.
    expect(Object.keys(first)).toEqual(['address']);
    stampAddress = first.address as Address;

    // Reload the extension: the service worker restarts, chrome.storage.local stays.
    const reloaded = ext.context.waitForEvent('serviceworker', { timeout: 15_000 });
    await sw()
      .evaluate(() => (globalThis as unknown as { chrome: { runtime: { reload(): void } } }).chrome.runtime.reload())
      .catch(() => undefined);
    await reloaded;
    await settleServiceWorker();
    await expect
      .poll(async () => (await api<{ address?: string }>({ type: 'recall.getStampAddress' })).address, { timeout: 15_000 })
      .toBe(stampAddress);

    // Unknown requests are refused; there is no way to read the key or enumerate captures.
    expect(await api({ type: 'recall.getStampKey' })).toEqual({ error: expect.stringMatching(/unknown/i) });
    expect(await api({ type: 'recall.listPending' })).toEqual({ error: expect.stringMatching(/unknown/i) });
  });

  test('empty pool shows buy-storage prompt', async () => {
    expect(await pool()).toEqual([]);
    const { tab, popup } = await openPopup();
    try {
      await expect(popup.getByText('Witness online')).toBeVisible();
      await expect(popup.getByRole('heading', { name: 'No storage left' })).toBeVisible();
      await expect(popup.getByText('Your prepaid storage is used up. Buy more to keep capturing.')).toBeVisible();
      // Capturing still works (checked, not uploaded), and the helper says so.
      await expect(popup.getByRole('button', { name: 'Capture this page' })).toBeEnabled();
      await expect(popup.getByText(/^No storage left: the page will be checked but not uploaded/)).toBeVisible();
      const opened = ext.context.waitForEvent('page');
      await popup.getByRole('button', { name: 'Buy storage' }).click();
      const storagePage = await opened;
      await expect.poll(() => storagePage.url()).toBe(`${APP}/#/storage`);
      await storagePage.close();

      // Only an expired batch left: a distinct notice (the popup follows the pool live).
      await setLocal('recall.pool', [
        {
          batchId: `0x${'ee'.repeat(32)}`,
          depth: 17,
          used: false,
          usable: false,
          startBlock: '1',
          addedAt: 1,
          dead: 'batch expired',
        },
      ]);
      await expect(popup.getByRole('heading', { name: 'Storage expired' })).toBeVisible();
      await expect(popup.getByText('Buy more in the Recall app.')).toBeVisible();
      await expect(popup.getByText(/^Storage expired: the page will be checked but not uploaded/)).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Buy storage' })).toBeVisible();
      await setLocal('recall.pool', undefined);
      await expect(popup.getByRole('heading', { name: 'No storage left' })).toBeVisible();
    } finally {
      await popup.close();
      await tab.close();
    }
  });

  test('capture with no storage is checked but not uploaded', async () => {
    const r = await captureForTest();
    if ('error' in r) throw new Error(r.error);
    expect([r.checks.A.status, r.checks.B.status]).toEqual(['pass', 'pass']);
    expect(r.upload?.status).toBe('no_storage');
    expect(await pendingKeys()).toEqual([]);

    const { tab, popup } = await openPopup();
    try {
      await expect(popup.getByRole('heading', { name: "Valid signature, but from a witness you haven't trusted" })).toBeVisible();
      await expect(popup.getByRole('heading', { name: 'No storage left' })).toBeVisible();
      await expect(popup.getByText(/Nothing was published\./)).toBeVisible();
    } finally {
      await popup.close();
      await tab.close();
    }
  });

  test('addBatches rejects a batch not owned by the stamp key', async () => {
    const foreign = await buy(privateKeyToAddress(generatePrivateKey()));
    const missing = `0x${'ab'.repeat(32)}` as Hex;

    const res = await api<{ error?: string; pool?: Pool; rejected?: { batchId: Hex; reason: string }[] }>({
      type: 'recall.addBatches',
      batchIds: [foreign, missing],
    });
    expect(res.error, JSON.stringify(res)).toBeTruthy();
    const reasons = Object.fromEntries((res.rejected ?? []).map((r) => [r.batchId.toLowerCase(), r.reason]));
    expect(reasons[foreign.toLowerCase()]).toMatch(/owner/i);
    expect(reasons[missing.toLowerCase()]).toMatch(/not found/i);
    expect(await pool()).toEqual([]);

    // Malformed requests are refused before any chain read.
    expect((await api<{ error?: string }>({ type: 'recall.addBatches', batchIds: ['0x1234'] })).error).toMatch(/batch id/i);
    expect((await api<{ error?: string }>({ type: 'recall.addBatches', batchIds: 'nope' })).error).toMatch(/batch id/i);
  });

  test('addBatches rejects a batch with less than 2 days left', async () => {
    // Owned by the stamp key and paid for, but only for one day.
    const short = await buy(stampAddress, 1);
    const res = await api<{ error?: string; rejected?: { batchId: Hex; reason: string }[] }>({
      type: 'recall.addBatches',
      batchIds: [short],
    });
    expect(res.error, JSON.stringify(res)).toBeTruthy();
    expect(res.rejected).toEqual([
      { batchId: short.toLowerCase(), reason: expect.stringMatching(/storage left; needs at least 2 days/) },
    ]);
    expect(await pool()).toEqual([]);
  });

  let captureId: string;
  let captured: EvidenceFile;
  let usedBatch: Hex;
  let evidenceRef: Hex;

  test('addBatches then capture uploads using one batch', async () => {
    const ids = [await buy(stampAddress), await buy(stampAddress)];
    const added = await api<{ pool?: Pool; error?: string }>({ type: 'recall.addBatches', batchIds: ids });
    expect(added.error, JSON.stringify(added)).toBeUndefined();
    expect(added.pool?.map((b) => [b.batchId.toLowerCase(), b.used]).sort()).toEqual(
      ids.map((id) => [id.toLowerCase(), false]).sort(),
    );
    // Adding the same batches again changes nothing.
    const again = await api<{ pool?: Pool }>({ type: 'recall.addBatches', batchIds: ids });
    expect(again.pool).toHaveLength(2);

    const r = await captureForTest();
    if ('error' in r) throw new Error(r.error);
    // Default settings pin no witness: C warns, and a warning still uploads.
    expect([r.checks.A.status, r.checks.B.status, r.checks.C.status]).toEqual(['pass', 'pass', 'warn']);
    expect(r.upload?.status, JSON.stringify(r.upload)).toBe('uploaded');
    const up = r.upload as Extract<Upload, { status: 'uploaded' }>;
    expect(up.captureId).toMatch(/^[0-9a-f]{32}$/);
    captureId = up.captureId;
    captured = r.evidence;
    usedBatch = up.batchId;
    evidenceRef = up.evidenceRef;

    expect(await unused()).toBe(1);
    const p = await pool();
    expect(p.find((b) => b.batchId.toLowerCase() === up.batchId.toLowerCase())?.used).toBe(true);

    const pending = await api<Pending & { error?: string }>({ type: 'recall.getPending', captureId });
    expect(pending.error, JSON.stringify(pending)).toBeUndefined();
    expect(pending.captureId).toBe(captureId);
    expect(pending.kind).toBe('capture');
    expect(pending.evidenceRef).toBe(up.evidenceRef);
    expect(pending.batchId).toBe(up.batchId);
    expect(pending.evidence).toEqual(r.evidence);

    // The uploaded bytes are exactly the encoded evidence file, readable from the other node.
    const down = await downloadBytes(pending.evidenceRef!, ['http://localhost:1643']);
    expect(Buffer.from(down.bytes).equals(Buffer.from(encodeEvidence(pending.evidence)))).toBe(true);

    // The popup shows the upload.
    const { tab, popup } = await openPopup();
    try {
      await expect(popup.getByRole('heading', { name: 'Uploaded. Ready to publish' })).toBeVisible();
    } finally {
      await popup.close();
      await tab.close();
    }
  });

  test('getPending with a wrong captureId returns nothing', async () => {
    const wrong = [
      generatePrivateKey().slice(2, 34),
      captureId.slice(0, 31),
      captureId.toUpperCase(),
      `${captureId}0`,
      '',
      42,
    ];
    for (const id of wrong) {
      const res = await api<Record<string, unknown>>({ type: 'recall.getPending', captureId: id });
      expect(res, String(id)).toEqual({ error: expect.any(String) });
    }
  });

  test('markPublished checks the Arkiv entity before marking', async () => {
    const report = await runChecks(captured, { pinnedWitnesses: [] });
    const f = report.facts!;
    const wallet = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(DEV_PRIVATE_KEY));
    const row = {
      urlHash: urlHash(f.canonicalUrl),
      bodySha256: f.bodySha256,
      serverName: f.serverName,
      witness: f.witness,
      signedAt: f.signedAt,
      httpStatus: f.httpStatus,
      batchId: usedBatch,
      evidenceRef,
      canonicalUrl: f.canonicalUrl,
    };
    const write = async (r: typeof row) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return (await writeCapture(wallet, r)).entityKey;
        } catch (err) {
          if (attempt >= 3 || !/nonce|underpriced|already known/i.test(String(err))) throw err;
          await new Promise((res) => setTimeout(res, 2_000));
        }
      }
    };

    // An entity that points at other evidence does not count.
    const junk = await write({ ...row, evidenceRef: `0x${'cd'.repeat(32)}` as Hex });
    const refused = await api<{ error?: string }>({ type: 'recall.markPublished', captureId, entityKey: junk });
    expect(refused.error).toMatch(/does not match/i);
    // Nor does a key with no entity behind it, or a wrong capture id.
    expect((await api<{ error?: string }>({ type: 'recall.markPublished', captureId, entityKey: `0x${'01'.repeat(32)}` })).error).toBeTruthy();
    const real = await write(row);
    expect(
      (await api<{ error?: string }>({ type: 'recall.markPublished', captureId: generatePrivateKey().slice(2, 34), entityKey: real }))
        .error,
    ).toBeTruthy();
    // Still pending after the refusals.
    expect((await api<Pending>({ type: 'recall.getPending', captureId })).captureId).toBe(captureId);

    expect(await api({ type: 'recall.markPublished', captureId, entityKey: real })).toEqual({ ok: true });
    // Published: no longer pending, and a repeated mark is harmless.
    expect(await api({ type: 'recall.getPending', captureId })).toEqual({ error: expect.any(String) });
    expect(await api({ type: 'recall.markPublished', captureId, entityKey: real })).toEqual({ ok: true });
  });

  test('capture with failing checks does not upload', async () => {
    const before = { pool: await pool(), pending: await pendingKeys() };
    expect(before.pool.filter((b) => !b.used)).toHaveLength(1);

    // Dev override: one byte of the received transcript is flipped after signing, so A fails.
    const r = await captureForTest({ tamperEvidence: true });
    if ('error' in r) throw new Error(r.error);
    expect(r.checks.A.status).toBe('fail');
    expect(r.upload?.status).toBe('skipped');
    expect(await pool()).toEqual(before.pool);
    expect(await pendingKeys()).toEqual(before.pending);
  });
});
