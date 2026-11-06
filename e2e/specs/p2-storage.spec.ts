import { expect, test } from '@playwright/test';
import { createPublicClient, http, parseAbi, verifyMessage, verifyTypedData, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { LOCAL, POSTAGE_STAMP, batchTtlSeconds } from '../../packages/net/src/index';
import { BEE_COMPOSE_FAUCET_KEY } from '../fixtures/keys';
import { installMockWallet } from '../fixtures/mockWallet';

// The web app (apps/web) on :5173 buys Swarm storage with the mock wallet on the local
// Gnosis fork. The extension hand-off (addBatches) is covered by the extension API spec.

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

test('@p2 storage keeps nothing charged when the wallet request is rejected', async ({ page }) => {
  await wallet(page);
  await page.goto(`${APP}/#/storage`);
  await page.getByLabel('Owner address').fill(privateKeyToAddress(generatePrivateKey()));
  await page.getByLabel('Number of batches').fill('1');

  await page.evaluate(() => {
    (window as unknown as { __rejectNext: boolean }).__rejectNext = true;
  });
  await page.getByRole('button', { name: 'Buy 1 batch' }).click();
  await expect(page.getByRole('heading', { name: 'Not bought' })).toBeVisible();
  await expect(page.getByText('You rejected the request in MetaMask. Nothing was charged.')).toBeVisible();
  await expect(page.locator('li[data-batch-id]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buy 1 batch' })).toBeEnabled();
});

type Eth = {
  request(a: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, fn: (data: unknown) => void): void;
};

test('@p2 storage mock wallet answers EIP-1193 requests, signs with its key and rejects on demand', async ({ page }) => {
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
  await page.evaluate(() => ((window as unknown as { __rejectNext: boolean }).__rejectNext = true));
  expect(await call('eth_chainId')).toEqual({ ok: '0x64' });
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ code: 4001 });
  expect(await call('personal_sign', [message, wallet.address])).toEqual({ ok: sig.ok });
});
