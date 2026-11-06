import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, createWalletClient, http, parseEther, sha256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { canonicalUrl, encodeEvidence, parseResponse, urlHash as hashUrl, type EvidenceFile } from '../../packages/evidence/src/index';
import {
  LOCAL,
  arkivPublic,
  arkivWallet,
  swarmRootOf,
  uploadFree,
  waitBatchUsable,
  writeCapture,
  type CaptureRow,
} from '../../packages/net/src/index';
import { DEVNET_WITNESS_ADDRESS, DEV_PRIVATE_KEY } from '../fixtures/keys';
import { allowLocalArkiv } from '../fixtures/localCors';
import { NOTICE_HOST, record, signEvidence, tamperEvidence } from '../fixtures/verifyRig';

// Settings (§4.8) and the free upload mode's read side (R13), against the REAL local devnet
// (Arkiv :8545, Bee :1633/:1643, Gnosis fork :9545, notice fixture :443). Fixtures are built in
// beforeAll: recorded TLS transcripts, witness-signed with the public devnet witness key, and
// uploaded through a stand-in for a public gateway (a tiny proxy in front of the local Bee node
// that adds the node's OWN postage batch, which is what a gateway's free /bytes endpoint does).
// Nothing in the page is mocked, except where a test says so (a gateway whose reference differs
// from the local root, and the extension's chrome.runtime).

const APP = 'http://localhost:5173';
test.use({ channel: 'chromium', colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });

// Hardhat account #9 of the public "test test ... junk" mnemonic: public and devnet-only. It writes
// this spec's Arkiv records, so the spec never sends from DEV_PRIVATE_KEY or the faucet key, which
// other specs use at the same time (a shared key means nonce races). Never use it outside the devnet.
const SETTINGS_WALLET_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as const;
const SETTINGS_WALLET_ADDRESS = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720' as const;

const NODE = LOCAL.swarm.uploadUrl; // the Bee node that takes uploads (:1633)
const NODE_DOWNLOAD = LOCAL.swarm.downloadUrls[0]!; // the default download gateway (:1643)
const ZERO_BATCH = `0x${'0'.repeat(64)}` as Hex;
const SETTINGS_KEY = 'recall.web.settings.v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A gateway stand-in: POST /bytes goes to the local Bee node under the node's own batch. */
async function startGateway(batchId: Hex): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    if (req.method !== 'POST' || req.url !== '/bytes') return void res.writeHead(404, cors).end();
    const target = new URL(`${NODE}/bytes`);
    const up = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'swarm-postage-batch-id': batchId.slice(2),
          // The gateway answers once the chunks are pushed, so another node can serve them at once.
          'swarm-deferred-upload': 'false',
        },
      },
      (back) => res.writeHead(back.statusCode ?? 502, { ...cors, 'content-type': 'application/json' }) && back.pipe(res),
    );
    up.on('error', () => res.writeHead(502, cors).end());
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Buys a batch from the Bee node's own wallet: the "gateway's own batch". */
async function buyNodeBatch(): Promise<Hex> {
  const res = await fetch(`${NODE}/stamps/1000000000/17?immutable=true`, { method: 'POST' });
  if (!res.ok) throw new Error(`the node would not buy a batch: ${res.status} ${await res.text()}`);
  const { batchID } = (await res.json()) as { batchID: string };
  const id = `0x${batchID}` as Hex;
  await waitBatchUsable(NODE, id, 240_000);
  return id;
}

type Fixture = {
  url: string;
  urlHash: Hex;
  evidence: EvidenceFile;
  evidenceBytes: Uint8Array;
  signedAt: bigint;
  row: CaptureRow;
  entityKey: Hex;
};

const eventually = async <T>(read: () => Promise<T>, what: string): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      return await read();
    } catch (e) {
      last = e;
      await sleep(250);
    }
  }
  throw new Error(`${what} did not show up: ${(last as Error)?.message}`);
};

/** Makes sure the settings wallet has gas on the local Arkiv chain (the dev chain prefunds it; else DEV sends some). */
async function ensureArkivGas(): Promise<void> {
  const pub = arkivPublic(LOCAL);
  if ((await pub.getBalance({ address: SETTINGS_WALLET_ADDRESS })) >= parseEther('0.5')) return;
  const bank = createWalletClient({ account: privateKeyToAccount(DEV_PRIVATE_KEY), chain: pub.chain, transport: http(LOCAL.arkiv.rpcUrl) });
  const client = createPublicClient({ transport: http(LOCAL.arkiv.rpcUrl) });
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const nonce = await client.getTransactionCount({ address: bank.account.address, blockTag: 'pending' });
      const hash = await bank.sendTransaction({ to: SETTINGS_WALLET_ADDRESS, value: parseEther('1'), nonce });
      await pub.waitForTransactionReceipt({ hash });
      return;
    } catch (e) {
      if (!/nonce|already known|underpriced/i.test(String(e))) throw e;
      await sleep(200 + Math.random() * 300);
    }
  }
  throw new Error('could not fund the settings wallet');
}

let gatewayBatch: Hex;
let gateway: { server: Server; url: string };
/** A capture whose evidence really is on Swarm (uploaded through the gateway stand-in), batch id 0x00…00. */
let free: Fixture;
let other: Fixture;

/** Records a unique notice page, signs it and builds the evidence (nothing is uploaded or written). */
async function capture(witnessKey?: Hex): Promise<Omit<Fixture, 'row' | 'entityKey'> & { body: Uint8Array }> {
  const target = `/notice?run=${randomBytes(6).toString('hex')}`;
  const rec = await record(target);
  const url = canonicalUrl(`https://${NOTICE_HOST}${target}`);
  const { evidence, signedAt } = await signEvidence(rec, { capturedUrl: url, key: witnessKey });
  return { url, urlHash: hashUrl(url), evidence, evidenceBytes: encodeEvidence(evidence), signedAt, body: parseResponse(rec.recv).body };
}

/** Writes the Arkiv entity for a capture. `entity` patches the row (batch id, reference ...). */
async function publish(
  c: Awaited<ReturnType<typeof capture>>,
  entity: Partial<CaptureRow> & Pick<CaptureRow, 'evidenceRef' | 'batchId'>,
): Promise<Fixture> {
  const row: CaptureRow = {
    urlHash: c.urlHash,
    bodySha256: sha256(c.body),
    serverName: NOTICE_HOST,
    witness: DEVNET_WITNESS_ADDRESS,
    signedAt: c.signedAt,
    httpStatus: 200,
    canonicalUrl: c.url,
    ...entity,
  };
  const wallet = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(SETTINGS_WALLET_KEY));
  const { entityKey } = await writeCapture(wallet, row);
  await eventually(() => arkivPublic(LOCAL).getEntity(entityKey), `entity ${entityKey}`);
  return { url: c.url, urlHash: c.urlHash, evidence: c.evidence, evidenceBytes: c.evidenceBytes, signedAt: c.signedAt, row, entityKey };
}

const fakeRef = (): Hex => `0x${randomBytes(32).toString('hex')}`;

const check = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => page.locator(`[data-check="${id}"]`);
const status = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => check(page, id).locator('[data-status]');
const verdict = (page: Page): Locator => page.locator('[data-verdict]');
const capturePage = (key: Hex) => `${APP}/#/c/${key}`;
const SETTINGS = `${APP}/#/settings`;

const saveButton = (page: Page) => page.getByRole('button', { name: 'Save settings' });
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), SETTINGS_KEY);

async function openSettings(page: Page): Promise<void> {
  await page.goto(SETTINGS);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
}

/** Serves `bytes` at /bytes/<ref> on the default download gateway, as a public gateway would. */
async function serveAt(page: Page, ref: Hex, bytes: Uint8Array): Promise<void> {
  await page.route(new RegExp(`/bytes/${ref.slice(2)}$`), (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' },
      body: Buffer.from(bytes),
    }),
  );
}

test.describe('@p3 settings web', () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    expect(privateKeyToAccount(SETTINGS_WALLET_KEY).address).toBe(SETTINGS_WALLET_ADDRESS);
    await ensureArkivGas();
    gatewayBatch = await buyNodeBatch();
    gateway = await startGateway(gatewayBatch);
    const a = await capture();
    const ref = await uploadFree(a.evidenceBytes, gateway.url);
    free = await publish(a, { batchId: ZERO_BATCH, evidenceRef: ref });
    const b = await capture();
    const refB = await uploadFree(b.evidenceBytes, gateway.url);
    other = await publish(b, { batchId: ZERO_BATCH, evidenceRef: refB });
  });

  test.afterAll(async () => {
    gateway?.server.closeAllConnections();
    gateway?.server.close();
  });

  // The local Arkiv node sends no CORS headers; see fixtures/localCors.ts.
  test.beforeEach(async ({ page }) => {
    await allowLocalArkiv(page);
  });
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('@p3 settings the fixture is a free-mode capture that is really on Swarm', async () => {
    expect(free.row.batchId).toBe(ZERO_BATCH);
    const got = await fetch(`${NODE_DOWNLOAD}/bytes/${free.row.evidenceRef.slice(2)}`);
    expect(got.status).toBe(200);
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(free.evidenceBytes))).toBe(true);
    // The local node's reference is the local root; a public gateway's can differ (over 4 KB), see below.
    expect(free.row.evidenceRef.slice(2)).toBe(await swarmRootOf(free.evidenceBytes));
  });

  test('@p3 settings changing the pinned witness turns C into a warning on the capture detail', async ({ page }) => {
    await page.goto(capturePage(free.entityKey));
    await expect(status(page, 'C')).toHaveAttribute('data-status', 'pass');
    await expect(check(page, 'C')).toContainText(`Signed by Recall Witness (`);
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');

    // Remove the only pinned witness and save.
    await openSettings(page);
    const list = page.getByRole('list', { name: 'Trusted witnesses' });
    await expect(list).toContainText('Recall Witness (default)');
    await expect(list).toContainText('0x3C44');
    await page.getByRole('button', { name: /^Remove Recall Witness/ }).click();
    await expect(page.getByText('No trusted witnesses.')).toBeVisible();
    await expect(page.getByText('You have changes that are not saved yet.')).toBeVisible();
    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    await expect(page.getByText('You have changes that are not saved yet.')).toHaveCount(0);

    // The next view of the same capture: a valid signature, but not from a trusted witness. Never green.
    await page.goto(capturePage(free.entityKey));
    await expect(status(page, 'C')).toHaveAttribute('data-status', 'warn');
    await expect(check(page, 'C')).toContainText(`Signed by an unknown witness ${DEVNET_WITNESS_ADDRESS}`);
    await expect(page.getByText('Witness settings')).toBeVisible();
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'warn');
    await expect(verdict(page)).toHaveText("Valid signature, but from a witness you haven't trusted.");
    await expect(page.getByText(/^Checks passed/)).toHaveCount(0);

    // The timeline hides it behind "Show unverified" with the reason.
    await page.goto(`${APP}/#/u/${free.urlHash}`);
    await expect(page.getByRole('switch', { name: /Show unverified \(1\)/ })).toBeVisible();
    await page.getByRole('switch', { name: /Show unverified/ }).click();
    await expect(page.getByText('Unknown witness').first()).toBeVisible();

    // Pin it again under another label (lower-case input is accepted and shown checksummed).
    await openSettings(page);
    await page.getByLabel('Witness address (0x…)').fill(DEVNET_WITNESS_ADDRESS.toLowerCase());
    await page.getByLabel('Label', { exact: true }).fill('Neighbour witness');
    await page.getByRole('button', { name: 'Add witness' }).click();
    await expect(page.getByRole('list', { name: 'Trusted witnesses' })).toContainText('Neighbour witness');
    await saveButton(page).click();
    await page.goto(capturePage(free.entityKey));
    await expect(status(page, 'C')).toHaveAttribute('data-status', 'pass');
    await expect(check(page, 'C')).toContainText('Signed by Neighbour witness (');
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  });

  test('@p3 settings changing the download gateway is used for downloads', async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    const hits: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/bytes/')) hits.push(r.url());
    });
    const ref = free.row.evidenceRef.slice(2);

    // Default: the evidence comes from the default gateway.
    await page.goto(capturePage(free.entityKey));
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((u) => u === `${NODE_DOWNLOAD}/bytes/${ref}`)).toBe(true);

    // Another gateway (the upload node's API also serves /bytes): the next downloads go there only.
    await openSettings(page);
    const gateways = page.getByLabel('Swarm download gateway');
    await expect(gateways).toHaveValue(NODE_DOWNLOAD);
    await gateways.fill(NODE);
    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    hits.length = 0;
    await page.goto(capturePage(free.entityKey));
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((u) => u === `${NODE}/bytes/${ref}`)).toBe(true);

    // The timeline reads the same setting.
    hits.length = 0;
    await page.goto(`${APP}/#/u/${free.urlHash}`);
    await expect(page.getByText('Version 1', { exact: false }).first()).toBeVisible();
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((u) => u === `${NODE}/bytes/${ref}`)).toBe(true);

    // Several gateways (one per line) are tried in order: the first that fails is skipped.
    await openSettings(page);
    await page.getByLabel('Swarm download gateway').fill(`http://localhost:1/nope\n${NODE_DOWNLOAD}`);
    await saveButton(page).click();
    hits.length = 0;
    await page.goto(capturePage(free.entityKey));
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
    expect(hits.some((u) => u.startsWith('http://localhost:1/'))).toBe(true);
    expect(hits.some((u) => u === `${NODE_DOWNLOAD}/bytes/${ref}`)).toBe(true);

    // Reset to default brings the default back.
    await openSettings(page);
    await page.getByRole('button', { name: 'Reset to default for Swarm download gateway' }).click();
    await expect(page.getByLabel('Swarm download gateway')).toHaveValue(NODE_DOWNLOAD);
    await saveButton(page).click();
    expect(JSON.parse((await stored(page)) ?? '{}')).toEqual({});
  });

  test('@p3 settings the Arkiv and Gnosis endpoints come from Settings', async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    // The same nodes under another host name, so the requests are told apart.
    const ALLOW = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    for (const re of [/^http:\/\/127\.0\.0\.1:8545\//, /^http:\/\/127\.0\.0\.1:9545\//]) {
      await page.route(re, async (route) => {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: ALLOW });
        const res = await route.fetch();
        await route.fulfill({ response: res, headers: { ...res.headers(), ...ALLOW } });
      });
    }
    await openSettings(page);
    await page.getByLabel('Arkiv RPC URL').fill('http://127.0.0.1:8545');
    await page.getByLabel('Gnosis RPC URL').fill('http://127.0.0.1:9545');
    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(capturePage(free.entityKey));
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
    expect(urls.some((u) => u.startsWith('http://127.0.0.1:8545'))).toBe(true);
    expect(urls.some((u) => u.startsWith('http://localhost:8545'))).toBe(false);

    urls.length = 0;
    await page.goto(`${APP}/#/storage`);
    await expect.poll(() => urls.some((u) => u.startsWith('http://127.0.0.1:9545')), { timeout: 15_000 }).toBe(true);
    expect(urls.some((u) => u.startsWith('http://localhost:9545'))).toBe(false);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
  });

  test('@p3 settings free-mode evidence is checked without the Swarm root only for the zero batch id', async ({ page }) => {
    // A public gateway's /bytes reference can differ from the locally computed Swarm root (LIVE FINDING,
    // files over 4 KB). Stand in for it: records whose reference is NOT the root of their evidence.
    const gatewayRef = fakeRef();
    const freeGw = await publish(await capture(), { batchId: ZERO_BATCH, evidenceRef: gatewayRef });
    expect(gatewayRef.slice(2)).not.toBe(await swarmRootOf(freeGw.evidenceBytes));

    // (a) A free-mode record passes through the R13 path: checks A-C plus the facts cross-check.
    await serveAt(page, gatewayRef, freeGw.evidenceBytes);
    await page.goto(capturePage(freeGw.entityKey));
    for (const id of ['A', 'B', 'C'] as const) {
      await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass');
    }
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
    await expect(page.locator('.exhibit')).toContainText(freeGw.url);
    // Keep-alive for Swarm cannot be offered (no batch): E is never a pass here.
    await expect(status(page, 'E')).not.toHaveAttribute('data-status', 'pass');
    await page.unroute(new RegExp(`/bytes/${gatewayRef.slice(2)}$`));

    // (b) The same situation with a REAL batch id keeps the root check: the bytes are discarded.
    const refB = fakeRef();
    const stamped = await publish(await capture(), { batchId: gatewayBatch, evidenceRef: refB });
    await serveAt(page, refB, stamped.evidenceBytes);
    await page.goto(capturePage(stamped.entityKey));
    await expect(status(page, 'A')).toHaveAttribute('data-status', 'unavailable');
    await expect(check(page, 'A')).toContainText('do not match the Swarm reference');
    await expect(verdict(page)).not.toHaveAttribute('data-verdict', 'pass');
    await expect(page.getByText(/^Checks passed/)).toHaveCount(0);
    await page.unroute(new RegExp(`/bytes/${refB.slice(2)}$`));

    // (c) Free mode does not mean "anything goes": genuine evidence of ANOTHER capture under this
    // record fails the facts cross-check (R13), so it is not presented as this record's capture.
    const refC = fakeRef();
    const swapped = await publish(await capture(), { batchId: ZERO_BATCH, evidenceRef: refC });
    await serveAt(page, refC, other.evidenceBytes);
    await page.goto(capturePage(swapped.entityKey));
    await expect(page.getByText(/disagree about the/)).toBeVisible();
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'fail');
    await expect(page.getByText(/^Checks passed/)).toHaveCount(0);
    await expect(page.locator('.exhibit')).toHaveCount(0);
    await page.unroute(new RegExp(`/bytes/${refC.slice(2)}$`));

    // (d) Changed bytes fail check A even in free mode.
    const refD = fakeRef();
    const tampered = await publish(await capture(), { batchId: ZERO_BATCH, evidenceRef: refD });
    await serveAt(page, refD, tamperEvidence(tampered.evidence));
    await page.goto(capturePage(tampered.entityKey));
    await expect(status(page, 'A')).toHaveAttribute('data-status', 'fail');
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'fail');
    await expect(page.getByText(/^Checks passed/)).toHaveCount(0);
    await page.unroute(new RegExp(`/bytes/${refD.slice(2)}$`));

    // (e) The timeline uses the same rules: the gateway-style free record is listed as verified,
    // and the one under a real batch id with a bad reference is not.
    await serveAt(page, gatewayRef, freeGw.evidenceBytes);
    await serveAt(page, refB, stamped.evidenceBytes);
    await page.goto(`${APP}/#/u/${freeGw.urlHash}`);
    await expect(page.getByText('Version 1').first()).toBeVisible();
    await page.goto(`${APP}/#/u/${stamped.urlHash}`);
    await expect(page.getByText('No captures of this page yet.').or(page.getByRole('switch', { name: /Show unverified \(1\)/ }))).toBeVisible();
    await expect(page.getByText('Version 1')).toHaveCount(0);
  });

  test('@p3 settings invalid inputs are rejected with the design brief copy', async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    await openSettings(page);

    const ADDRESS = 'Enter a 0x address (42 characters).';
    const URL_COPY = 'Enter a full address starting with https://';
    const address = page.getByLabel('Witness address (0x…)');
    const label = page.getByLabel('Label', { exact: true });
    const add = page.getByRole('button', { name: 'Add witness' });

    // Witness address: validated on blur, error below the field.
    for (const bad of ['0x1234', 'vitalik.eth', DEVNET_WITNESS_ADDRESS.slice(2), `${DEVNET_WITNESS_ADDRESS}0`, DEVNET_WITNESS_ADDRESS.replace('3C44', '3c44')]) {
      await address.fill(bad);
      await address.blur();
      await expect(page.getByText(ADDRESS), bad).toBeVisible();
      await expect(address).toHaveAttribute('aria-invalid', 'true');
      await expect(address).toHaveAccessibleDescription(ADDRESS);
    }
    await address.fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await address.blur();
    await expect(page.getByText(ADDRESS)).toHaveCount(0);

    // A label is needed, and a witness already in the list is not added twice.
    await add.click();
    await expect(page.getByText('Enter a label for this witness.')).toBeVisible();
    await address.fill(DEVNET_WITNESS_ADDRESS);
    await label.fill('Same again');
    await add.click();
    await expect(page.getByText('That witness is already in the list.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Trusted witnesses' }).getByRole('listitem')).toHaveCount(1);
    // Clicking Add with a bad address does not add anything either.
    await address.fill('0xnope');
    await add.click();
    await expect(page.getByText(ADDRESS)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Trusted witnesses' }).getByRole('listitem')).toHaveCount(1);

    // Endpoints: https only (plain http for localhost / 127.0.0.1), never javascript: or data:.
    const rpc = page.getByLabel('Arkiv RPC URL');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://example.org', 'rpc.example.org', 'https://user:pw@rpc.example.org', 'file:///etc/passwd']) {
      await rpc.fill(bad);
      await rpc.blur();
      await expect(page.getByText(URL_COPY).first(), bad).toBeVisible();
      await expect(rpc).toHaveAttribute('aria-invalid', 'true');
    }
    for (const ok of ['https://rpc.example.org', 'http://localhost:8545', 'http://127.0.0.1:8545']) {
      await rpc.fill(ok);
      await rpc.blur();
      await expect(rpc, ok).not.toHaveAttribute('aria-invalid', 'true');
    }
    await page.getByLabel('Gnosis RPC URL').fill('http://gnosis.example.org');
    await page.getByLabel('Swarm upload gateway').fill('data:text/plain,hi');
    await page.getByLabel('Swarm download gateway').fill('https://ok.example.org\njavascript:alert(1)');
    await page.getByLabel('Extension ID').fill('not-an-id');
    await page.getByLabel('Arkiv access key').fill('two words');
    await saveButton(page).click();
    // Nothing was saved, every bad field says why, and focus went to the first one.
    await expect(page.getByText('Settings saved')).toHaveCount(0);
    expect(await stored(page)).toBeNull();
    await expect(page.getByText(URL_COPY)).toHaveCount(3);
    await expect(page.getByText('Enter the 32-letter ID shown on chrome://extensions.')).toBeVisible();
    await expect(page.getByText('Paste only the key, without spaces and not as an address.')).toBeVisible();
    // (the Arkiv access key comes first on the page).
    await expect(page.getByLabel('Arkiv access key')).toBeFocused();

    // Fix them all: it saves.
    await page.getByLabel('Gnosis RPC URL').fill('https://gnosis.example.org');
    await page.getByLabel('Swarm upload gateway').fill('https://upload.example.org');
    await page.getByLabel('Swarm download gateway').fill('https://ok.example.org\nhttps://two.example.org');
    await page.getByLabel('Extension ID').fill('a'.repeat(32));
    await page.getByLabel('Arkiv access key').fill('abc123');
    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
  });

  test('@p3 settings are saved in this browser and persist across reloads', async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    await openSettings(page);
    await expect(page.getByText('Saved in this browser only.')).toBeVisible();

    const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    await page.getByLabel('Gnosis RPC URL').fill('https://gnosis.example.org');
    await page.getByLabel('Swarm upload gateway').fill('http://127.0.0.1:1633');
    await page.getByLabel('Extension ID').fill('b'.repeat(32));
    await page.getByLabel('Witness address (0x…)').fill(OTHER.toLowerCase());
    await page.getByLabel('Label', { exact: true }).fill('Neighbour');
    await page.getByRole('button', { name: 'Add witness' }).click();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    // Only what differs from the defaults is stored (and it is plain JSON in this browser only).
    const raw = JSON.parse((await stored(page))!) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['extensionId', 'gnosisRpcUrl', 'pinnedWitnesses', 'theme', 'uploadUrl']);
    expect(raw.pinnedWitnesses).toEqual([
      { address: DEVNET_WITNESS_ADDRESS, label: 'Recall Witness' },
      { address: OTHER, label: 'Neighbour' },
    ]);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByLabel('Gnosis RPC URL')).toHaveValue('https://gnosis.example.org');
    await expect(page.getByLabel('Swarm upload gateway')).toHaveValue('http://127.0.0.1:1633');
    await expect(page.getByLabel('Extension ID')).toHaveValue('b'.repeat(32));
    await expect(page.getByLabel('Arkiv RPC URL')).toHaveValue(LOCAL.arkiv.rpcUrl);
    const list = page.getByRole('list', { name: 'Trusted witnesses' });
    await expect(list).toContainText('Recall Witness (default)');
    await expect(list).toContainText('Neighbour');
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // The header's theme menu follows the saved theme.
    await expect(page.locator('.theme-menu select')).toHaveValue('dark');

    // "Reset to default" on one field, then save: that field is no longer stored.
    await page.getByRole('button', { name: 'Reset to default for Gnosis RPC URL' }).click();
    await expect(page.getByLabel('Gnosis RPC URL')).toHaveValue(LOCAL.gnosis.rpcUrl);
    await saveButton(page).click();
    const after = JSON.parse((await stored(page))!) as Record<string, unknown>;
    expect(after.gnosisRpcUrl).toBeUndefined();
    expect(after.uploadUrl).toBe('http://127.0.0.1:1633');
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
  });

  test('@p3 settings render with the defaults when the browser blocks storage', async ({ page }) => {
    await page.addInitScript(() => {
      const boom = () => {
        throw new DOMException('blocked', 'SecurityError');
      };
      Storage.prototype.getItem = boom;
      Storage.prototype.setItem = boom;
      Storage.prototype.removeItem = boom;
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(SETTINGS);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByLabel('Arkiv RPC URL')).toHaveValue(LOCAL.arkiv.rpcUrl);
    await expect(page.getByLabel('Swarm download gateway')).toHaveValue(NODE_DOWNLOAD);
    await expect(page.getByRole('list', { name: 'Trusted witnesses' })).toContainText('Recall Witness (default)');
    await page.getByLabel('Gnosis RPC URL').fill('https://gnosis.example.org');
    await saveButton(page).click();
    // It cannot be stored: say so instead of pretending.
    await expect(page.getByText('Applied for this visit only')).toBeVisible();
    // The rest of the app still works with what the storage-less page knows.
    await page.goto(`${APP}/#/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Recall' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('@p3 settings Reset all asks for confirmation first', async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    await openSettings(page);
    await page.getByLabel('Gnosis RPC URL').fill('https://gnosis.example.org');
    await page.getByRole('radio', { name: 'Light' }).check();
    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    const resetAll = page.getByRole('button', { name: 'Reset all', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Reset all settings?' });

    // Asking changes nothing. Cancel closes it and focus returns to the button.
    await resetAll.click();
    await expect(dialog).toBeVisible();
    expect(await stored(page)).not.toBeNull();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(resetAll).toBeFocused();
    await expect(page.getByLabel('Gnosis RPC URL')).toHaveValue('https://gnosis.example.org');
    expect(await stored(page)).not.toBeNull();

    // Esc closes it too, with the same focus return.
    await resetAll.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(resetAll).toBeFocused();
    await expect(page.getByLabel('Gnosis RPC URL')).toHaveValue('https://gnosis.example.org');

    // Confirming resets everything: values, theme and the stored copy.
    await resetAll.click();
    await dialog.getByRole('button', { name: 'Reset all' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel('Gnosis RPC URL')).toHaveValue(LOCAL.gnosis.rpcUrl);
    await expect(page.getByRole('radio', { name: 'System' })).toBeChecked();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(await stored(page)).toBeNull();
  });

  test('@p3 settings the Arkiv access key is a secret field and is never shown, logged or put in a URL', async ({ page }) => {
    await page.goto(`${APP}/#/`);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push(e.message));
    const KEY = 'sk-test-0123456789abcdef';
    await openSettings(page);

    const key = page.getByLabel('Arkiv access key');
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveAttribute('autocomplete', 'new-password');
    await key.fill(KEY);
    await expect(key).toHaveValue(KEY);
    // Show / Hide toggles the field (and says what it is doing to assistive tech).
    const toggle = page.getByRole('button', { name: /^Show/ });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(key).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: /^Hide/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /^Hide/ }).click();
    await expect(key).toHaveAttribute('type', 'password');

    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    // It is stored under its own field, never inside a URL, and the page URL does not carry it.
    const raw = JSON.parse((await stored(page))!) as Record<string, string>;
    expect(raw.arkivAccessKey).toBe(KEY);
    for (const [k, v] of Object.entries(raw)) {
      if (k !== 'arkivAccessKey') expect(String(v), k).not.toContain(KEY);
    }
    expect(page.url()).not.toContain(KEY);
    // No text of the page shows the key while it is hidden.
    await page.reload();
    await expect(page.getByLabel('Arkiv access key')).toHaveAttribute('type', 'password');
    expect(await page.locator('body').innerText()).not.toContain(KEY);
    // Nothing logged it.
    expect(logs.filter((l) => l.includes(KEY))).toEqual([]);

    // Reset to default clears the override (an empty value means "use the default").
    await page.getByRole('button', { name: 'Reset to default for Arkiv access key' }).click();
    await expect(page.getByLabel('Arkiv access key')).toHaveValue('');
    await saveButton(page).click();
    expect(JSON.parse((await stored(page)) ?? '{}')).toEqual({});
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
  });

  test('@p3 settings the extension status says Connected with its version, or Not connected', async ({ page }) => {
    await page.addInitScript({
      content: `(() => {
        window.__extAnswer = 'ok';
        window.chrome = window.chrome || {};
        window.chrome.runtime = {
          lastError: undefined,
          sendMessage(extId, msg, cb) {
            setTimeout(() => {
              if (window.__extAnswer === 'ok' && msg.type === 'recall.getStampAddress') {
                cb({ address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', version: '1.2.3' });
              } else if (window.__extAnswer === 'old') {
                cb({ address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
              } else {
                window.chrome.runtime.lastError = { message: 'Could not establish connection.' };
                cb(undefined);
                window.chrome.runtime.lastError = undefined;
              }
            }, 0);
          },
        };
      })();`,
    });
    await page.goto(`${APP}/#/`);
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    await openSettings(page);
    const statusLine = page.getByTestId('extension-status');
    await expect(statusLine).toHaveText('');

    await page.getByLabel('Extension ID').fill('a'.repeat(32));
    await saveButton(page).click();
    await expect(statusLine).toContainText('Connected · v1.2.3');

    await page.evaluate(() => ((window as unknown as { __extAnswer: string }).__extAnswer = 'old'));
    await saveButton(page).click();
    await expect(statusLine).toHaveText(/Connected$/);

    await page.evaluate(() => ((window as unknown as { __extAnswer: string }).__extAnswer = 'down'));
    await saveButton(page).click();
    await expect(statusLine).toContainText('Not connected. Check the ID matches chrome://extensions.');
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
  });
});
