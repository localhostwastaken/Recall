import { expect, test } from '@playwright/test';
import {
  createPublicClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  verifyMessage,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { LOCAL, POSTAGE_STAMP, batchTtlSeconds, costFor } from '../../packages/net/src/index';
import { ceilSig, formatBzzCeil } from '../../apps/web/src/format';
import { BEE_COMPOSE_FAUCET_KEY } from '../fixtures/keys';
import { installMockWallet } from '../fixtures/mockWallet';
import { launchWithExtension } from '../fixtures/extension';

// The web app (apps/web) on :5173 buys Swarm storage with the mock wallet on the local
// Gnosis fork. Most tests have no real extension: the owner is typed in, or a stand-in
// answers the two messages the page sends. The last test hands the batches to the real
// extension's pool (R25).

const APP = 'http://localhost:5173';
// The full Chromium (new headless mode) is the browser installed for the extension specs too.
test.use({ channel: 'chromium' });
const pub = createPublicClient({ chain: gnosis, transport: http(LOCAL.gnosis.rpcUrl) });
const postageAbi = parseAbi([
  'function batchOwner(bytes32 _batchId) view returns (address)',
  'function batchDepth(bytes32 _batchId) view returns (uint8)',
]);

const wallet = (page: Parameters<typeof installMockWallet>[0], chainId = 1337) =>
  installMockWallet(page, {
    privateKey: BEE_COMPOSE_FAUCET_KEY,
    rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
    chainId,
  });

test('@p2 storage buys batches for the extension stamp key', async ({ page }) => {
  test.setTimeout(300_000);
  const owner = privateKeyToAddress(generatePrivateKey());
  await wallet(page); // starts on the Arkiv chain, so the page has to switch to Gnosis
  // No analytics, fonts or CDNs: the browser only talks to the app, the Gnosis fork and Bee.
  const origins = new Set<string>();
  page.on('request', (req) => {
    if (/^https?:/.test(req.url())) origins.add(new URL(req.url()).origin);
  });

  await page.goto(`${APP}/#/storage`);
  await expect(page.getByRole('heading', { level: 1, name: 'Buy storage' })).toBeVisible();

  // No extension in this browser, so the owner (stamp address) is pasted by hand.
  await expect(page.getByText('Recall extension not found. Install it, or set its ID in Settings.')).toBeVisible();
  await page.getByLabel('Owner address').fill(owner);
  await page.getByLabel('Number of batches').fill('2');
  await expect(page.getByText(/2 × [\d.]+ xBZZ = [\d.]+ xBZZ \+ network fees ~[\d.]+ xDAI/)).toBeVisible();

  // "n × a = b" is exact, and a is the real price per batch rounded up (never below it).
  const line = ((await page.locator('.price').innerText()) ?? '').replace(/\s+/g, ' ').trim();
  const parts = /^(\d+) × ([\d.]+) xBZZ = ([\d.]+) xBZZ \+ network fees ~[\d.]+ xDAI$/.exec(line);
  expect(parts, line).not.toBeNull();
  const unit = parseUnits(parts![2], 16);
  expect(unit * BigInt(parts![1])).toBe(parseUnits(parts![3], 16));
  const actual = await costFor(pub, 17, 7);
  expect(unit >= actual).toBe(true);
  expect(unit - actual < actual / 100n).toBe(true);

  await page.getByRole('button', { name: 'Buy 2 batches' }).click();
  await expect(page.getByText('2 batches ready.')).toBeVisible({ timeout: 240_000 });

  const rows = page.locator('li[data-batch-id]');
  await expect(rows).toHaveCount(2);
  const ids = (await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-batch-id')))) as Hex[];
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) {
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    const ttl = await batchTtlSeconds(pub, id);
    expect(ttl).not.toBeNull();
    expect(ttl! > 0n).toBe(true);
    // 7 days by default, minus the blocks that passed while the batches became usable.
    expect(ttl! > 6n * 86_400n).toBe(true);
    expect(await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchOwner', args: [id] })).toBe(
      owner as Address,
    );
    expect(await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchDepth', args: [id] })).toBe(17);
    await expect(page.locator(`li[data-batch-id="${id}"]`)).toContainText('Ready');
  }
  await expect(page.locator('li[data-batch-id]').first()).toContainText(/Storage left: .*\d/);
  expect([...origins].sort()).toEqual([APP, LOCAL.swarm.uploadUrl, LOCAL.gnosis.rpcUrl].sort());
  const chainId = await page.evaluate(() =>
    (window as unknown as { ethereum: { request(a: { method: string }): Promise<string> } }).ethereum.request({
      method: 'eth_chainId',
    }),
  );
  expect(chainId).toBe('0x64'); // the page switched the wallet to Gnosis
});

test('@p2 storage asks for a valid owner address when no extension is connected', async ({ page }) => {
  await wallet(page);
  await page.goto(`${APP}/#/storage`);
  const buy = page.getByRole('button', { name: /^Buy / });
  await expect(page.getByLabel('Number of batches')).toHaveValue('4');
  await expect(buy).toBeDisabled();
  await expect(page.getByText('Enter the owner address to continue.')).toBeVisible();

  const owner = page.getByLabel('Owner address');
  await owner.fill('0x1234');
  await owner.blur();
  await expect(page.getByText('Enter a 0x address (42 characters).')).toBeVisible();
  await expect(buy).toBeDisabled();

  await owner.fill(privateKeyToAddress(generatePrivateKey()));
  await expect(page.getByText('Enter a 0x address (42 characters).')).toBeHidden();
  await expect(buy).toBeEnabled();

  const count = page.getByLabel('Number of batches');
  await count.fill('21');
  await count.blur();
  await expect(page.getByText('Enter a whole number from 1 to 20.')).toBeVisible();
  await expect(buy).toBeDisabled();
});

type TestWindow = Window & { __rejectNext?: unknown; __extFail?: boolean; __extMessages?: { type: string; batchIds?: string[] }[] };

test('@p2 storage keeps nothing charged when the wallet request is rejected', async ({ page }) => {
  await wallet(page);
  await page.goto(`${APP}/#/storage`);
  await page.getByLabel('Owner address').fill(privateKeyToAddress(generatePrivateKey()));
  await page.getByLabel('Number of batches').fill('1');

  await page.evaluate(() => {
    (window as TestWindow).__rejectNext = true; // the connect prompt
  });
  await page.getByRole('button', { name: 'Buy 1 batch' }).click();
  await expect(page.getByRole('heading', { name: 'Not bought' })).toBeVisible();
  await expect(page.getByText('You rejected the request in MetaMask. Nothing was charged.')).toBeVisible();
  // Nothing was bought, so there is no batch list to show.
  await expect(page.locator('li[data-batch-id]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Batches' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy 1 batch' })).toBeEnabled();
});

test('@p2 storage does not claim "nothing charged" when a purchase prompt is rejected', async ({ page }) => {
  await wallet(page, 100); // already on Gnosis: the first prompt is the xBZZ approval
  await page.goto(`${APP}/#/storage`);
  await page.getByLabel('Owner address').fill(privateKeyToAddress(generatePrivateKey()));
  await page.getByLabel('Number of batches').fill('1');

  await page.evaluate(() => {
    (window as TestWindow).__rejectNext = 'eth_sendTransaction';
  });
  await page.getByRole('button', { name: 'Buy 1 batch' }).click();
  await expect(page.getByRole('heading', { name: 'Not bought' })).toBeVisible();
  await expect(
    page.getByText(
      'You rejected the request in MetaMask. No storage was bought. If you already approved the xBZZ spend, that approval and its small network fee remain.',
    ),
  ).toBeVisible();
  await expect(page.getByText(/Nothing (more )?was charged/)).toHaveCount(0);
  await expect(page.locator('li[data-batch-id]')).toHaveCount(0);
  // Nothing was bought, so the form stays open for another go.
  await expect(page.getByLabel('Number of batches')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});

test('@p2 storage never buys a batch twice when the result of a sent purchase could not be read', async ({ page }) => {
  test.setTimeout(360_000);
  const payer = privateKeyToAddress(BEE_COMPOSE_FAUCET_KEY);
  const owner = privateKeyToAddress(generatePrivateKey());
  const sentNonce = () => pub.getTransactionCount({ address: payer, blockTag: 'pending' });
  await wallet(page, 100);
  // MetaMask's receipt reads fail once the createBatch is sent (the approval's still work)...
  await page.addInitScript(() => {
    const w = window as unknown as {
      ethereum: { request(a: { method: string }): Promise<unknown> };
      __sends: number;
      __failReceiptsAfter?: number;
    };
    const request = w.ethereum.request.bind(w.ethereum);
    w.__sends = 0;
    w.ethereum.request = async (args) => {
      if (args.method === 'eth_getTransactionReceipt' && w.__failReceiptsAfter !== undefined && w.__sends > w.__failReceiptsAfter) {
        throw Object.assign(new Error('simulated RPC failure while waiting for the receipt'), { code: -32602 });
      }
      const result = await request(args);
      if (args.method === 'eth_sendTransaction') w.__sends++;
      return result;
    };
  });
  // ...and so do the page's own reads from the Gnosis RPC, until the test lets them through.
  let failPageReceipts = true;
  let failedReads = 0;
  const rpcOrigin = new URL(LOCAL.gnosis.rpcUrl).origin;
  await page.route(
    (u) => u.origin === rpcOrigin,
    async (route) => {
      const body = route.request().postData() ?? '';
      if (!failPageReceipts || route.request().method() !== 'POST' || !body.includes('eth_getTransactionReceipt')) {
        return route.continue();
      }
      const { id } = JSON.parse(body) as { id: number };
      failedReads++;
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'simulated RPC failure' } }),
      });
    },
  );

  await page.goto(`${APP}/#/storage`);
  await page.getByLabel('Owner address').fill(owner);
  await page.getByLabel('Number of batches').fill('1');
  await page.evaluate(() => ((window as unknown as { __failReceiptsAfter: number }).__failReceiptsAfter = 1));
  const n0 = await sentNonce();
  await page.getByRole('button', { name: 'Buy 1 batch' }).click();

  const unknown = page.getByRole('heading', { name: 'The purchase may have gone through' });
  await expect(unknown).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Batch 1 was sent to Gnosis .*but its result could not be read yet/)).toBeVisible();
  await expect(page.locator('li').filter({ hasText: 'Batch 1' })).toContainText('Not confirmed');
  await expect(page.getByLabel('Number of batches')).toBeDisabled(); // the plan stays locked
  await expect(page.getByRole('button', { name: 'Buy 1 batch' })).toBeDisabled();
  await expect.poll(sentNonce).toBe(n0 + 2); // approve + createBatch

  // Still unreadable: checking again says so again, and sends nothing.
  const reads = failedReads;
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => failedReads, { timeout: 60_000 }).toBeGreaterThan(reads);
  await expect(unknown).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled({ timeout: 90_000 });
  expect(await sentNonce()).toBe(n0 + 2);

  // Readable again: the same purchase is found, not repeated.
  failPageReceipts = false;
  await page.evaluate(() => delete (window as unknown as { __failReceiptsAfter?: number }).__failReceiptsAfter);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByRole('heading', { name: '1 batch ready.' })).toBeVisible({ timeout: 240_000 });
  expect(await sentNonce()).toBe(n0 + 2);
  const ids = (await page.locator('li[data-batch-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-batch-id')))) as Hex[];
  expect(ids).toHaveLength(1);
  expect(await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchOwner', args: [ids[0]!] })).toBe(owner);
  // Settled: nothing is left for a later visit to look up.
  expect(await page.evaluate(() => sessionStorage.getItem('recall.storage.sentTx.v1.0'))).toBeNull();
});

test('@p2 storage shows the xBZZ it needs rounded up', async ({ page }) => {
  // A fresh key holds no xBZZ, so the balance check stops the purchase before any prompt.
  await installMockWallet(page, {
    privateKey: generatePrivateKey(),
    rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
    chainId: 100,
  });
  await page.goto(`${APP}/#/storage`);
  await page.getByLabel('Owner address').fill(privateKeyToAddress(generatePrivateKey()));
  await page.getByLabel('Number of batches').fill('3');
  await page.getByRole('button', { name: 'Buy 3 batches' }).click();

  await expect(page.getByRole('heading', { name: 'Not enough xBZZ' })).toBeVisible();
  const need = 3n * (await costFor(pub, 17, 7));
  const shown = formatBzzCeil(need);
  await expect(page.getByText(`You need ${shown} xBZZ on Gnosis.`)).toBeVisible();
  // Rounded up, and by less than 1 percent.
  const shownUnits = parseUnits(shown, 16);
  expect(shownUnits >= need).toBe(true);
  expect(shownUnits - need < need / 100n).toBe(true);
  await expect(page.locator('li[data-batch-id]')).toHaveCount(0);
});

test('@p2 storage amounts round up, never down', () => {
  expect(ceilSig(0n)).toBe(0n);
  expect(ceilSig(123n)).toBe(123n);
  expect(ceilSig(1230n)).toBe(1230n);
  expect(ceilSig(1231n)).toBe(1240n);
  expect(ceilSig(999_999n)).toBe(1_000_000n);
  expect(formatBzzCeil(380_518_434_000_001n)).toBe('0.0381'); // 0.03805... rounds up, not to 0.038
  expect(formatBzzCeil(380_000_000_000_000n)).toBe('0.038'); // already exact: unchanged
  for (let e = 0; e <= 24; e++) {
    for (const m of [1n, 99n, 100n, 101n, 999n, 1000n, 1001n, 123_456_789n]) {
      const v = m * 10n ** BigInt(e) + 1n;
      const c = ceilSig(v);
      expect(c >= v, `${v}`).toBe(true);
      // Never more than one unit in the third significant digit above the real figure.
      expect(c - v <= 10n ** BigInt(Math.max(v.toString().length - 3, 0)), `${v}`).toBe(true);
      expect(parseUnits(formatUnits(c, 16), 16)).toBe(c);
    }
  }
});

/** A stand-in for the extension: answers the two messages the page sends and records them. */
async function stubExtension(page: Parameters<typeof installMockWallet>[0], stampAddress: Address) {
  await page.addInitScript({
    content: `(() => {
      try { localStorage.setItem('recall.web.settings.v1', JSON.stringify({ extensionId: 'a'.repeat(32), theme: 'system' })); } catch (e) {}
      window.__extFail = true;
      window.__extMessages = [];
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        lastError: undefined,
        sendMessage(extId, msg, cb) {
          window.__extMessages.push(msg);
          setTimeout(() => {
            if (msg.type === 'recall.getStampAddress') cb({ address: ${JSON.stringify(stampAddress)} });
            else if (msg.type === 'recall.addBatches' && window.__extFail) cb({ error: 'pool is full' });
            else if (msg.type === 'recall.addBatches') cb({ pool: msg.batchIds.map((batchId) => ({ batchId, used: false })) });
            else cb({ error: 'unknown message' });
          }, 0);
        },
      };
    })();`,
  });
}

test('@p2 storage asks before using an extension that only the link names', async ({ page }) => {
  const mine = privateKeyToAddress(generatePrivateKey());
  const theirs = privateKeyToAddress(generatePrivateKey());
  const MINE = 'a'.repeat(32);
  const THEIRS = 'b'.repeat(32);
  // Settings name extension a…a; another installed extension b…b answers with its own stamp key.
  await page.addInitScript(
    ({ mine, theirs, MINE }) => {
      localStorage.setItem('recall.web.settings.v1', JSON.stringify({ extensionId: MINE, theme: 'system' }));
      (window as unknown as { chrome: unknown }).chrome = {
        runtime: {
          lastError: undefined,
          sendMessage(extId: string, msg: { type: string }, cb: (r: unknown) => void) {
            setTimeout(() => cb(msg.type === 'recall.getStampAddress' ? { address: extId === MINE ? mine : theirs } : { error: 'no' }), 0);
          },
        },
      };
    },
    { mine, theirs, MINE },
  );
  await wallet(page, 100);
  const buy = page.getByRole('button', { name: /^Buy / });

  // A link naming another extension: nothing can be bought until the person chooses.
  await page.goto(`${APP}/#/storage?ext=${THEIRS}`);
  await expect(page.getByText(`This link uses extension ${THEIRS}, which isn't the one in your Settings.`)).toBeVisible();
  await expect(page.locator('.ext-choice .mono-value')).toHaveAttribute('title', theirs);
  await expect(page.getByLabel('Owner address')).toHaveCount(0);
  await expect(page.locator('.price')).toContainText('xBZZ');
  await expect(buy).toBeDisabled();
  await expect(page.getByText('Choose which extension to use first: see the notice above.')).toBeVisible();

  // Keep my Settings: the owner is the Settings extension's key, and Settings are unchanged.
  await page.getByRole('button', { name: 'Keep my Settings' }).click();
  await expect(page.locator('.owner-row .mono-value')).toHaveAttribute('title', mine);
  await expect(buy).toBeEnabled();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('recall.web.settings.v1')))!)).toMatchObject({ extensionId: MINE });

  // Use this extension: it becomes the owner and is saved to Settings.
  await page.goto(`${APP}/#/storage?ext=${THEIRS}`);
  await page.reload(); // the init script resets Settings to a…a first
  await expect(buy).toBeDisabled();
  await page.getByRole('button', { name: 'Use this extension' }).click();
  await expect(page.locator('.owner-row .mono-value')).toHaveAttribute('title', theirs);
  await expect(buy).toBeEnabled();
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('recall.web.settings.v1')))!)).toMatchObject({ extensionId: THEIRS });

  // A link naming the Settings extension is used straight away.
  await page.goto(`${APP}/#/storage?ext=${MINE}`);
  await page.reload();
  await expect(page.locator('.owner-row .mono-value')).toHaveAttribute('title', mine);
  await expect(page.locator('.ext-choice')).toHaveCount(0);
  await expect(buy).toBeEnabled();
});

test('@p2 storage finishes a part-bought plan and claims the extension hand-off only once it worked', async ({ page }) => {
  test.setTimeout(480_000);
  const stamp = privateKeyToAddress(generatePrivateKey());
  await wallet(page, 100);
  await stubExtension(page, stamp);
  await page.goto(`${APP}/#/storage`);
  await expect(page.getByText('Owner (extension):')).toBeVisible();

  // 30 days, so a later purchase with the default 7 would show up in the batch lifetime.
  await page.getByLabel('Number of batches').fill('2');
  await page.getByLabel('30 days').check();
  // Batch 1 goes through (approve + create); the approval for batch 2 is rejected.
  await page.evaluate(() => {
    (window as TestWindow).__rejectNext = { method: 'eth_sendTransaction', skip: 2 };
  });
  await page.getByRole('button', { name: 'Buy 2 batches' }).click();

  // The rejection shows at once, while batch 1 is still being waited for.
  const cancelled = page.getByRole('heading', { name: '1 of 2 bought.' });
  await expect(cancelled).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText(
      'You rejected batch 2 in MetaMask. No more storage was bought. If you already approved the xBZZ spend, that approval and its small network fee remain.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Waiting for batches to become usable (about 1–2 min)')).toBeVisible();
  const resume = page.getByRole('button', { name: 'Buy remaining 1' });
  await expect(resume).toBeDisabled();
  // The plan is locked: the amount and duration cannot change under it.
  await expect(page.getByLabel('Number of batches')).toBeDisabled();
  await expect(page.getByLabel('7 days')).toBeDisabled();
  await expect(page.getByLabel('30 days')).toBeDisabled();

  // Once batch 1 is usable the notice stays and its action turns on. The stand-in refuses
  // the hand-off, and the page says so.
  await expect(resume).toBeEnabled({ timeout: 200_000 });
  await expect(cancelled).toBeVisible();
  await expect(page.locator('li[data-batch-id]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'The extension was not updated' })).toBeVisible();
  await expect(page.getByLabel('Number of batches')).toBeDisabled();

  await resume.click();
  await expect(page.getByRole('heading', { name: '2 batches ready.' })).toBeVisible({ timeout: 300_000 });
  // The extension still has not accepted them, so the page does not say it can make captures.
  await expect(page.getByText("They are paid for, but they are not in the extension's pool yet.")).toBeVisible();
  await expect(page.getByText(/You can make/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'The extension was not updated' })).toBeVisible();
  await expect(page.getByLabel('Number of batches')).toBeEnabled(); // finished: the form opens again

  // The extension recovers; the retry hands both batches over, and only then the claim appears.
  await page.evaluate(() => {
    (window as TestWindow).__extFail = false;
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('You can make 2 more captures.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The extension was not updated' })).toBeHidden();

  const ids = (await page.locator('li[data-batch-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-batch-id')))) as Hex[];
  expect(ids).toHaveLength(2);
  const sent = (await page.evaluate(() => (window as TestWindow).__extMessages!)).filter((m) => m.type === 'recall.addBatches');
  expect([...(sent[sent.length - 1].batchIds ?? [])].sort()).toEqual([...ids].sort());
  for (const id of ids) {
    // Both batches use the duration chosen at the start, 30 days.
    const ttl = await batchTtlSeconds(pub, id);
    expect(ttl! > 29n * 86_400n).toBe(true);
    expect(await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchOwner', args: [id] })).toBe(stamp);
  }
});

type Eth = {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, fn: (data: unknown) => void): void;
};

test('@p2 mock wallet answers EIP-1193 requests, signs with its key and rejects on demand', async ({ page }) => {
  // A key without the 0x prefix is accepted (R11).
  const wallet = await installMockWallet(page, {
    privateKey: BEE_COMPOSE_FAUCET_KEY.slice(2),
    rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
    chainId: 1337,
  });
  await page.goto(`${APP}/`);

  // EIP-6963 announcement.
  const announced = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        window.addEventListener('eip6963:announceProvider', (e) => resolve((e as CustomEvent).detail.info.name));
        window.dispatchEvent(new Event('eip6963:requestProvider'));
      }),
  );
  expect(announced).toBe('Mock Wallet');

  const call = (method: string, params: unknown[] = []) =>
    page.evaluate(
      async ([m, p]) => {
        try {
          return { ok: await (window as unknown as { ethereum: Eth }).ethereum.request({ method: m as string, params: p as unknown[] }) };
        } catch (e) {
          return { code: (e as { code: number }).code };
        }
      },
      [method, params] as const,
    );

  // Like MetaMask: no accounts until the person connects.
  expect(await call('eth_accounts')).toEqual({ ok: [] });
  expect(await call('eth_requestAccounts')).toEqual({ ok: [wallet.address] });
  expect(await call('eth_accounts')).toEqual({ ok: [wallet.address] });
  expect(await call('eth_chainId')).toEqual({ ok: '0x539' });

  // Reads are proxied to the current chain's RPC.
  expect(await call('eth_blockNumber')).toEqual({ ok: expect.stringMatching(/^0x[0-9a-f]+$/) });

  // Switching emits chainChanged; an unknown chain is error 4902.
  await page.evaluate(() => {
    (window as unknown as { __chain: unknown[] }).__chain = [];
    (window as unknown as { ethereum: Eth }).ethereum.on('chainChanged', (c) => (window as unknown as { __chain: unknown[] }).__chain.push(c));
  });
  expect(await call('wallet_switchEthereumChain', [{ chainId: '0x64' }])).toEqual({ ok: null });
  expect(await call('eth_chainId')).toEqual({ ok: '0x64' });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __chain: unknown[] }).__chain)).toEqual(['0x64']);
  expect(await call('wallet_switchEthereumChain', [{ chainId: '0x1234' }])).toEqual({ code: 4902 });
  expect(wallet.chainId()).toBe(100);

  // personal_sign and EIP-712 signatures verify against the wallet's address.
  const message = '0x' + Buffer.from('recall').toString('hex');
  const sig = (await call('personal_sign', [message, wallet.address])) as { ok: Hex };
  expect(await verifyMessage({ address: wallet.address, message: { raw: message as Hex }, signature: sig.ok })).toBe(true);

  const typed = {
    domain: { name: 'Recall', version: '1', chainId: 100 },
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      Note: [{ name: 'text', type: 'string' }],
    },
    primaryType: 'Note',
    message: { text: 'hello' },
  };
  const typedSig = (await call('eth_signTypedData_v4', [wallet.address, JSON.stringify(typed)])) as { ok: Hex };
  expect(
    await verifyTypedData({
      address: wallet.address,
      domain: typed.domain,
      types: { Note: typed.types.Note },
      primaryType: 'Note',
      message: typed.message,
      signature: typedSig.ok,
    }),
  ).toBe(true);

  // __rejectNext skips reads and rejects the next request that would open a MetaMask prompt.
  await page.evaluate(() => ((window as TestWindow).__rejectNext = true));
  expect(await call('eth_chainId')).toEqual({ ok: '0x64' });
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ code: 4001 });
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ ok: sig.ok });

  // Aimed rejections: a method name, and `skip` lets that many matching requests through first.
  await page.evaluate(() => ((window as TestWindow).__rejectNext = 'eth_signTypedData_v4'));
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ ok: sig.ok });
  expect(await call('eth_signTypedData_v4', [wallet.address, JSON.stringify(typed)])).toEqual({ code: 4001 });
  await page.evaluate(() => ((window as TestWindow).__rejectNext = { method: 'personal_sign', skip: 1 }));
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ ok: sig.ok });
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ code: 4001 });
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ ok: sig.ok });
});

test('@p2 storage hands the bought batches to the real extension pool', async () => {
  test.setTimeout(300_000);
  const ext = await launchWithExtension({ dev: true });
  try {
    const page = await ext.context.newPage();
    await wallet(page, 100);
    // The app finds the extension by its ID (Settings, saved in this browser only).
    await page.addInitScript((id) => {
      localStorage.setItem('recall.web.settings.v1', JSON.stringify({ extensionId: id, theme: 'system' }));
    }, ext.extensionId);
    await page.goto(`${APP}/#/storage`);

    // The owner is the extension's stamp key, as the extension itself reports it.
    const stamp = (await page.evaluate(
      (id) =>
        new Promise((resolve) =>
          (window as unknown as { chrome: { runtime: { sendMessage: Function } } }).chrome.runtime.sendMessage(
            id,
            { type: 'recall.getStampAddress' },
            (r: { address: string }) => resolve(r.address),
          ),
        ),
      ext.extensionId,
    )) as Address;
    expect(stamp).toMatch(/^0x[0-9a-fA-F]{40}$/);
    await expect(page.locator('.owner-row')).toContainText('Owner (extension):');
    await expect(page.locator('.owner-row .mono-value')).toHaveAttribute('title', stamp);

    await page.getByLabel('Number of batches').fill('1');
    await page.getByRole('button', { name: 'Buy 1 batch' }).click();
    await expect(page.getByText('You can make 1 more capture.')).toBeVisible({ timeout: 240_000 });

    const ids = (await page.locator('li[data-batch-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-batch-id')))) as Hex[];
    expect(ids).toHaveLength(1);
    expect(await pub.readContract({ address: POSTAGE_STAMP, abi: postageAbi, functionName: 'batchOwner', args: [ids[0]] })).toBe(stamp);

    // The extension's pool now holds exactly that batch, unused.
    const sw = ext.context.serviceWorkers().filter((w) => w.url().includes(ext.extensionId)).pop() ?? ext.serviceWorker;
    const pool = (await sw.evaluate(async () => {
      const local = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } })
        .chrome.storage.local;
      return (await local.get('recall.pool'))['recall.pool'];
    })) as { batchId: string; used: boolean }[];
    expect(pool.map((b) => [b.batchId, b.used])).toEqual([[ids[0].toLowerCase(), false]]);
  } finally {
    await ext.context.close();
  }
});
