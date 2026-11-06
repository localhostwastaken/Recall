import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  createPublicClient,
  decodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { installMockWallet } from '../fixtures/mockWallet';
import {
  POSTAGE_STAMP,
  XBZZ,
  arkivPublic,
  batchTtlSeconds,
  blocksForDays,
  liveConfig,
  normalizeKey,
  readBatch,
  topUpCost,
} from '../../packages/net/src/index';

// P4 live check: keep the P2 live capture alive on the real networks through the REAL app's
// keep-alive dialog. The capture's detail page is this checkout's live web build (apps/web/dist,
// `VITE_RECALL_NET=live pnpm --filter web build`) served at the Pages origin; MetaMask is the only
// stand-in (the mock wallet, backed by the treasury key). Step 1 tops up the capture's Swarm batch
// on Gnosis (xBZZ), step 2 extends its Arkiv record on Rabdi. Every number asserted is read from
// the chains before and after, never from the page.
//
// - The dialog offers 7 or 30 days, so the run keeps the capture alive by 7 days (the shortest it
//   offers): about 0.32 xBZZ for a depth-17 batch at the current price.
// - Spend caps (ruling for T20): 0.35 xBZZ, 0.002 xDAI, 0.5 tGLM. The price is read from Gnosis and
//   checked against the xBZZ cap BEFORE the dialog is opened; the dialog's own price is checked too.
// - Every top-up this check sends is noted next to the other live ledgers (<tmp>/recall-live/
//   p4-ledger.json: hashes and the quoted xBZZ, nothing secret) the moment it is sent, so a rerun
//   can never take the total past the cap.
// - RECALL_P4_DRY=1 runs everything up to the priced dialog and stops before Start (nothing sent).
// - The P2 record was written before records became read-only; it carries permissionlessExtension,
//   so anyone may extend it (here the treasury, which also owns it).

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_DIST = join(ROOT, 'apps/web/dist');
const LEDGER_DIR = join(tmpdir(), 'recall-live');
const LEDGER_FILE = join(LEDGER_DIR, 'p4-ledger.json');

const APP_URL = 'https://localhostwastaken.github.io/Recall/app/';
const GNOSIS_RPC = 'https://rpc.gnosischain.com';
/** The public Rabdi endpoint (no access key in any URL this test could print). */
const RABDI_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network';
const RABDI_ID = 7794095;

/** The P2 live capture (docs/evidence-log.md, "2026-11-06 live P2 check"). */
const ENTITY: Hex = '0xc50021a907dbd1d511d2e4a1482614647cbbb4a0dd2d4bf26ad70065b3611244';
const BATCH: Hex = '0xde1b6b808de55064687e6c1ef7eae9aef91d9d9167d44719a2350fb3c6d8dd63';
const BATCH_OWNER: Address = '0x5455B84fcB0a05C0B68F8262a183D7e28f2a4212';
const DEPTH = 17;

/** The shortest choice the dialog offers. */
const DAYS = 7;
const DAY = 86_400;
const CAP_XBZZ = parseUnits('0.35', 16);
const CAP_XDAI = parseUnits('0.002', 18);
const CAP_TGLM = parseUnits('0.5', 18);

const postageAbi = parseAbi(['function topUp(bytes32 _batchId, uint256 _topupAmountPerChunk)', 'function lastPrice() view returns (uint64)']);

const gnosisPub = createPublicClient({ chain: gnosis, transport: http(GNOSIS_RPC, { retryCount: 3 }) }) as PublicClient;
const rabdiPub = arkivPublic({ ...liveConfig({}), arkiv: { chain: 'rabdi', rpcUrl: RABDI_RPC } });

function treasuryKey(): Hex {
  const k = process.env.TREASURY_PRIVATE_KEY;
  if (!k) throw new Error('TREASURY_PRIVATE_KEY is not set (.env.local)');
  return normalizeKey(k);
}

/** Anything this test prints goes through here, so the Arkiv access key (in the app's Rabdi URL) never does. */
function redact(text: string): string {
  const key = (process.env.ARKIV_ACCESS_KEY ?? '').trim();
  let out = text;
  if (key) out = out.split(key).join('<access key>').split(encodeURIComponent(key)).join('<access key>');
  return out.replace(/\s+/g, ' ').trim();
}

type Ledger = { spentXbzz: string; topUps: { hash: Hex; quotedXbzz: string; at: string }[]; runs: object[] };
function readLedger(): Ledger {
  try {
    return JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as Ledger;
  } catch {
    return { spentXbzz: '0', topUps: [], runs: [] };
  }
}
const writeLedger = (l: Ledger) => writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2));

/** Serves this checkout's live web build at the deployed app's URL. */
async function serveApp(ctx: BrowserContext): Promise<void> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
  };
  await ctx.route(/^https:\/\/localhostwastaken\.github\.io\/Recall\/app\//, async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/Recall\/app\/?/, ''));
    const file = resolve(APP_DIST, path || 'index.html');
    if (!file.startsWith(APP_DIST + sep) || !existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
    await route.fulfill({ status: 200, contentType: types[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
  });
}

/** Everything this check reads from the chains, before and after. */
async function readChains(treasury: Address) {
  const [batch, ttl, price, entity, timing, xbzz, xdai, tglm] = await Promise.all([
    readBatch(gnosisPub, BATCH),
    batchTtlSeconds(gnosisPub, BATCH),
    gnosisPub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'lastPrice' }),
    rabdiPub.getEntity(ENTITY),
    rabdiPub.getBlockTiming(),
    gnosisPub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [treasury] }),
    gnosisPub.getBalance({ address: treasury }),
    rabdiPub.getBalance({ address: treasury }),
  ]);
  const at = Date.now();
  if (!batch) throw new Error(`batch ${BATCH} is not on Gnosis`);
  if (ttl === null) throw new Error(`batch ${BATCH} has expired`);
  return {
    at,
    batch,
    ttl,
    price: BigInt(price),
    batchEndsAt: new Date(at + Number(ttl) * 1000),
    expiresAt: entity.$expiresAt,
    flags: (entity as unknown as { $creationFlags?: { readonly: boolean; permissionlessExtension: boolean } }).$creationFlags,
    currentBlock: timing.currentBlock,
    blockSeconds: timing.blockDuration,
    entityEndsAt: new Date(at + Number(entity.$expiresAt - timing.currentBlock) * timing.blockDuration * 1000),
    xbzz,
    xdai,
    tglm,
  };
}

let browser: Browser;
let context: BrowserContext;
let page: Page;

test.describe('@live p4', () => {
  test.beforeAll(async () => {
    const index = join(APP_DIST, 'index.html');
    if (!existsSync(index)) throw new Error(`No live web build at ${index}. Run: VITE_RECALL_NET=live pnpm --filter web build`);
    mkdirSync(LEDGER_DIR, { recursive: true });
    browser = await chromium.launch({
      channel: 'chromium',
      headless: !process.env.HEADED,
      // UDP to Cloudflare-fronted hosts is throttled on this network (see p2-live).
      args: ['--disable-quic'],
    });
    context = await browser.newContext({ colorScheme: 'light' });
    await serveApp(context);
  });

  test.afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  test('p4 keep-alive tops up the Gnosis batch and extends the Rabdi record of the P2 capture', async () => {
    test.setTimeout(900_000);
    const treasury = privateKeyToAccount(treasuryKey()).address;
    const before = await readChains(treasury);

    // The target is the P2 capture's own batch, as P2 bought it.
    expect(getAddress(before.batch.owner)).toBe(BATCH_OWNER);
    expect(before.batch.depth).toBe(DEPTH);
    expect(before.batch.immutable).toBe(true);
    expect(before.flags?.permissionlessExtension, 'anyone may extend the P2 record').toBe(true);

    // The price, from Gnosis, against the cap, before anything is shown or sent.
    const ledger = readLedger();
    const quoted = (await topUpCost(gnosisPub, BATCH, DAYS)).total;
    // A dry run (RECALL_P4_DRY=1) stops before Start and sends nothing, so earlier top-ups don't count against it.
    const dry = !!process.env.RECALL_P4_DRY;
    const already = dry ? 0n : ledger.topUps.reduce((s, t) => s + BigInt(t.quotedXbzz), 0n);
    expect(
      already + quoted,
      `a ${DAYS}-day top-up costs ${formatUnits(quoted, 16)} xBZZ; ${formatUnits(already, 16)} already sent by this check; cap ${formatUnits(CAP_XBZZ, 16)}`,
    ).toBeLessThanOrEqual(CAP_XBZZ);
    expect(before.xbzz, 'treasury xBZZ').toBeGreaterThanOrEqual(quoted);
    expect(before.xdai, 'treasury xDAI for fees').toBeGreaterThan(parseUnits('0.001', 18));

    // The app at the Pages origin, with the treasury-backed wallet. Every transaction it sends is noted.
    const sent: { chainId: number; hash: Hex; to?: Address }[] = [];
    /** The price the dialog showed when Start was pressed: the most its top-up may cost. */
    let agreed = quoted;
    page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(redact(e.message)));
    await installMockWallet(page, {
      privateKey: treasuryKey(),
      rpcByChainId: { 100: GNOSIS_RPC, [RABDI_ID]: RABDI_RPC },
      chainId: 100,
      onSent: (chainId, hash, to) => {
        sent.push({ chainId, hash, ...(to ? { to } : {}) });
        if (chainId === 100 && to && getAddress(to) === getAddress(POSTAGE_STAMP)) {
          // A top-up is noted at once with the price agreed to, whatever happens next.
          const l = readLedger();
          l.topUps.push({ hash, quotedXbzz: String(agreed), at: new Date().toISOString() });
          writeLedger(l);
        }
      },
    });
    await page.goto(`${APP_URL}#/c/${ENTITY}`);
    const ourBundle = /src="\.\/(assets\/index-[^"]+\.js)"/.exec(readFileSync(join(APP_DIST, 'index.html'), 'utf8'))![1];
    expect(await page.evaluate(() => [...document.scripts].map((x) => x.src))).toContain(`${APP_URL}${ourBundle}`);

    // The detail page verifies the capture (A to C from the evidence on Swarm, E from the chains).
    await expect(page.locator('[data-verdict]')).toHaveAttribute('data-verdict', 'pass', { timeout: 120_000 });
    // Check E warns while the storage has under a week left (the app's "expires soon"), else passes.
    const soon = Number(before.ttl) < 7 * DAY;
    await expect(page.locator('[data-check="E"] [data-status]')).toHaveAttribute('data-status', soon ? 'warn' : 'pass', {
      timeout: 60_000,
    });
    if (soon) await expect(page.locator('[data-check="E"]')).toContainText(/Expires (in \d+ days?|within a day)\. Keep it alive/);
    const eBefore = redact((await page.locator('[data-check="E"]').textContent()) ?? '');

    await page.getByRole('button', { name: 'Keep alive…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Keep this capture available' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio', { name: `${DAYS} days` })).toBeChecked();
    await expect(dialog.locator('.steps-list li')).toHaveText([/^Top up storage \(Gnosis\)/, /^Extend record \(Arkiv Rabdi\)/]);
    const start = dialog.getByRole('button', { name: 'Start: step 1 of 2' });
    const quote = dialog.locator('.ka-quote');
    /** Waits for the dialog's price and checks it against the cap before Start may be pressed. */
    const readShownPrice = async (): Promise<string> => {
      await expect(start).toBeEnabled({ timeout: 60_000 });
      await expect(quote).toContainText(`Storage batch: ${BATCH.slice(0, 6)}…${BATCH.slice(-4)} · depth ${DEPTH}`);
      const text = redact((await quote.textContent()) ?? '');
      const shown = /Storage: ([\d.]+) xBZZ on Gnosis/.exec(text);
      expect(shown, text).not.toBeNull();
      // The dialog's price (rounded up for display) must be within the cap.
      agreed = parseUnits(shown![1]!, 16);
      expect(agreed, `the dialog asks ${shown![1]} xBZZ`).toBeLessThanOrEqual(CAP_XBZZ - already);
      return text;
    };
    const quoteText = await readShownPrice();
    if (dry) {
      // A dry run stops here: the page verified, the dialog priced it, nothing was sent.
      console.log('P4 LIVE dry run', JSON.stringify({ quoted: formatUnits(quoted, 16), quote: quoteText, checkE: eBefore, pageErrors }));
      expect(sent).toEqual([]);
      return;
    }

    // Step 1: approve xBZZ (if the allowance is short), then top up, on Gnosis. If the price moves
    // after the preview, the dialog sends no top-up and shows the new price (the payment is tied
    // to what was shown): that price is checked against the cap again before Start is pressed again.
    const continueBtn = dialog.getByRole('button', { name: 'Continue: step 2 of 2' });
    const priceChanged = dialog.getByText('The storage price changed.', { exact: true });
    // Errors are role=alert; a step that "may have gone through" (or a changed batch) is a warning.
    const problem = dialog.locator('.notice-error, .notice-warn').first();
    const requotes: string[] = [];
    for (let attempt = 1; ; attempt++) {
      await start.click();
      let outcome = 'busy';
      await expect
        .poll(
          async () =>
            (outcome = (await continueBtn.isVisible())
              ? 'step 2'
              : (await priceChanged.isVisible())
                ? 'price changed'
                : (await problem.isVisible())
                  ? 'problem'
                  : 'busy'),
          { timeout: 300_000, intervals: [2_000] },
        )
        .not.toBe('busy');
      if (outcome === 'step 2') break;
      if (outcome === 'price changed' && attempt < 3) {
        requotes.push(await readShownPrice());
        console.log('P4 LIVE the price moved after the preview; new quote', JSON.stringify(requotes.at(-1)));
        continue;
      }
      throw new Error(`step 1: ${redact((await dialog.textContent()) ?? '')} (sent: ${JSON.stringify(sent)})`);
    }
    const between = redact((await dialog.locator('.notice, [role="status"]').allTextContents()).join(' | '));

    // Step 2: extend the record on Rabdi.
    await continueBtn.click();
    const kept = dialog.getByText(/^Kept alive until \d+ \w+ \d{4}\.$/);
    await expect
      .poll(async () => ((await kept.isVisible()) ? 'done' : (await problem.isVisible()) ? 'problem' : 'busy'), {
        timeout: 240_000,
        intervals: [2_000],
      })
      .not.toBe('busy');
    // Whatever the dialog says, the chains are read below; the dialog's own outcome is checked last.
    const uiDone = await kept.isVisible();
    const doneText = redact((await dialog.locator('.ka-body').textContent()) ?? '');
    console.log('P4 LIVE sent', JSON.stringify(sent));

    // The chains, not the page, say it worked. First the transactions the wallet sent.
    const gnosisTxs = sent.filter((s) => s.chainId === 100).map((s) => s.hash);
    const rabdiTxs = sent.filter((s) => s.chainId === RABDI_ID).map((s) => s.hash);
    const receipts = await Promise.all(gnosisTxs.map((hash) => gnosisPub.waitForTransactionReceipt({ hash, timeout: 120_000 })));
    for (const r of receipts) expect(r.status).toBe('success');
    const txs = await Promise.all(gnosisTxs.map((hash) => gnosisPub.getTransaction({ hash })));
    const topUpTxs = txs.filter((t) => t.to && getAddress(t.to) === getAddress(POSTAGE_STAMP));
    const approveTxs = txs.filter((t) => t.to && getAddress(t.to) === getAddress(XBZZ));
    expect(topUpTxs, 'exactly one top-up was sent').toHaveLength(1);
    // One approval when the allowance was short, plus one more per price move (each approves the new price).
    expect(approveTxs.length, 'approvals').toBeLessThanOrEqual(1 + requotes.length);
    const call = decodeFunctionData({ abi: postageAbi, data: topUpTxs[0]!.input });
    expect(call.functionName).toBe('topUp');
    const [paidBatch, perChunk] = call.args as [Hex, bigint];
    expect(paidBatch.toLowerCase()).toBe(BATCH);
    expect(rabdiTxs, 'one Arkiv extension').toHaveLength(1);
    const rabdiReceipt = await rabdiPub.waitForTransactionReceipt({ hash: rabdiTxs[0]!, timeout: 120_000 });
    expect(rabdiReceipt.status).toBe('success');

    // Then the state, read until every public node behind the RPC has caught up with both receipts.
    let after = await readChains(treasury);
    await expect
      .poll(
        async () => {
          after = await readChains(treasury);
          return (
            after.batch.normalisedBalance !== before.batch.normalisedBalance &&
            after.expiresAt !== before.expiresAt &&
            after.xbzz !== before.xbzz
          );
        },
        { timeout: 120_000, intervals: [5_000] },
      )
      .toBe(true);

    // Gnosis: the batch's balance rose by exactly what was paid per chunk, and its TTL went up.
    expect(after.batch.normalisedBalance).toBeGreaterThan(before.batch.normalisedBalance);
    expect(after.batch.normalisedBalance - before.batch.normalisedBalance).toBe(perChunk);
    expect(after.ttl).toBeGreaterThan(before.ttl);
    const ttlGain = Number(after.ttl - before.ttl);
    // About DAYS days, less the minutes this run took (and any price move, which shows in `price`).
    expect(ttlGain, `TTL gain ${ttlGain} s`).toBeGreaterThan((DAYS - 1) * DAY);
    // Rabdi: the record's expiry block rose by the days, on top of its own expiry.
    expect(after.expiresAt).toBeGreaterThan(before.expiresAt);
    expect(after.expiresAt - before.expiresAt).toBe(blocksForDays(DAYS));

    // Spend, from the treasury's balances.
    const spent = { xbzz: before.xbzz - after.xbzz, xdai: before.xdai - after.xdai, tglm: before.tglm - after.tglm };
    expect(spent.xbzz).toBe(perChunk * 2n ** BigInt(DEPTH));
    expect(spent.xbzz).toBeLessThanOrEqual(CAP_XBZZ);
    expect(spent.xdai).toBeLessThanOrEqual(CAP_XDAI);
    expect(spent.tglm).toBeLessThanOrEqual(CAP_TGLM);

    // The dialog said so too, and the page re-read check E from the chains after it closed.
    expect(uiDone, doneText).toBe(true);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('[data-check="E"] [data-status]')).toHaveAttribute('data-status', 'pass');
    const eAfter = redact((await page.locator('[data-check="E"]').textContent()) ?? '');

    const summary = {
      at: new Date().toISOString(),
      app: `${APP_URL}#/c/${ENTITY}`,
      days: DAYS,
      treasury,
      gnosis: {
        batchId: BATCH,
        approveTxs: approveTxs.map((t) => t.hash),
        topUpTx: topUpTxs[0]!.hash,
        perChunk: String(perChunk),
        lastPrice: { before: String(before.price), after: String(after.price) },
        normalisedBalance: { before: String(before.batch.normalisedBalance), after: String(after.batch.normalisedBalance) },
        ttlSeconds: { before: String(before.ttl), after: String(after.ttl), gain: ttlGain },
        paidUntil: { before: before.batchEndsAt.toISOString(), after: after.batchEndsAt.toISOString() },
      },
      rabdi: {
        entityKey: ENTITY,
        extendTx: rabdiTxs[0]!,
        expiresAtBlock: { before: String(before.expiresAt), after: String(after.expiresAt) },
        currentBlock: String(after.currentBlock),
        blockSeconds: after.blockSeconds,
        until: { before: before.entityEndsAt.toISOString(), after: after.entityEndsAt.toISOString() },
      },
      spent: { xbzz: formatUnits(spent.xbzz, 16), xdai: formatEther(spent.xdai), tglm: formatEther(spent.tglm) },
      ui: { quote: quoteText, requotes, between, done: doneText, checkEBefore: eBefore, checkEAfter: eAfter },
      pageErrors,
    };
    const l = readLedger();
    l.spentXbzz = String(BigInt(l.spentXbzz) + spent.xbzz);
    l.runs.push(summary);
    writeLedger(l);
    console.log('P4 LIVE', JSON.stringify(summary));
    writeFileSync(test.info().outputPath('p4-live-summary.json'), JSON.stringify(summary, null, 2));
    test.info().annotations.push({ type: 'p4 live', description: JSON.stringify(summary) });
  });
});
