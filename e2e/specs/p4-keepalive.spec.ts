import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  sha256,
  toFunctionSelector,
  type Hex,
} from 'viem';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { canonicalUrl, encodeEvidence } from '../../packages/evidence/src/index';
import {
  BUCKET_DEPTH,
  FREE_BATCH_ID,
  LOCAL,
  POSTAGE_STAMP,
  XBZZ,
  arkivPublic,
  arkivWallet,
  batchTtlSeconds,
  blocksForDays,
  costFor,
  writeConfirmation,
} from '../../packages/net/src/index';
import { fundWallet } from '../fixtures/fund';
import {
  KEEPALIVE_WALLET_ADDRESS,
  KEEPALIVE_WALLET_KEY,
  OTHER_WALLET_ADDRESS,
  OTHER_WALLET_KEY,
} from '../fixtures/keys';
import { allowLocalArkiv } from '../fixtures/localCors';
import { installMockWallet } from '../fixtures/mockWallet';
import { NOTICE_HOST, Rig, record, requestBytes, signEvidence, type Published } from '../fixtures/verifyRig';

// Keep-alive and offline verification in the web app (apps/web on :5173), against the REAL local
// devnet (Arkiv :8545, Bee :1633/:1643, Gnosis fork :9545, notice fixture :443). Fixtures are built
// in beforeAll like p3-verify: witness-signed captures (public devnet witness key), a real batch
// bought on the Gnosis fork, chunks uploaded to Bee, entities on Arkiv. MetaMask is the only
// simulated actor (a mock wallet with a real key); every number asserted about the chains is read
// from the chains, not from the page.
//
// NONCE SAFETY: other specs use the same devnet at the same time with DEV_PRIVATE_KEY and the
// faucet key. This spec sends from its OWN wallets only (Hardhat #7 and #8), and its few funding
// transactions take a fresh pending nonce and retry (fixtures/fund.ts).

const APP = 'http://localhost:5173';
test.use({ channel: 'chromium', colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });

const MNEMONIC = 'test test test test test test test test test test test junk';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "4 Nov 2026": written independently of the app. */
function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const DAY = 86_400;
const bzz = (n: number) => BigInt(Math.round(n * 1e16));

const gnosisChain = { ...gnosis, rpcUrls: { default: { http: [LOCAL.gnosis.rpcUrl] } } };
const gnosisPub = createPublicClient({ chain: gnosisChain, transport: http(LOCAL.gnosis.rpcUrl) });
const arkiv = arkivPublic(LOCAL);

/** Seconds of storage the batch has left, from the chain. */
const swarmSeconds = async (batchId: Hex) => Number((await batchTtlSeconds(gnosisPub, batchId))!);
/** The entity's expiry block, from the chain. */
const arkivBlock = async (key: Hex) => (await arkiv.getEntity(key)).$expiresAt;
/** When the entity ends, in ms, from the chain. */
async function arkivEndsAt(key: Hex): Promise<number> {
  const [e, t] = await Promise.all([arkiv.getEntity(key), arkiv.getBlockTiming()]);
  return Date.now() + Number(e.$expiresAt - t.currentBlock) * t.blockDuration * 1000;
}
const xbzzOf = (a: Hex) => gnosisPub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const nonceOn = (rpc: string, a: Hex) => createPublicClient({ transport: http(rpc) }).getTransactionCount({ address: a });
const gnosisNonce = (a: Hex) => nonceOn(LOCAL.gnosis.rpcUrl, a);
const arkivNonce = (a: Hex) => nonceOn(LOCAL.arkiv.rpcUrl, a);

let rig: Rig;
let sample: Published;

test.beforeAll(async () => {
  test.setTimeout(420_000);
  // The wallets are Hardhat #7 and #8 of the public mnemonic.
  expect(privateKeyToAccount(KEEPALIVE_WALLET_KEY).address).toBe(mnemonicToAccount(MNEMONIC, { addressIndex: 7 }).address);
  expect(privateKeyToAccount(OTHER_WALLET_KEY).address).toBe(mnemonicToAccount(MNEMONIC, { addressIndex: 8 }).address);
  await fundWallet(KEEPALIVE_WALLET_ADDRESS, bzz(4));
  await fundWallet(OTHER_WALLET_ADDRESS, bzz(2));
  // One real batch (10 days) bought by wallet #7; every capture below is stored under it.
  rig = await Rig.create({ payerKey: KEEPALIVE_WALLET_KEY, writerKey: KEEPALIVE_WALLET_KEY });
  sample = await rig.publish();
});

test.beforeEach(async ({ page }) => {
  await allowLocalArkiv(page);
});
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const check = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => page.locator(`[data-check="${id}"]`);
const status = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => check(page, id).locator('[data-status]');
const verdict = (page: Page): Locator => page.locator('[data-verdict]');
const fileInput = (page: Page, name: string): Locator => page.getByLabel(name, { exact: true });
const file = (name: string, bytes: Uint8Array, mimeType = 'application/octet-stream') => ({ name, mimeType, buffer: Buffer.from(bytes) });

async function withWallet(page: Page, key: Hex = KEEPALIVE_WALLET_KEY) {
  return installMockWallet(page, {
    privateKey: key,
    rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
    chainId: 1337,
  });
}
/** Makes the mock wallet refuse the next matching MetaMask prompt (see fixtures/mockWallet.ts). */
const reject = (page: Page, what: true | string | { method?: string; skip?: number }) =>
  page.evaluate((w) => ((window as unknown as { __rejectNext: unknown }).__rejectNext = w), what);

/** Opens the capture page, waits for A to E to settle, opens the dialog and waits for the price. */
async function openDialog(page: Page, key: Hex, subject = 'capture'): Promise<Locator> {
  await page.goto(`${APP}/#/c/${key}`);
  await page.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: `Keep this ${subject} available` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Start: step 1 of / })).toBeEnabled({ timeout: 30_000 });
  return dialog;
}

const start = (dialog: Locator) => dialog.getByRole('button', { name: /^Start: step 1 of / });

/** Runs a whole keep-alive for `days` through the dialog (the mock wallet confirms everything). */
async function runAll(dialog: Locator): Promise<void> {
  await start(dialog).click();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Continue: step 2 of 2' }).click();
  await expect(dialog.getByText(/^Kept alive until \d+ \w+ \d{4}\.$/)).toBeVisible({ timeout: 60_000 });
}

async function setAllowance(key: Hex, amount: bigint): Promise<void> {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: gnosisChain, transport: http(LOCAL.gnosis.rpcUrl) });
  await gnosisPub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ address: XBZZ, abi: erc20Abi, functionName: 'approve', args: [POSTAGE_STAMP, amount] }),
  });
}

/**
 * Wraps `window.ethereum.request` in the page so a test can make the wallet's chain reads misbehave:
 * the price rise after the n-th transaction was sent (a slow MetaMask prompt), or every receipt read
 * fail once a transaction has been sent (the wait that "never came back"). The mock wallet itself is
 * untouched. Set the knobs with `setTweaks`.
 */
async function tweakProvider(page: Page): Promise<void> {
  await page.evaluate(
    ({ stamp, lastPrice }) => {
      const w = window as unknown as { ethereum: any; __tweaks: any };
      const p = w.ethereum;
      if (p.__tweaked) return;
      p.__tweaked = true;
      w.__tweaks = { sends: 0, priceMul: 1, priceAfterSends: 0, failReceipts: false };
      const orig = p.request.bind(p);
      p.request = async (a: any) => {
        const t = w.__tweaks;
        if (a.method === 'eth_getTransactionReceipt' && t.failReceipts && t.sends > 0) {
          throw Object.assign(new Error('simulated RPC failure while waiting for the receipt'), { code: -32602 });
        }
        const r = await orig(a);
        if (a.method === 'eth_sendTransaction') t.sends++;
        if (a.method === 'eth_call' && t.priceMul > 1 && t.sends >= t.priceAfterSends) {
          const c = (a.params || [])[0] || {};
          if (String(c.to).toLowerCase() === stamp && String(c.data ?? c.input ?? '').startsWith(lastPrice)) {
            return '0x' + (BigInt(r) * BigInt(t.priceMul)).toString(16).padStart(64, '0');
          }
        }
        return r;
      };
    },
    { stamp: POSTAGE_STAMP.toLowerCase(), lastPrice: toFunctionSelector('lastPrice()') },
  );
}
const setTweaks = (page: Page, t: { sends?: number; priceMul?: number; priceAfterSends?: number; failReceipts?: boolean }) =>
  page.evaluate((x) => Object.assign((window as unknown as { __tweaks: object }).__tweaks, x), t);

/** Buys a MUTABLE batch (Recall's own buyBatch never does): its owner could change its size later. */
async function buyMutableBatch(): Promise<Hex> {
  const account = privateKeyToAccount(KEEPALIVE_WALLET_KEY);
  const wallet = createWalletClient({ account, chain: gnosisChain, transport: http(LOCAL.gnosis.rpcUrl) });
  const abi = parseAbi([
    'function createBatch(address _owner, uint256 _initialBalancePerChunk, uint8 _depth, uint8 _bucketDepth, bytes32 _nonce, bool _immutable) returns (bytes32)',
    'function lastPrice() view returns (uint64)',
    'event BatchCreated(bytes32 indexed batchId, uint256 totalAmount, uint256 normalisedBalance, address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag)',
  ]);
  const price = await gnosisPub.readContract({ address: POSTAGE_STAMP, abi, functionName: 'lastPrice' });
  const perChunk = BigInt(price) * 17_280n * 2n + 1n;
  await gnosisPub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ address: XBZZ, abi: erc20Abi, functionName: 'approve', args: [POSTAGE_STAMP, perChunk * 2n ** 17n] }),
  });
  const receipt = await gnosisPub.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      address: POSTAGE_STAMP, abi, functionName: 'createBatch',
      args: [account.address, perChunk, 17, BUCKET_DEPTH, generatePrivateKey(), false],
    }),
  });
  return receipt.logs.find((l) => l.address.toLowerCase() === POSTAGE_STAMP.toLowerCase())!.topics[1] as Hex;
}

test('@p4 keepalive increases the batch TTL and the Arkiv expiry', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  await page.goto(`${APP}/#/c/${c.entityKey}`);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'pass');
  const eBefore = (await check(page, 'E').textContent()) ?? '';

  // Read both from the chains first.
  const [ttlBefore, blockBefore] = [await swarmSeconds(c.batchId), await arkivBlock(c.entityKey)];

  await page.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keep this capture available' });
  await expect(dialog).toBeVisible();
  // Exact copy of the design brief (4.6).
  await expect(dialog.getByRole('heading', { level: 2, name: 'Keep this capture available' })).toBeVisible();
  await expect(dialog).toContainText('Anyone can pay to keep evidence online. This extends the Swarm storage and the Arkiv record.');
  await expect(dialog.getByRole('radio', { name: '7 days' })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: '30 days' })).toBeVisible();
  await expect(dialog.locator('.steps-list li')).toHaveText([
    /^Top up storage \(Gnosis\)/,
    /^Extend record \(Arkiv local\)/,
  ]);
  await expect(dialog).toContainText('Step 1 of 2');
  await expect(dialog).toContainText('MetaMask may ask twice: approve xBZZ, then top up.');

  // The price: Storage: <x> xBZZ on Gnosis, rounded UP from costFor of this batch's depth (17).
  await expect(start(dialog)).toBeEnabled({ timeout: 30_000 });
  const quote = dialog.locator('.ka-quote');
  await expect(quote).toContainText(/Storage: [\d.]+ xBZZ on Gnosis · network fees ~[\d.]+ xDAI · Arkiv fee shown in MetaMask/);
  const shown = Number(/Storage: ([\d.]+) xBZZ/.exec((await quote.textContent()) ?? '')![1]);
  const exact = Number(formatUnits(await costFor(gnosisPub, 17, 7), 16));
  expect(shown).toBeGreaterThanOrEqual(exact);
  expect(shown).toBeLessThan(exact * 1.01);
  // New end dates are the chains' ends plus the days (from "now", so compare by day).
  // The batch the record names is shown (short form) and was read from Gnosis: owner and depth 17.
  await expect(quote).toContainText(`Storage batch: ${c.batchId.slice(0, 6)}…${c.batchId.slice(-4)} · depth 17`);
  const swarmNew = day(Date.now() + (ttlBefore + 7 * DAY) * 1000);
  await expect(quote).toContainText(`New end dates: Swarm ${swarmNew} · Arkiv `);
  const timing = await arkiv.getBlockTiming();
  const arkivNew = day(Date.now() + Number(blockBefore + blocksForDays(7) - timing.currentBlock) * timing.blockDuration * 1000);
  await expect(quote).toContainText(`Arkiv ${arkivNew}`);

  const xbzzBefore = await xbzzOf(KEEPALIVE_WALLET_ADDRESS);
  await runAll(dialog);

  // The chains, not the page, say it worked.
  const ttlAfter = await swarmSeconds(c.batchId);
  expect(ttlAfter - ttlBefore).toBeGreaterThan(7 * DAY - 3600);
  expect(ttlAfter - ttlBefore).toBeLessThan(7 * DAY + 60);
  const blockAfter = await arkivBlock(c.entityKey);
  expect(blockAfter - blockBefore).toBe(blocksForDays(7)); // 7 days on top of the current expiry
  const spent = xbzzBefore - (await xbzzOf(KEEPALIVE_WALLET_ADDRESS));
  expect(spent).toBeGreaterThan(0n);
  expect(Number(formatUnits(spent, 16))).toBeLessThanOrEqual(shown);

  // Success copy: the earlier of the two end dates, both re-read.
  const swarmEnd = Date.now() + ttlAfter * 1000;
  const arkivEnd = await arkivEndsAt(c.entityKey);
  await expect(dialog.getByText(`Kept alive until ${day(Math.min(swarmEnd, arkivEnd))}.`)).toBeVisible();
  await expect(dialog).toContainText(`Swarm storage until ${day(swarmEnd)} · Arkiv record until ${day(arkivEnd)}.`);
  await expect(dialog.locator('.steps-list li.step-done')).toHaveCount(2);

  // [Done] closes the dialog and gives the focus back to the button that opened it.
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Keep alive…' })).toBeFocused();

  // Check E was read again from the chains: the dates changed, and nothing optimistic was drawn.
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'pass');
  await expect(check(page, 'E')).toContainText(`Evidence paid on Swarm until ${day(swarmEnd)} · record on Arkiv until ${day(arkivEnd)}.`);
  expect((await check(page, 'E').textContent()) ?? '').not.toBe(eBefore);
});

test('@p4 keepalive a different wallet can keep alive (permissionless)', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish(); // owned and indexed by wallet #7
  await withWallet(page, OTHER_WALLET_KEY);
  await setAllowance(OTHER_WALLET_KEY, 0n); // an earlier run may have left an allowance; start from none so the approval is needed
  const [ttlBefore, blockBefore] = [await swarmSeconds(c.batchId), await arkivBlock(c.entityKey)];
  const [gnosisN, arkivN] = [await gnosisNonce(OTHER_WALLET_ADDRESS), await arkivNonce(OTHER_WALLET_ADDRESS)];
  const mainNonces = [await gnosisNonce(KEEPALIVE_WALLET_ADDRESS), await arkivNonce(KEEPALIVE_WALLET_ADDRESS)];
  expect((await arkiv.getEntity(c.entityKey)).$owner.toLowerCase()).toBe(KEEPALIVE_WALLET_ADDRESS.toLowerCase());

  const dialog = await openDialog(page, c.entityKey);
  await dialog.getByRole('radio', { name: '30 days' }).check();
  await expect(dialog.locator('.ka-quote')).toContainText(`New end dates: Swarm ${day(Date.now() + (ttlBefore + 30 * DAY) * 1000)} · Arkiv `);
  await expect(start(dialog)).toBeEnabled();
  await runAll(dialog);

  expect((await swarmSeconds(c.batchId)) - ttlBefore).toBeGreaterThan(30 * DAY - 3600);
  expect((await arkivBlock(c.entityKey)) - blockBefore).toBe(blocksForDays(30));
  // The transactions came from wallet #8 (approve + top-up on Gnosis, one extension on Arkiv), not from the owner.
  expect(await gnosisNonce(OTHER_WALLET_ADDRESS)).toBe(gnosisN + 2);
  expect(await arkivNonce(OTHER_WALLET_ADDRESS)).toBe(arkivN + 1);
  expect([await gnosisNonce(KEEPALIVE_WALLET_ADDRESS), await arkivNonce(KEEPALIVE_WALLET_ADDRESS)]).toEqual(mainNonces);
});

test('@p4 keepalive a rejection at step 1 charges nothing, then a retry succeeds', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  await setAllowance(KEEPALIVE_WALLET_KEY, 0n); // so the first prompt is the approval
  const dialog = await openDialog(page, c.entityKey);

  const [ttlBefore, bzzBefore, nonceBefore] = [
    await swarmSeconds(c.batchId),
    await xbzzOf(KEEPALIVE_WALLET_ADDRESS),
    await gnosisNonce(KEEPALIVE_WALLET_ADDRESS),
  ];
  await reject(page, 'eth_sendTransaction');
  await start(dialog).click();

  await expect(dialog.getByText('Step 1 cancelled in MetaMask. Nothing more was charged.')).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole('alert')).toContainText('Step 1 cancelled in MetaMask');
  await expect(dialog.locator('.steps-list li.step-failed')).toHaveCount(1);
  // Nothing was sent or paid, and the chain agrees.
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(nonceBefore);
  expect(await xbzzOf(KEEPALIVE_WALLET_ADDRESS)).toBe(bzzBefore);
  expect(Math.abs((await swarmSeconds(c.batchId)) - ttlBefore)).toBeLessThan(600);

  // Try again goes through.
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  expect((await swarmSeconds(c.batchId)) - ttlBefore).toBeGreaterThan(7 * DAY - 3600);
  expect(await xbzzOf(KEEPALIVE_WALLET_ADDRESS)).toBeLessThan(bzzBefore);
});

test('@p4 keepalive rejecting the top-up after the approval says the approval stays, then the retry needs one prompt', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  await setAllowance(KEEPALIVE_WALLET_KEY, 0n);
  const dialog = await openDialog(page, c.entityKey);
  const [ttlBefore, bzzBefore] = [await swarmSeconds(c.batchId), await xbzzOf(KEEPALIVE_WALLET_ADDRESS)];

  await reject(page, { method: 'eth_sendTransaction', skip: 1 }); // the approval goes through, the top-up is refused
  await start(dialog).click();
  await expect(dialog.getByText('Step 1 cancelled in MetaMask. Nothing more was charged.')).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('The xBZZ approval was already confirmed and stays; it moves no funds.');
  expect(await xbzzOf(KEEPALIVE_WALLET_ADDRESS)).toBe(bzzBefore); // an approval moves no xBZZ
  expect(Math.abs((await swarmSeconds(c.batchId)) - ttlBefore)).toBeLessThan(600);

  // The allowance is in place now, so the retry is one wallet prompt (the top-up), not two.
  const n = await gnosisNonce(KEEPALIVE_WALLET_ADDRESS);
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(n + 1);
  expect((await swarmSeconds(c.batchId)) - ttlBefore).toBeGreaterThan(7 * DAY - 3600);
});

test('@p4 keepalive a rejection at step 2 keeps the storage extension and Retry step 2 finishes', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  const dialog = await openDialog(page, c.entityKey);
  const [ttlBefore, blockBefore] = [await swarmSeconds(c.batchId), await arkivBlock(c.entityKey)];

  await start(dialog).click();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  // Step 1 is confirmed by a re-read, and the page says which date.
  const swarmEnd = Date.now() + (await swarmSeconds(c.batchId)) * 1000;
  await expect(dialog).toContainText(`Storage extended to ${day(swarmEnd)}.`);
  await expect(dialog.locator('.steps-list li.step-done')).toHaveCount(1);

  await reject(page, 'eth_sendTransaction');
  await dialog.getByRole('button', { name: 'Continue: step 2 of 2' }).click();
  const partial = dialog.getByText(`Storage extended to ${day(swarmEnd)}. The record wasn't extended yet.`);
  await expect(partial).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('Step 2 cancelled in MetaMask. Nothing more was charged.');
  expect((await swarmSeconds(c.batchId)) - ttlBefore).toBeGreaterThan(7 * DAY - 3600);
  expect(await arkivBlock(c.entityKey)).toBe(blockBefore); // the record was not extended

  // Closing and reopening the dialog keeps the confirmed step 1 and the partial state: step 2 can run alone.
  await expect(dialog.getByRole('button', { name: 'Retry step 2' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Keep alive…' }).click();
  await expect(partial).toBeVisible();
  await expect(dialog.locator('.steps-list li.step-done')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Retry step 2' }).click();
  await expect(dialog.getByText(/^Kept alive until \d+ \w+ \d{4}\.$/)).toBeVisible({ timeout: 60_000 });
  expect((await arkivBlock(c.entityKey)) - blockBefore).toBe(blocksForDays(7));
  // The storage was not paid twice.
  expect((await swarmSeconds(c.batchId)) - ttlBefore).toBeLessThan(7 * DAY + 60);
});

test('@p4 keepalive not enough xBZZ shows what is needed and sends nothing', async ({ page }) => {
  test.setTimeout(120_000);
  const poor = generatePrivateKey(); // a wallet that holds no xBZZ and sends nothing
  await withWallet(page, poor);
  const dialog = await openDialog(page, sample.entityKey);
  const poorAddress = privateKeyToAccount(poor).address;
  const exact = Number(formatUnits(await costFor(gnosisPub, 17, 7), 16));
  await start(dialog).click();
  const copy = dialog.getByText(/^Not enough xBZZ\. You need [\d.]+ xBZZ on Gnosis\.$/);
  await expect(copy).toBeVisible({ timeout: 60_000 });
  const need = Number(/need ([\d.]+) xBZZ/.exec((await copy.textContent()) ?? '')![1]);
  expect(need).toBeGreaterThanOrEqual(exact);
  expect(need).toBeLessThan(exact * 1.01);
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  expect(await gnosisNonce(poorAddress)).toBe(0); // nothing was sent
  expect(await xbzzOf(poorAddress)).toBe(0n);
});

test('@p4 keepalive a confirmation tops up its parent batch and extends both records', async ({ page }) => {
  test.setTimeout(300_000);
  const parent = await rig.publish();
  // The same page recorded again, signed again: a confirmation that the bytes did not change.
  const target = new URL(parent.url).pathname + new URL(parent.url).search;
  const rec = await record(target);
  const again = await signEvidence(rec, { capturedUrl: canonicalUrl(`https://${NOTICE_HOST}${target}`) });
  const writer = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(KEEPALIVE_WALLET_KEY));
  const { entityKey: confirmationKey } = await writeConfirmation(writer, {
    captureKey: parent.entityKey,
    urlHash: parent.urlHash,
    bodySha256: sha256(parent.body),
    witness: again.signer,
    signedAt: again.signedAt,
    evidence: encodeEvidence(again.evidence),
  });
  for (let i = 0; i < 40; i++) {
    try {
      await arkiv.getEntity(confirmationKey);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  await withWallet(page);
  const [ttlBefore, parentBlock, ownBlock] = [await swarmSeconds(parent.batchId), await arkivBlock(parent.entityKey), await arkivBlock(confirmationKey)];
  const arkivN = await arkivNonce(KEEPALIVE_WALLET_ADDRESS);

  await page.goto(`${APP}/#/c/${confirmationKey}`);
  await expect(page.getByRole('heading', { level: 1, name: /Confirmation/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /capture it confirms/i })).toHaveAttribute('href', `#/c/${parent.entityKey}`);
  // The timeline's own rules count it under the capture it names.
  await expect(page.getByText(/^Still unchanged on /)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keep this confirmation available' });
  await expect(start(dialog)).toBeEnabled({ timeout: 30_000 });
  await runAll(dialog);

  // The PARENT's batch got the top-up, and both records were extended, in ONE Arkiv transaction.
  expect((await swarmSeconds(parent.batchId)) - ttlBefore).toBeGreaterThan(7 * DAY - 3600);
  expect((await arkivBlock(parent.entityKey)) - parentBlock).toBe(blocksForDays(7));
  expect((await arkivBlock(confirmationKey)) - ownBlock).toBe(blocksForDays(7));
  expect(await arkivNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(arkivN + 1);
});

test('@p4 keepalive a capture on free gateway storage gets step 2 only', async ({ page }) => {
  test.setTimeout(180_000);
  const free = await rig.publish({ entity: { batchId: FREE_BATCH_ID } });
  await withWallet(page);
  await page.goto(`${APP}/#/c/${free.entityKey}`);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  // Never "expired" for storage that has no batch, and never green.
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'E')).toContainText("This capture used the gateway's free storage, which has no known end date.");
  await expect(check(page, 'E')).not.toContainText('expired');

  await page.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keep this capture available' });
  await expect(dialog).toContainText("This capture used the gateway's free storage, which can't be extended.");
  await expect(dialog.locator('.steps-list li')).toHaveCount(1);
  await expect(dialog.locator('.steps-list li')).toContainText('Extend record (Arkiv local)');
  await expect(dialog).not.toContainText('Top up storage');
  await expect(dialog).not.toContainText('xBZZ');
  const blockBefore = await arkivBlock(free.entityKey);
  const gnosisN = await gnosisNonce(KEEPALIVE_WALLET_ADDRESS);
  await expect(dialog.getByRole('button', { name: 'Start: step 1 of 1' })).toBeEnabled({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Start: step 1 of 1' }).click();
  // Only the record was extended, and the page says only that.
  await expect(dialog.getByText(/^Record kept until \d+ \w+ \d{4}\.$/)).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText(/Kept alive until/)).toHaveCount(0);
  await expect(dialog).not.toContainText('only the storage');
  expect((await arkivBlock(free.entityKey)) - blockBefore).toBe(blocksForDays(7));
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(gnosisN); // nothing on Gnosis
});

test('@p4 keepalive a record that names a batch that does not exist offers step 2 only', async ({ page }) => {
  test.setTimeout(180_000);
  // A record's batch id is only a claim: nothing is priced or paid for a batch that is not on Gnosis.
  const crafted = await rig.publish({ entity: { batchId: `0x${randomBytes(32).toString('hex')}` } });
  await withWallet(page);
  await page.goto(`${APP}/#/c/${crafted.entityKey}`);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await page.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keep this capture available' });
  const message = "This capture's storage batch wasn't found on Gnosis. Storage can't be extended.";
  await expect(dialog.getByText(message)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.steps-list li')).toHaveCount(1);
  await expect(dialog.locator('.steps-list li')).toContainText('Extend record (Arkiv local)');
  await expect(dialog).not.toContainText('Top up storage');
  await expect(dialog).not.toContainText('xBZZ');
  await expect(dialog.getByText(/^Storage batch:/)).toHaveCount(0);

  const blockBefore = await arkivBlock(crafted.entityKey);
  const gnosisN = await gnosisNonce(KEEPALIVE_WALLET_ADDRESS);
  await expect(dialog.getByRole('button', { name: 'Start: step 1 of 1' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Start: step 1 of 1' }).click();
  await expect(dialog.getByText(/^Record kept until \d+ \w+ \d{4}\.$/)).toBeVisible({ timeout: 60_000 });
  expect((await arkivBlock(crafted.entityKey)) - blockBefore).toBe(blocksForDays(7));
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(gnosisN); // nothing was sent on Gnosis
});

test('@p4 keepalive a mutable batch is refused: step 2 only', async ({ page }) => {
  test.setTimeout(180_000);
  // Its owner could raise its depth (and so the price) between the preview and the payment.
  const mutable = await rig.publish({ entity: { batchId: await buyMutableBatch() } });
  await withWallet(page);
  await page.goto(`${APP}/#/c/${mutable.entityKey}`);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await page.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keep this capture available' });
  await expect(dialog.getByText("This capture's storage batch isn't one Recall created. Storage can't be extended.")).toBeVisible({ timeout: 30_000 });
  await expect(dialog.locator('.steps-list li')).toHaveCount(1);
  await expect(dialog).not.toContainText('Top up storage');
  await expect(dialog.getByText(/^Storage batch:/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Start: step 1 of 1' })).toBeEnabled();
});

test('@p4 keepalive a price above the preview sends nothing, even with an allowance already in place', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  await setAllowance(KEEPALIVE_WALLET_KEY, bzz(1)); // plenty: no approval step stands in the way
  const dialog = await openDialog(page, c.entityKey);
  await tweakProvider(page);
  await setTweaks(page, { priceMul: 3 }); // the wallet's reads see a tripled price from the start
  const [n0, b0, t0] = [await gnosisNonce(KEEPALIVE_WALLET_ADDRESS), await xbzzOf(KEEPALIVE_WALLET_ADDRESS), await swarmSeconds(c.batchId)];
  // Price reads are slowed from here, so the re-pricing that follows the change can be seen.
  const priceSelector = toFunctionSelector('lastPrice()').slice(2);
  let slowPrice = true;
  await page.route(/localhost:9545/, async (route) => {
    if (slowPrice && (route.request().postData() ?? '').includes(priceSelector)) await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });

  await start(dialog).click();
  await expect(dialog.getByText('The storage price changed.')).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toContainText('nothing was sent for the top-up');
  // No approval was needed here (the allowance was in place), so no approval note.
  await expect(dialog).not.toContainText('The xBZZ approval was already confirmed');
  // While the new price is read, the dialog says why it is waiting.
  await expect(dialog.getByText('Getting a new price…')).toBeVisible({ timeout: 10_000 });
  slowPrice = false;
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(n0);
  expect(await xbzzOf(KEEPALIVE_WALLET_ADDRESS)).toBe(b0);
  expect(await swarmSeconds(c.batchId)).toBeLessThanOrEqual(t0);

  // The dialog priced it again; with the price back to what was shown, it goes through.
  await setTweaks(page, { priceMul: 1 });
  await expect(start(dialog)).toBeEnabled({ timeout: 30_000 });
  await start(dialog).click();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  expect((await swarmSeconds(c.batchId)) - t0).toBeGreaterThan(7 * DAY - 3600);
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(n0 + 1);
});

test('@p4 keepalive a price rise while the approval is mined is caught before the top-up', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  await setAllowance(KEEPALIVE_WALLET_KEY, 0n); // so the first prompt is the approval
  const dialog = await openDialog(page, c.entityKey);
  await tweakProvider(page);
  await setTweaks(page, { priceMul: 3, priceAfterSends: 1, sends: 0 }); // the price moves after the approval was sent
  const [n0, b0, t0] = [await gnosisNonce(KEEPALIVE_WALLET_ADDRESS), await xbzzOf(KEEPALIVE_WALLET_ADDRESS), await swarmSeconds(c.batchId)];

  await start(dialog).click();
  await expect(dialog.getByText('The storage price changed.')).toBeVisible({ timeout: 90_000 });
  // The approval was mined before the price moved: the dialog says it stays and moves no funds.
  await expect(dialog).toContainText('The xBZZ approval was already confirmed and stays; it moves no funds.');
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(n0 + 1); // the approval, and nothing else
  expect(await xbzzOf(KEEPALIVE_WALLET_ADDRESS)).toBe(b0); // an approval moves no xBZZ
  expect(await swarmSeconds(c.batchId)).toBeLessThanOrEqual(t0);
});

test('@p4 keepalive a top-up whose receipt wait failed is not paid twice on retry', async ({ page }) => {
  test.setTimeout(300_000);
  const c = await rig.publish();
  await withWallet(page);
  await setAllowance(KEEPALIVE_WALLET_KEY, bzz(1)); // the top-up is the only transaction
  const dialog = await openDialog(page, c.entityKey);
  await tweakProvider(page);
  await setTweaks(page, { failReceipts: true, sends: 0 });
  const [n0, t0] = [await gnosisNonce(KEEPALIVE_WALLET_ADDRESS), await swarmSeconds(c.batchId)];

  await start(dialog).click();
  // It was sent but the wait for it failed: not "failed", and not "nothing was charged".
  await expect(dialog.getByText('Step 1 may have gone through.')).toBeVisible({ timeout: 90_000 });
  await expect(dialog).toContainText('It was sent, so it may still go through');
  await expect(dialog).not.toContainText('Nothing more was charged');
  await setTweaks(page, { failReceipts: false });
  await expect.poll(() => gnosisNonce(KEEPALIVE_WALLET_ADDRESS), { timeout: 30_000 }).toBe(n0 + 1);

  // Try again asks the chain first, finds the top-up mined, and goes on to step 2 without paying again.
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(n0 + 1);
  const gained = (await swarmSeconds(c.batchId)) - t0;
  expect(gained).toBeGreaterThan(7 * DAY - 3600);
  expect(gained).toBeLessThan(7 * DAY + 600); // once, not twice
  await expect(dialog).toContainText('Storage extended to ');
});

test('@p4 keepalive a reload while the top-up is pending does not pay again', async ({ page }) => {
  test.setTimeout(300_000);
  const c = await rig.publish();
  await withWallet(page);
  await setAllowance(KEEPALIVE_WALLET_KEY, bzz(1)); // the top-up is the only transaction
  const dialog = await openDialog(page, c.entityKey);
  await tweakProvider(page);
  await setTweaks(page, { failReceipts: true, sends: 0 });
  const [n0, t0] = [await gnosisNonce(KEEPALIVE_WALLET_ADDRESS), await swarmSeconds(c.batchId)];
  const kept = () => page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('recall.keepalive.topup.')));

  await start(dialog).click();
  await expect(dialog.getByText('Step 1 may have gone through.')).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => gnosisNonce(KEEPALIVE_WALLET_ADDRESS), { timeout: 30_000 }).toBe(n0 + 1);
  expect(await kept()).toHaveLength(1);

  // The page is reloaded before the retry: the dialog starts over, but what was sent is remembered.
  await page.reload();
  const again = await openDialog(page, c.entityKey);
  await start(again).click();
  // It asks the chain first, finds the top-up mined, and goes on to step 2 without paying again.
  await expect(again.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(n0 + 1);
  const gained = (await swarmSeconds(c.batchId)) - t0;
  expect(gained).toBeGreaterThan(7 * DAY - 3600);
  expect(gained).toBeLessThan(7 * DAY + 600); // once, not twice
  expect(await kept()).toHaveLength(0); // a definite outcome: forgotten
});

test('@p4 keepalive an extension whose receipt wait failed is not sent twice on retry', async ({ page }) => {
  test.setTimeout(300_000);
  const c = await rig.publish();
  await withWallet(page);
  const dialog = await openDialog(page, c.entityKey);
  const blockBefore = await arkivBlock(c.entityKey);
  await start(dialog).click();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });

  await tweakProvider(page);
  await setTweaks(page, { failReceipts: true, sends: 0 });
  const n0 = await arkivNonce(KEEPALIVE_WALLET_ADDRESS);
  await dialog.getByRole('button', { name: 'Continue: step 2 of 2' }).click();
  await expect(dialog.getByText(/The record may have been extended too\.$/)).toBeVisible({ timeout: 90_000 });
  await setTweaks(page, { failReceipts: false });
  await expect.poll(() => arkivNonce(KEEPALIVE_WALLET_ADDRESS), { timeout: 30_000 }).toBe(n0 + 1);

  await dialog.getByRole('button', { name: 'Retry step 2' }).click();
  await expect(dialog.getByText(/^Kept alive until \d+ \w+ \d{4}\.$/)).toBeVisible({ timeout: 60_000 });
  expect(await arkivNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(n0 + 1); // one extension, not two
  expect((await arkivBlock(c.entityKey)) - blockBefore).toBe(blocksForDays(7));
});

test('@p4 keepalive a failed Gnosis price read does not block step 2', async ({ page }) => {
  test.setTimeout(180_000);
  const c = await rig.publish();
  await withWallet(page);
  await page.goto(`${APP}/#/c/${c.entityKey}`);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  // From here the page's own reads of Gnosis are rate-limited (the wallet's are not).
  await page.route(/localhost:9545/, (route) =>
    route.fulfill({ status: 429, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'Too Many Requests' }),
  );
  const blockBefore = await arkivBlock(c.entityKey);
  const gnosisN = await gnosisNonce(KEEPALIVE_WALLET_ADDRESS);
  await page.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keep this capture available' });
  await expect(dialog).toContainText("Couldn't read the storage price from Gnosis, so storage can't be extended right now. You can still extend the record.", { timeout: 30_000 });
  await expect(dialog.locator('.steps-list li')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Start: step 1 of 1' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Start: step 1 of 1' }).click();
  await expect(dialog.getByText(/^Record kept until \d+ \w+ \d{4}\.$/)).toBeVisible({ timeout: 60_000 });
  expect((await arkivBlock(c.entityKey)) - blockBefore).toBe(blocksForDays(7));
  expect(await gnosisNonce(KEEPALIVE_WALLET_ADDRESS)).toBe(gnosisN);
});

test('@p4 keepalive warns when the re-read shows no later storage date', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  // A stale node: the page's reads of the batch balance keep the first answer they got.
  const selector = toFunctionSelector('remainingBalance(bytes32)').slice(2);
  let first: string | undefined;
  await page.route(/localhost:9545/, async (route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes(selector) || body.trimStart().startsWith('[')) return route.continue();
    const id = (JSON.parse(body) as { id: number }).id;
    if (first === undefined) {
      const res = await route.fetch();
      first = ((await res.json()) as { result: string }).result;
      return route.fulfill({ response: res, json: { jsonrpc: '2.0', id, result: first }, headers: { ...res.headers(), 'access-control-allow-origin': '*' } });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, json: { jsonrpc: '2.0', id, result: first } });
  });
  const dialog = await openDialog(page, c.entityKey);
  const t0 = await swarmSeconds(c.batchId);
  await start(dialog).click();
  await expect(dialog.getByText("The top-up went through, but the storage end date hasn't moved yet.")).toBeVisible({ timeout: 90_000 });
  expect((await swarmSeconds(c.batchId)) - t0).toBeGreaterThan(7 * DAY - 3600); // it really did
  // Not a green "extended to": the warning is the page's honest reading, and step 2 is still on offer.
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible();
});

test('@p4 keepalive a confirmation that the timeline refuses gets neither "Still unchanged" nor Keep alive', async ({ page }) => {
  test.setTimeout(420_000);
  const parent = await rig.publish();
  const target = new URL(parent.url).pathname + new URL(parent.url).search;
  const url = canonicalUrl(`https://${NOTICE_HOST}${target}`);
  const writer = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(KEEPALIVE_WALLET_KEY));
  /** A page the fixture does not serve: the witness "saw" exactly these bytes at this address. */
  const html = (text: string) => {
    const body = new TextEncoder().encode(`<!doctype html><title>${text}</title><p>${text}</p>`);
    const head = new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
    return { sent: requestBytes(target), recv: new Uint8Array([...head, ...body]), body };
  };
  const confirm = async (rec: { sent: Uint8Array; recv: Uint8Array }, signedAt: bigint, bodySha: Hex) => {
    const signed = await signEvidence(rec, { capturedUrl: url, override: { signedAt, connTime: signedAt - 2n } });
    const { entityKey } = await writeConfirmation(writer, {
      captureKey: parent.entityKey,
      urlHash: parent.urlHash,
      bodySha256: bodySha,
      witness: signed.signer,
      signedAt,
      evidence: encodeEvidence(signed.evidence),
    });
    for (let i = 0; i < 40; i++) {
      try {
        await arkiv.getEntity(entityKey);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return entityKey;
  };
  const sameBytes = await record(target);

  // 1. Signed at the SAME second as the capture: the timeline needs it to be later.
  const equal = await confirm(sameBytes, parent.signedAt, sha256(parent.body));
  // 2. Different bytes than the capture it names.
  const otherRec = html('something else entirely');
  const different = await confirm(otherRec, parent.signedAt + 5n, sha256(otherRec.body));
  // 3. Same bytes, but dated AFTER a newer version of the page.
  const newerRec = html('a newer version');
  const newerSigned = await signEvidence(newerRec, { capturedUrl: url, override: { signedAt: parent.signedAt + 10n, connTime: parent.signedAt + 8n } });
  await rig.write({
    urlHash: parent.urlHash,
    bodySha256: sha256(newerRec.body),
    serverName: NOTICE_HOST,
    witness: newerSigned.signer,
    signedAt: newerSigned.signedAt,
    httpStatus: 200,
    batchId: rig.batchId,
    evidenceRef: await rig.upload(encodeEvidence(newerSigned.evidence)),
    canonicalUrl: url,
  });
  const late = await confirm(sameBytes, parent.signedAt + 20n, sha256(parent.body));

  await withWallet(page);
  for (const [key, reason] of [
    [equal, 'Dated before the capture it confirms'],
    [different, "Doesn't match the capture it confirms"],
    [late, 'Dated after a newer version'],
  ] as const) {
    await page.goto(`${APP}/#/c/${key}`);
    await expect(page.getByRole('heading', { level: 1, name: /Confirmation/ })).toBeVisible();
    await expect(page.getByText(`Not counted as a confirmation: ${reason}.`)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/Still unchanged on/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Keep alive…' })).toHaveCount(0);
  }

  // A confirmation whose capture is not on Arkiv gets a hint, not "checking…" for ever.
  const lostAt = parent.signedAt + 40n;
  const lostSigned = await signEvidence(sameBytes, { capturedUrl: url, override: { signedAt: lostAt, connTime: lostAt - 2n } });
  const lost = await writeConfirmation(writer, {
    captureKey: `0x${randomBytes(32).toString('hex')}`,
    urlHash: parent.urlHash,
    bodySha256: sha256(parent.body),
    witness: lostSigned.signer,
    signedAt: lostAt,
    evidence: encodeEvidence(lostSigned.evidence),
  });
  await page.goto(`${APP}/#/c/${lost.entityKey}`);
  await expect(page.getByText(/isn't on Arkiv \(it may have expired or never existed\)/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Checking this confirmation/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Keep alive…' })).toHaveCount(0);
});

test('@p4 keepalive is not offered for a capture that did not pass A to C', async ({ page }) => {
  test.setTimeout(120_000);
  const stranger = await rig.publish({ witnessKey: generatePrivateKey() }); // an unknown witness: C is only a warning
  await withWallet(page);
  await page.goto(`${APP}/#/c/${stranger.entityKey}`);
  await expect(status(page, 'C')).toHaveAttribute('data-status', 'warn');
  await expect(page.getByText('Keep-alive is offered only for captures whose checks A to C passed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep alive…' })).toHaveCount(0);
});

test('@p4 keepalive the dialog closes with Esc and returns focus; leaving mid-step asks first', async ({ page }) => {
  test.setTimeout(180_000);
  await withWallet(page);
  const dialog = await openDialog(page, sample.entityKey);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Keep alive…' })).toBeFocused();

  // Reopen and start; Esc while the wallet step is pending asks "Leave?" instead of closing.
  await page.getByRole('button', { name: 'Keep alive…' }).click();
  await expect(start(dialog)).toBeEnabled({ timeout: 30_000 });
  // Hold the wallet back so the step stays pending: route the Gnosis RPC calls the app itself makes.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/localhost:9545/, async (route) => {
    await gate;
    await route.continue();
  });
  await start(dialog).click();
  await expect(dialog.getByRole('button', { name: 'Confirm in MetaMask…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Leave?')).toBeVisible();
  await expect(dialog).toContainText('Steps already confirmed in MetaMask stay done.');
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(dialog.getByText('Leave?')).toHaveCount(0);
  // Let it finish, so no transaction is still in flight when the test ends.
  release();
  await expect(dialog.getByRole('button', { name: 'Continue: step 2 of 2' })).toBeVisible({ timeout: 90_000 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('@p4 keepalive check E says "not checked", not "expired", when the Gnosis RPC rate-limits', async ({ page }) => {
  test.setTimeout(120_000);
  const selector = toFunctionSelector('remainingBalance(bytes32)');
  await page.route(/localhost:9545/, async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes(selector.slice(2))) {
      await route.fulfill({
        status: 429,
        contentType: 'text/plain',
        headers: { 'access-control-allow-origin': '*' },
        body: 'Too Many Requests',
      });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${APP}/#/c/${sample.entityKey}`);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'E')).toContainText('Storage status not checked');
  await expect(check(page, 'E')).not.toContainText('expired');
});

test('@p4 offline dropped evidence verifies offline: A to C pass, E is not checked, the app keeps working', async ({ page, context }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    (window as unknown as { __unhandled: string[] }).__unhandled = [];
    window.addEventListener('unhandledrejection', (e) =>
      (window as unknown as { __unhandled: string[] }).__unhandled.push(String(e.reason)),
    );
  });
  // The app is loaded first, then the network goes away.
  await page.goto(`${APP}/#/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Recall' })).toBeVisible();
  await page.locator('summary', { hasText: 'More ways to check' }).click();
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);

  await fileInput(page, 'Evidence file').setInputFiles(file('evidence.json', sample.evidenceBytes, 'application/json'));
  await expect(page).toHaveURL(/#\/file$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(NOTICE_HOST);
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass');
  }
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'E')).toContainText('Storage status not checked (offline or RPC unreachable).');
  await expect(page.getByText('Checked offline. A–C ran in your browser; storage (E) was not checked.')).toBeVisible();
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  // Nothing to keep alive offline: that needs a record and two chains.
  await expect(page.getByRole('button', { name: 'Keep alive…' })).toHaveCount(0);

  // The app still works: other pages draw, and the verification can be repeated with a second file.
  await page.goto(`${APP}/#/settings`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.goto(`${APP}/#/`);
  await page.locator('summary', { hasText: 'More ways to check' }).click();
  await expect(page.getByText('Works offline. The file never leaves your browser.')).toBeVisible();
  await fileInput(page, 'Evidence file').setInputFiles(file('evidence.json', sample.evidenceBytes, 'application/json'));
  await expect(status(page, 'A')).toHaveAttribute('data-status', 'pass');

  // No unhandled errors or rejections broke the UI.
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __unhandled: string[] }).__unhandled)).toEqual([]);
  await context.setOffline(false);
});

test('@p4 library keep-alive extends a card in place and its days go up', async ({ page }) => {
  test.setTimeout(240_000);
  const c = await rig.publish();
  await withWallet(page);
  const blockBefore = await arkivBlock(c.entityKey);

  // Newest first: the capture just published is the first card, so it is in view and gets checked.
  await page.goto(`${APP}/#/library?sort=newest`);
  const card = page.locator('[data-library-grid] .ccard').filter({ has: page.locator(`a[href="#/c/${c.entityKey}"]`) });
  await expect(card).toHaveCount(1, { timeout: 60_000 });
  // Cards are checked when they come into view.
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('[data-status]').first()).toHaveAttribute('data-status', 'verified', { timeout: 90_000 });
  const days = card.locator('.ccard-days');
  const daysBefore = Number(await days.getAttribute('data-days'));

  // The card's own Keep alive opens the dialog in place: the library stays behind it.
  await card.getByRole('button', { name: 'Keep alive…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Keep this capture available' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/#\/library/);
  await dialog.getByRole('radio', { name: '30 days' }).check();
  await expect(start(dialog)).toBeEnabled({ timeout: 30_000 });
  await runAll(dialog);
  // The newest capture's own record was extended (spec 12.3), read from the chain.
  expect((await arkivBlock(c.entityKey)) - blockBefore).toBe(blocksForDays(30));

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  // The card counts up to the record's new end. The chain check above pins the exact extension
  // (30 days of nominal blocks); the card shows real days from the chain's own block time, which
  // on the devnet is faster than nominal, so here it only has to go up and say the same as its label.
  await expect.poll(async () => Number(await days.getAttribute('data-days')), { timeout: 30_000 }).toBeGreaterThan(daysBefore);
  const daysAfter = Number(await days.getAttribute('data-days'));
  await expect.poll(async () => Number(await days.textContent()), { timeout: 10_000 }).toBe(daysAfter);
  await expect(page).toHaveURL(/#\/library/);
});
