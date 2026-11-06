/**
 * Real Chrome review of the local Vite app. RPC replies and evidence used here
 * are controlled test fixtures, never product data. No devnet is required.
 * Run from the repository root: pnpm exec tsx apps/web/test/browser-review.ts
 */
import { chromium, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sha256, toBytes, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildEvidence, bytesToBase64, encodeEvidence, CAPTURE_TYPES, WITNESS_DOMAIN } from '@recall/evidence';

const out = fileURLToPath(new URL('../../../test-results/recall-ui/', import.meta.url));
const base = process.env.RECALL_WEB_URL ?? 'http://localhost:5173/';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: string[] = [];
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
async function shot(page: Page, name: string) {
  await noOverflow(page);
  await page.screenshot({ path: out + name + '.png', fullPage: true });
}

// The known test key signs only synthetic bytes; it has no network funds or use.
const account = privateKeyToAccount(('0x' + '1'.padStart(64, '0')) as Hex);
const body = '<h1>Synthetic reader test</h1><p>This is a local test fixture, not an archived announcement.</p><script>window.__archivedScriptRan = true</script>';
const path = '/synthetic-notice/' + 'long-path-'.repeat(18);
const sent = toBytes('GET ' + path + ' HTTP/1.1\r\nHost: example.org\r\nAccept-Encoding: identity\r\n\r\n');
const recv = toBytes('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ' + toBytes(body).length + '\r\n\r\n' + body);
const statement = { serverName: 'example.org', connTime: 1n, signedAt: 2n, sentSha256: sha256(sent), recvSha256: sha256(recv), sentLen: sent.length, recvLen: recv.length, tlsVersion: 12, nonce: ('0x' + '0'.repeat(64)) as Hex };
const signature = await account.signTypedData({ domain: WITNESS_DOMAIN, types: CAPTURE_TYPES, primaryType: 'Capture', message: statement });
const evidence = buildEvidence({ statement, signature, signer: account.address, sent, recv });
const evidenceBytes = encodeEvidence(evidence);
const longFilename = 'synthetic-reader-test-' + 'long-name-'.repeat(8) + '.json';

try {
  const context = await browser.newContext({ colorScheme: 'dark', reducedMotion: 'reduce' });
  // Migration coverage: a previously saved dark choice cannot darken any route.
  await context.addInitScript(() => localStorage.setItem('recall.web.settings.v1', JSON.stringify({ theme: 'dark', extensionId: 'synthetic-test-extension-id' })));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));

  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: width > 1000 ? 1000 : 844 });
    for (const route of ['', '#/reader']) {
      await page.goto(base + route);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => [...document.fonts].every(f => f.status === 'loaded'))).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 253, 245)');
      expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
      await shot(page, (route ? 'reader' : 'landing') + '-' + width);
    }
    console.log('Layout and local fonts passed at ' + width + 'px, with a dark system preference.');
  }

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    await page.reload();
    await expect(page.locator('#landing-title')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    expect(await page.getByRole('link', { name: 'Skip to content' }).evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    await expect(page.locator('.announcement-earlier')).toContainText('6–8');
    await expect(page.locator('.announcement-updated')).toContainText('5–7');
    await expect(page.locator('.archive-exhibit figcaption')).toContainText('Illustrative reconstruction based on the public date change.');
    await page.getByRole('button', { name: 'Updated announcement', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Updated announcement', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.example-date')).toContainText('5–7');
    await expect(page.locator('.example-update')).toContainText('One day earlier.');
    await shot(page, 'updated-story-' + width);

    await page.locator('.hero-actions a').click();
    await expect(page).toHaveURL(/#\/reader$/);
    await expect(page.locator('h1')).toBeFocused();
    await page.locator('.product-tools summary').click();
    await expect(page.locator('.tools-panel')).toBeVisible();
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.product-tools summary')).toBeFocused();
    await expect(page.locator('.tools-panel')).not.toBeVisible();

    await page.getByRole('button', { name: 'Find captures' }).click();
    await expect(page.getByRole('textbox', { name: 'Page address' })).toBeFocused();
    await expect(page.locator('#url-error')).toContainText('Enter the full HTTPS address');
    await page.getByRole('textbox', { name: 'Page address' }).fill('http://example.org/notice');
    await page.getByRole('button', { name: 'Find captures' }).click();
    await expect(page.locator('#url-error')).toContainText('Use a public HTTPS address');

    let mode: 'empty' | 'error' = 'empty';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('http://localhost:8545/**', async route => {
      await gate;
      const request = route.request().postDataJSON();
      // Shape follows the installed SDK's RpcQuery response.
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        ...(mode === 'empty' ? { result: { data: [], blockNumber: '0x1' } } : { error: { code: -32602, message: 'Controlled test index failure' } }),
      }) });
    });
    await page.getByRole('textbox', { name: 'Page address' }).fill('https://example.org/synthetic-test');
    await page.getByRole('button', { name: 'Find captures' }).click();
    await expect(page.getByRole('button', { name: 'Searching…' })).toBeDisabled();
    await shot(page, 'lookup-loading-' + width);
    release();
    await expect(page.getByRole('heading', { name: 'No captures found for this address.' })).toBeVisible();
    await shot(page, 'lookup-empty-' + width);
    mode = 'error';
    await page.getByRole('button', { name: 'Find captures' }).click();
    await expect(page.getByText('The index could not be reached', { exact: true })).toBeVisible({ timeout: 15000 });
    await shot(page, 'lookup-error-' + width);
    mode = 'empty';
    await page.getByRole('button', { name: 'Retry search' }).click();
    await expect(page.getByRole('heading', { name: 'No captures found for this address.' })).toBeVisible();

    const fileInput = page.getByLabel('Choose evidence JSON file');
    await fileInput.setInputFiles({ name: 'synthetic-malformed.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
    await expect(page.getByText('Evidence could not be inspected', { exact: true })).toBeVisible();
    await expect(page.locator('.capture-detail .badge-unavailable')).toHaveCount(3);
    await shot(page, 'file-unavailable-' + width);

    await fileInput.setInputFiles({ name: longFilename, mimeType: 'application/json', buffer: Buffer.from(evidenceBytes) });
    await expect(page.locator('.reading-text')).toContainText('Synthetic reader test');
    await expect(page.locator('.capture-detail .badge-pass')).toHaveCount(2);
    await expect(page.locator('.capture-detail .badge-unknown').filter({ hasText: 'Unknown witness' })).toHaveCount(1);
    await expect(page.getByText('Not proven', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __archivedScriptRan?: boolean }).__archivedScriptRan)).toBeUndefined();
    await page.locator('.technical-details summary').click();
    await shot(page, 'file-checked-' + width);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download evidence JSON' }).click();
    const download = await downloadPromise;
    expect(Buffer.compare(await readFile((await download.path())!), Buffer.from(evidenceBytes))).toBe(0);
    await page.getByRole('button', { name: 'Close record' }).click();
    await expect(fileInput).toBeFocused();

    const tampered = structuredClone(evidence);
    tampered.transcript.recv = bytesToBase64(toBytes('changed response'));
    await fileInput.setInputFiles({ name: 'synthetic-tampered.json', mimeType: 'application/json', buffer: Buffer.from(encodeEvidence(tampered)) });
    await expect(page.getByText('A check failed', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reading view unavailable' })).toBeVisible();
    await expect(page.locator('.capture-detail .badge-fail')).not.toHaveCount(0);
    await shot(page, 'file-failed-' + width);
    await page.unroute('http://localhost:8545/**');

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Extension ID' })).toHaveValue('synthetic-test-extension-id');
    console.log('Keyboard, story, navigation, loading, no-results, retry, malformed file, unknown witness, safe text, download and tamper checks passed at ' + width + 'px.');
  }
  expect(errors).toEqual([]);
  console.log('Browser review passed. Screenshots: ' + out);
} finally {
  await browser.close();
}
