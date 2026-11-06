import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, createWalletClient, erc20Abi, http, parseEther, sha256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { canonicalUrl, encodeEvidence, parseResponse, urlHash as hashUrl, type EvidenceFile } from '../../packages/evidence/src/index';
import {
  LOCAL,
  XBZZ,
  arkivPublic,
  arkivWallet,
  buyBatch,
  swarmRootOf,
  uploadFree,
  waitBatchUsable,
  writeCapture,
  type CaptureRow,
} from '../../packages/net/src/index';
import { BEE_COMPOSE_FAUCET_KEY, DEVNET_WITNESS_ADDRESS, DEV_PRIVATE_KEY } from '../fixtures/keys';
import { launchWithExtension, type ExtensionSession } from '../fixtures/extension';
import { allowLocalArkiv } from '../fixtures/localCors';
import { installMockWallet } from '../fixtures/mockWallet';
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

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined> };

/**
 * A gateway stand-in. `POST /bytes` goes to the local Bee node under the node's own batch (what a
 * public gateway's free /bytes endpoint does) and `GET /bytes/<ref>` is served from the node.
 * With `rewriteRefs` the reference it answers is NOT the Swarm root of the bytes (the live finding:
 * a public gateway's reference differs from the local root for files over 4 KB); it still serves
 * the bytes under that reference. `seen` records every request it receives.
 */
async function startGateway(
  batchId: Hex,
  opts: { rewriteRefs?: boolean } = {},
): Promise<{ server: Server; url: string; seen: Seen[]; realRef(fake: string): string | undefined }> {
  const seen: Seen[] = [];
  const real = new Map<string, string>(); // reference answered -> the node's real reference
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers } });
    const target = new URL(NODE);
    const get = /^\/bytes\/([0-9a-f]{64})$/.exec(req.url ?? '');
    if (req.method === 'GET' && get) {
      const ref = real.get(get[1]!) ?? get[1]!;
      const up = httpRequest({ host: target.hostname, port: target.port, path: `/bytes/${ref}`, method: 'GET' }, (back) => {
        res.writeHead(back.statusCode ?? 502, { ...cors, 'content-type': 'application/octet-stream' });
        back.pipe(res);
      });
      up.on('error', () => res.writeHead(502, cors).end());
      return void up.end();
    }
    if (req.method !== 'POST' || req.url !== '/bytes') return void res.writeHead(404, cors).end();
    const up = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: '/bytes',
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'swarm-postage-batch-id': batchId.slice(2),
          // The gateway answers once the chunks are pushed, so another node can serve them at once.
          'swarm-deferred-upload': 'false',
        },
      },
      (back) => {
        const chunks: Buffer[] = [];
        back.on('data', (c: Buffer) => chunks.push(c));
        back.on('end', () => {
          let body = Buffer.concat(chunks);
          if (opts.rewriteRefs && back.statusCode === 201) {
            const { reference } = JSON.parse(body.toString()) as { reference: string };
            const fake = randomBytes(32).toString('hex');
            real.set(fake, reference);
            body = Buffer.from(JSON.stringify({ reference: fake }));
          }
          res.writeHead(back.statusCode ?? 502, { ...cors, 'content-type': 'application/json' }).end(body);
        });
      },
    );
    up.on('error', () => res.writeHead(502, cors).end());
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, realRef: (f) => real.get(f) };
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
let gateway: Awaited<ReturnType<typeof startGateway>>;
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

    // Pin it again (lower-case input is accepted and shown checksummed). It is the built-in
    // witness's address, so it is named by code whatever label is typed, never by the person (R38).
    await openSettings(page);
    await page.getByLabel('Witness address (0x…)').fill(DEVNET_WITNESS_ADDRESS.toLowerCase());
    await page.getByLabel('Label', { exact: true }).fill('Neighbour witness');
    await page.getByRole('button', { name: 'Add witness' }).click();
    const pinned = page.getByRole('list', { name: 'Trusted witnesses' });
    await expect(pinned).toContainText('Recall Witness (default)');
    await expect(pinned).not.toContainText('Neighbour witness');
    await saveButton(page).click();
    await page.goto(capturePage(free.entityKey));
    await expect(status(page, 'C')).toHaveAttribute('data-status', 'pass');
    await expect(check(page, 'C')).toContainText('Signed by Recall Witness (');
    await expect(check(page, 'C')).toContainText('which is in your trusted list.');
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

  test('@p3 settings a witness planted in storage is ignored on a shared gateway address', async ({ page }) => {
    // The attack (R38): on https://<gateway>/bzz/<ref>/ every Swarm site shares one origin, so any
    // other site there can write this app's localStorage. It plants its own witness, labelled as
    // the built-in one, and swaps the endpoints. Evidence signed by the attacker must not pass.
    const attackerKey = generatePrivateKey();
    const attacker = privateKeyToAccount(attackerKey).address;
    const forged = await capture(attackerKey);
    const forgedRef = await uploadFree(forged.evidenceBytes, gateway.url);
    const record = await publish(forged, { batchId: ZERO_BATCH, evidenceRef: forgedRef, witness: attacker });

    const planted = {
      pinnedWitnesses: [{ address: attacker, label: 'Recall Witness (default)' }],
      arkivRpcUrl: 'https://evil.example/arkiv',
      arkivAccessKey: 'planted-key',
      downloadUrls: ['http://127.0.0.1:1/evil'],
      uploadUrl: 'https://evil.example/up',
      gnosisRpcUrl: 'https://evil.example/gnosis',
      extensionId: 'a'.repeat(32),
      theme: 'dark',
    };
    await page.goto(`${APP}/#/`);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SETTINGS_KEY, JSON.stringify(planted)] as const);

    // The app served the way a gateway serves it: under /bzz/<ref>/ on the same origin.
    await page.route(/^http:\/\/localhost:5173\/bzz\/planted-ref\/(\?.*)?$/, async (route) => {
      const index = await route.fetch({ url: `${APP}/` });
      await route.fulfill({ response: index });
    });
    const requested: string[] = [];
    page.on('request', (r) => requested.push(r.url()));
    const SHARED = `${APP}/bzz/planted-ref/`;

    // On the shared address: the planted witness does not count. C is a warning, never a pass.
    await page.goto(`${SHARED}#/c/${record.entityKey}`);
    await expect(status(page, 'C')).toHaveAttribute('data-status', 'warn');
    await expect(check(page, 'C')).toContainText(`Signed by an unknown witness ${attacker}`);
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'warn');
    await expect(page.getByText(/^Checks passed/)).toHaveCount(0);
    // None of the planted endpoints was used.
    expect(requested.filter((u) => /evil/.test(u) || u.startsWith('http://127.0.0.1:1/'))).toEqual([]);

    // Settings there: the built-in witness only, nothing planted shown, nothing can be saved.
    await page.goto(`${SHARED}#/settings`);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(
      page.getByText("Settings can't be changed on a shared gateway address. Open the app from its own address (bzz.link or GitHub Pages) to change them."),
    ).toBeVisible();
    const list = page.getByRole('list', { name: 'Trusted witnesses' });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list).toContainText('Recall Witness (default)');
    await expect(list).not.toContainText(attacker.slice(0, 8));
    await expect(page.getByLabel('Gnosis RPC URL')).toHaveValue(LOCAL.gnosis.rpcUrl);
    await expect(page.getByLabel('Swarm download gateway')).toHaveValue(NODE_DOWNLOAD);
    await expect(page.getByLabel('Extension ID')).toHaveValue('');
    await expect(page.getByLabel('Arkiv access key')).toHaveValue('');
    await expect(saveButton(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Reset all', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add witness' })).toBeDisabled();
    await expect(page.getByLabel('Witness address (0x…)')).toBeDisabled();
    // The app is light only: the planted "dark" changes nothing, and there is no theme chooser.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('radio', { name: 'Dark' })).toHaveCount(0);

    // The same evidence on the app's own address, with the witness really added by the person:
    // it passes, and says that the trust came from this browser (never worded like the built-in one).
    await page.goto(`${APP}/#/`);
    await page.evaluate(
      ([k, v]) => localStorage.setItem(k, v),
      [SETTINGS_KEY, JSON.stringify({ pinnedWitnesses: [{ address: attacker, label: 'Operator X' }] })] as const,
    );
    await page.goto(`${APP}/#/c/${record.entityKey}`);
    await expect(status(page, 'C')).toHaveAttribute('data-status', 'pass');
    await expect(check(page, 'C')).toContainText(`Signed by a witness added in this browser: Operator X (${attacker.slice(0, 6)}`);
    await expect(check(page, 'C')).not.toContainText('which is in your trusted list');
    await expect(page.locator('.exhibit')).toContainText('Operator X (added in this browser)');
    await page.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
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
    // Only the built-in witness may be called "default" (R38): a label that says so is refused.
    await address.fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    for (const imitation of ['Recall Witness (default)', 'default', 'My DEFAULT witness', 'd\u0435fault', 'defaul\u200bt', 'ＤＥＦＡＵＬＴ']) {
      await label.fill(imitation);
      await add.click();
      await expect(page.getByText('That label can\'t include the word "default". It is kept for the built-in witness.'), imitation).toBeVisible();
      await expect(page.getByRole('list', { name: 'Trusted witnesses' }).getByRole('listitem')).toHaveCount(1);
    }
    await label.fill('');
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
    await saveButton(page).click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    // Only what differs from the defaults is stored (and it is plain JSON in this browser only).
    const raw = JSON.parse((await stored(page))!) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['extensionId', 'gnosisRpcUrl', 'pinnedWitnesses', 'uploadUrl']);
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
    // Light only: no theme chooser on the page or in the header.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('radio', { name: 'Dark' })).toHaveCount(0);
    await expect(page.locator('.theme-menu')).toHaveCount(0);

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

    // Confirming resets everything: the values and the stored copy.
    await resetAll.click();
    await dialog.getByRole('button', { name: 'Reset all' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel('Gnosis RPC URL')).toHaveValue(LOCAL.gnosis.rpcUrl);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
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
    await expect(page.getByText('Optional. A key can raise the limits of the Arkiv RPC.')).toBeVisible();
    await key.fill(KEY);
    await expect(key).toHaveValue(KEY);
    await expect(page.getByText('Your key is used for the Arkiv RPC.')).toBeVisible();
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

const gnosisChain = { ...gnosis, rpcUrls: { default: { http: [LOCAL.gnosis.rpcUrl] } } };

/** Gives the settings wallet xBZZ and xDAI on the Gnosis fork (from the faucet, retrying a lost nonce race). */
async function fundWallet9(): Promise<void> {
  const pub = createPublicClient({ transport: http(LOCAL.gnosis.rpcUrl) });
  const faucet = privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY);
  const wallet = createWalletClient({ account: faucet, chain: gnosisChain, transport: http(LOCAL.gnosis.rpcUrl) });
  const send = async (go: (nonce: number) => Promise<Hex>) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const nonce = await pub.getTransactionCount({ address: faucet.address, blockTag: 'pending' });
      try {
        await pub.waitForTransactionReceipt({ hash: await go(nonce) });
        return;
      } catch (e) {
        if (!/nonce|already known|underpriced/i.test(String(e))) throw e;
        await sleep(200 + Math.random() * 300);
      }
    }
    throw new Error('could not fund the settings wallet');
  };
  if ((await pub.getBalance({ address: SETTINGS_WALLET_ADDRESS })) < parseEther('0.5')) {
    await send((nonce) => wallet.sendTransaction({ to: SETTINGS_WALLET_ADDRESS, value: parseEther('1'), nonce }));
  }
  const want = 5n * 10n ** 15n; // 0.5 xBZZ: a depth-17 batch for 10 days costs about a tenth of it
  const have = await pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [SETTINGS_WALLET_ADDRESS] });
  if (have < want) {
    await send((nonce) =>
      wallet.writeContract({ address: XBZZ, abi: erc20Abi, functionName: 'transfer', args: [SETTINGS_WALLET_ADDRESS, want - have], nonce }),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The extension's settings (popup panel): upload mode, trusted witnesses, endpoints. Needs the dev
// build of the extension (see e2e/fixtures/extension.ts) and the devnet witness on :7047.
// ---------------------------------------------------------------------------------------------

const POPUP_PAGE = `https://${NOTICE_HOST}/notice?run=settings-${Math.random().toString(36).slice(2, 8)}`;
const OTHER_WITNESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

let ext: ExtensionSession;

function sw(): Worker {
  const live = ext.context.serviceWorkers().filter((w) => w.url().includes(ext.extensionId));
  return live[live.length - 1] ?? ext.serviceWorker;
}

async function getLocal<T = unknown>(key: string): Promise<T | undefined> {
  return sw().evaluate(async (k) => {
    const s = (globalThis as unknown as { chrome: { storage: { local: { get(k: string): Promise<Record<string, unknown>> } } } }).chrome
      .storage.local;
    return (await s.get(k))[k];
  }, key) as Promise<T | undefined>;
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

type ExtSettings = {
  uploadMode: 'stamped' | 'free';
  pinnedWitnesses: string[];
  witnessUrl?: string;
  appUrl: string;
  arkivRpcUrl: string;
  arkivAccessKey: string;
  uploadUrl: string;
};
const extSettings = () => getLocal<ExtSettings>('recall.settings');

/** Opens the popup on a tab that shows `page`. */
async function openPopup(page = POPUP_PAGE): Promise<{ tab: Page; popup: Page }> {
  const tab = await ext.context.newPage();
  await tab.goto(page);
  const id = await sw().evaluate(async (u) => {
    const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number; url?: string }[]> } } }).chrome
      .tabs;
    return (await tabs.query({})).find((t) => t.url === u)?.id ?? null;
  }, page);
  expect(id, `a tab showing ${page}`).not.toBeNull();
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${id}`);
  return { tab, popup };
}

const openPanel = async (popup: Page) => {
  await popup.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(popup.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
};

test.describe('@p3 settings extension', () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    ext = await launchWithExtension({ dev: true });
  });
  test.afterAll(async () => {
    await ext?.context.close();
  });
  test.beforeEach(async () => {
    // Every test starts from the dev defaults, with the devnet witness pinned.
    await setLocal('recall.settings', {
      net: 'local',
      witnessUrl: 'http://localhost:7047',
      pinnedWitnesses: [DEVNET_WITNESS_ADDRESS],
      appUrl: APP,
    });
  });

  test('@p3 settings extension popup: switching the upload mode persists', async () => {
    const { popup } = await openPopup();
    await openPanel(popup);
    const stamped = popup.getByRole('radio', { name: /Prepaid storage/ });
    const freeMode = popup.getByRole('radio', { name: /Gateway free storage/ });
    await expect(stamped).toBeChecked();
    await expect(popup.getByText('Saved in this browser only.')).toBeVisible();
    // What free mode means is said next to the choice.
    await expect(popup.getByText(/no batch is taken from your pool/i)).toBeVisible();

    await freeMode.check();
    await popup.getByRole('button', { name: 'Save settings' }).click();
    await expect(popup.getByText('Settings saved')).toBeVisible();
    expect((await extSettings())?.uploadMode).toBe('free');

    // A new popup (a later visit) reads it back.
    await popup.close();
    const again = await openPopup();
    await openPanel(again.popup);
    await expect(again.popup.getByRole('radio', { name: /Gateway free storage/ })).toBeChecked();

    // And back.
    await again.popup.getByRole('radio', { name: /Prepaid storage/ }).check();
    await again.popup.getByRole('button', { name: 'Save settings' }).click();
    await expect(again.popup.getByText('Settings saved')).toBeVisible();
    expect((await extSettings())?.uploadMode).toBe('stamped');
  });

  test('@p3 settings extension popup: an invalid witness address or URL is rejected with the brief copy', async () => {
    const { popup } = await openPopup();
    await openPanel(popup);
    const ADDRESS = 'Enter a 0x address (42 characters).';
    const URL_COPY = 'Enter a full address starting with https://';
    const address = popup.getByLabel('Witness address (0x…)');
    const list = popup.getByRole('list', { name: 'Trusted witnesses' });
    await expect(list.getByRole('listitem')).toHaveCount(1);

    // 0x7099...: flipping the case of one letter breaks the checksum.
    const wrongChecksum = OTHER_WITNESS.replace('C51812dc', 'c51812dc');
    expect(wrongChecksum).not.toBe(OTHER_WITNESS);
    for (const bad of ['0x1234', 'vitalik.eth', `${OTHER_WITNESS}0`, wrongChecksum]) {
      await address.fill(bad);
      await address.blur();
      await expect(popup.getByText(ADDRESS), bad).toBeVisible();
      await expect(address).toHaveAttribute('aria-invalid', 'true');
      await popup.getByRole('button', { name: 'Add witness' }).click();
      await expect(list.getByRole('listitem')).toHaveCount(1);
    }
    // A witness already in the list is not added twice.
    await address.fill(DEVNET_WITNESS_ADDRESS);
    await popup.getByRole('button', { name: 'Add witness' }).click();
    await expect(popup.getByText('That witness is already in the list.')).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);

    // URLs: https only (plain http for localhost / 127.0.0.1), never javascript: or data:.
    const rpc = popup.getByLabel('Arkiv RPC URL');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'http://example.org', 'rpc.example.org', 'https://u:p@rpc.example.org']) {
      await rpc.fill(bad);
      await rpc.blur();
      await expect(popup.getByText(URL_COPY).first(), bad).toBeVisible();
      await expect(rpc).toHaveAttribute('aria-invalid', 'true');
    }
    await popup.getByLabel('Witness URL').fill('javascript:alert(1)');
    await popup.getByLabel('Arkiv access key').fill('two words');
    const before = await extSettings();
    await popup.getByRole('button', { name: 'Save settings' }).click();
    await expect(popup.getByText('Settings saved')).toHaveCount(0);
    await expect(popup.getByText('Paste only the key, without spaces and not as an address.')).toBeVisible();
    expect(await extSettings()).toEqual(before); // nothing was saved

    // A good address is added to the draft and saved with the rest.
    await rpc.fill('http://127.0.0.1:8545');
    await popup.getByLabel('Witness URL').fill('http://localhost:7047');
    await popup.getByLabel('Arkiv access key').fill('');
    await address.fill(OTHER_WITNESS.toLowerCase());
    await popup.getByRole('button', { name: 'Add witness' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await popup.getByRole('button', { name: 'Save settings' }).click();
    await expect(popup.getByText('Settings saved')).toBeVisible();
    const saved = await extSettings();
    expect(saved?.pinnedWitnesses).toEqual([DEVNET_WITNESS_ADDRESS, OTHER_WITNESS]);
    expect(saved?.arkivRpcUrl).toBe('http://127.0.0.1:8545');
  });

  test('@p3 settings extension popup: changing the pinned witnesses re-runs the witness check', async () => {
    const { popup } = await openPopup();
    await expect(popup.getByText('Witness online')).toBeVisible({ timeout: 20_000 });
    await openPanel(popup);

    // Pin another witness only: the one at the witness URL signs with a key that is no longer pinned.
    await popup.getByLabel('Witness address (0x…)').fill(OTHER_WITNESS);
    await popup.getByRole('button', { name: 'Add witness' }).click();
    await popup.getByRole('button', { name: new RegExp(`^Remove ${DEVNET_WITNESS_ADDRESS}`) }).click();
    await popup.getByRole('button', { name: 'Save settings' }).click();
    await expect(popup.getByText('Settings saved')).toBeVisible();
    await expect(popup.getByText('Witness offline')).toBeVisible({ timeout: 20_000 });
    expect((await extSettings())?.pinnedWitnesses).toEqual([OTHER_WITNESS]);

    // Pin it again: online.
    await popup.getByLabel('Witness address (0x…)').fill(DEVNET_WITNESS_ADDRESS.toLowerCase());
    await popup.getByRole('button', { name: 'Add witness' }).click();
    await popup.getByRole('button', { name: 'Save settings' }).click();
    await expect(popup.getByText('Witness online')).toBeVisible({ timeout: 20_000 });
  });

  test('@p3 settings extension free storage (chosen in the publish tab) uploads without consuming a batch and the record verifies through the R13 path', async () => {
    test.setTimeout(420_000);
    await ensureArkivGas();
    gatewayBatch ??= await buyNodeBatch();
    // A gateway whose references are not the local Swarm root (a public gateway, over 4 KB).
    const gw = await startGateway(gatewayBatch, { rewriteRefs: true });
    try {
      await setLocal('recall.settings', {
        net: 'local',
        witnessUrl: 'http://localhost:7047',
        pinnedWitnesses: [DEVNET_WITNESS_ADDRESS],
        appUrl: APP,
        uploadMode: 'free',
        uploadUrl: gw.url,
      });

      // The web app's page, to talk to the extension like the real app does.
      const app = await ext.context.newPage();
      await allowLocalArkiv(app);
      await app.goto(`${APP}/#/`);
      const api = <T = Record<string, unknown>>(msg: object) =>
        app.evaluate(
          ([id, m]) =>
            new Promise<unknown>((resolve) => {
              const rt = (window as unknown as { chrome?: { runtime?: { sendMessage?: Function; lastError?: { message?: string } } } }).chrome
                ?.runtime;
              if (!rt?.sendMessage) return resolve({ lastError: 'chrome.runtime is not exposed to this page' });
              rt.sendMessage(id, m, (res: unknown) => resolve(res ?? { lastError: rt.lastError?.message ?? 'no answer' }));
            }),
          [ext.extensionId, msg] as const,
        ) as Promise<T>;

      // A real, unused batch in the pool: free mode must leave it alone.
      await fundWallet9();
      const stamp = (await api<{ address: Address; version?: string }>({ type: 'recall.getStampAddress' }));
      expect(stamp.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(stamp.version).toMatch(/^\d+(\.\d+)+/); // the extension says which version it is (Settings shows it)
      const payer = createWalletClient({ account: privateKeyToAccount(SETTINGS_WALLET_KEY), chain: gnosisChain, transport: http(LOCAL.gnosis.rpcUrl) });
      const { batchId: poolBatch } = await buyBatch(payer, { owner: stamp.address, depth: 17, days: 10 });
      const added = await api<{ pool?: { batchId: Hex; used: boolean }[] }>({ type: 'recall.addBatches', batchIds: [poolBatch] });
      expect(added.pool?.map((b) => b.batchId.toLowerCase())).toContain(poolBatch.toLowerCase());
      const poolBefore = await getLocal('recall.pool');
      expect(JSON.stringify(poolBefore)).toContain(poolBatch.toLowerCase().slice(2, 12));

      // A real capture through the real prover and witness.
      const page = `https://${NOTICE_HOST}/notice?run=free-${Math.random().toString(36).slice(2, 10)}`;
      const run = () =>
        sw().evaluate(async (u) => {
          const g = globalThis as unknown as { recall?: { captureForTest?: (url: string) => Promise<unknown> } };
          if (!g.recall?.captureForTest) return { error: 'no recall.captureForTest in this build' };
          return g.recall.captureForTest(u);
        }, page) as Promise<
          | { evidence: EvidenceFile; upload?: { status: string; captureId?: string; evidenceRef?: Hex; batchId?: Hex; error?: string } }
          | { error: string }
        >;
      let result = await run();
      if ('error' in result && /witness busy|too many sessions|did not connect in time|timed out/i.test(result.error)) result = await run();
      if ('error' in result) throw new Error(`capture failed: ${result.error}`);
      const up = result.upload!;
      // Capture first (R44): kept, nothing uploaded yet; the publish tab offers free storage.
      expect(up.status, up.error).toBe('pending');
      expect(await getLocal('recall.pool')).toEqual(poolBefore);
      expect(gw.seen.filter((r) => r.method === 'POST')).toHaveLength(0);

      // The publish tab: the person picks the gateway's free storage (the settings allow it), the
      // extension uploads, the page skips the Swarm reference check for the zero batch id (free
      // mode) and still checks A-C itself, then MetaMask (a mock with a real key) publishes.
      let approval: Page | undefined;
      await expect
        .poll(() => (approval = ext.context.pages().find((p) => p.url().includes(`#/approve/${up.captureId}`))), { timeout: 15_000 })
        .toBeTruthy();
      await installMockWallet(approval!, {
        privateKey: SETTINGS_WALLET_KEY,
        rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
        chainId: 1337,
      });
      await allowLocalArkiv(approval!);
      await approval!.reload();
      await expect(approval!.getByRole('heading', { level: 1 })).toHaveText('Save this capture');
      for (const k of ['A', 'B', 'C']) {
        await expect(approval!.locator(`.approve-check-list [data-check="${k}"] .badge`)).toHaveAttribute('data-status', 'pass');
      }
      await expect(approval!.getByRole('button', { name: 'Upload and publish' })).toBeVisible();
      await approval!.getByRole('button', { name: 'Use free storage instead' }).click();
      // The default download gateway does not hold this gateway's reference: the page says it could
      // not confirm the stored copy, as a warning, and waits (publishing stays possible).
      await expect(approval!.getByRole('heading', { name: 'Stored copy not confirmed' })).toBeVisible({ timeout: 60_000 });
      const pending = await api<{ upload?: { status: string; evidenceRef?: Hex; batchId?: Hex } }>({
        type: 'recall.getPending',
        captureId: up.captureId,
      });
      expect(pending.upload?.status).toBe('uploaded');
      expect(pending.upload?.batchId).toBe(ZERO_BATCH);
      const ref = pending.upload!.evidenceRef!;

      // The pool is exactly as it was, and the gateway got one plain POST /bytes: no stamp, no batch.
      expect(await getLocal('recall.pool')).toEqual(poolBefore);
      const posts = gw.seen.filter((r) => r.method === 'POST');
      expect(posts.map((r) => r.url)).toEqual(['/bytes']);
      expect(posts[0]!.headers['swarm-postage-batch-id']).toBeUndefined();
      expect(posts[0]!.headers['swarm-postage-stamp']).toBeUndefined();
      // This gateway's reference is not the local Swarm root: the root check cannot be what binds it.
      expect(gw.realRef(ref.slice(2))).toBeDefined();
      expect(ref.slice(2)).not.toBe(await swarmRootOf(encodeEvidence(result.evidence)));

      await approval!.getByRole('button', { name: 'Publish record' }).click();
      await expect(approval!.getByRole('heading', { name: 'Published', exact: true })).toBeVisible({ timeout: 60_000 });
      const key = (await approval!.locator('.approve-record .mono-value').first().getAttribute('title')) as Hex;
      expect(key).toMatch(/^0x[0-9a-f]{64}$/i);
      await approval!.close();

      // The record on Arkiv says "free" (zero batch id) and the gateway's reference.
      const entity = await arkivPublic(LOCAL).getEntity(key);
      expect(entity).toBeTruthy();

      // The page the record's address points at, with the DEFAULT download gateway: it does not
      // have this gateway's reference, so the evidence is unavailable (never a pass).
      await app.goto(capturePage(key));
      await expect(status(app, 'A')).toHaveAttribute('data-status', 'unavailable', { timeout: 30_000 });
      await expect(verdict(app)).not.toHaveAttribute('data-verdict', 'pass');

      // Settings: the gateway as download gateway. The evidence downloads and verifies through the
      // R13 path (A-C plus the facts matching the record), though the reference is not the root.
      await openSettings(app);
      await app.getByLabel('Swarm download gateway').fill(gw.url);
      await app.getByRole('button', { name: 'Save settings' }).click();
      await expect(app.getByText('Settings saved')).toBeVisible();
      await app.goto(capturePage(key));
      for (const id of ['A', 'B', 'C'] as const) {
        await expect(status(app, id), `check ${id}`).toHaveAttribute('data-status', 'pass', { timeout: 30_000 });
      }
      await expect(verdict(app)).toHaveAttribute('data-verdict', 'pass');
      expect(gw.seen.some((r) => r.method === 'GET' && r.url === `/bytes/${ref.slice(2)}`)).toBe(true);
      await app.evaluate((k) => localStorage.removeItem(k), SETTINGS_KEY);
    } finally {
      gw.server.closeAllConnections();
      gw.server.close();
    }
  });

  test('@p3 settings extension free-mode approve compares the gateway copy before publishing', async () => {
    test.setTimeout(240_000);
    gatewayBatch ??= await buyNodeBatch();
    const gw = await startGateway(gatewayBatch, { rewriteRefs: true });
    try {
      await setLocal('recall.settings', {
        net: 'local',
        witnessUrl: 'http://localhost:7047',
        pinnedWitnesses: [DEVNET_WITNESS_ADDRESS],
        appUrl: APP,
        uploadMode: 'free',
        uploadUrl: gw.url,
      });
      const page = `https://${NOTICE_HOST}/notice?run=gwcopy-${Math.random().toString(36).slice(2, 10)}`;
      const run = () =>
        sw().evaluate(async (u) => {
          const g = globalThis as unknown as { recall?: { captureForTest?: (url: string) => Promise<unknown> } };
          if (!g.recall?.captureForTest) return { error: 'no recall.captureForTest in this build' };
          return g.recall.captureForTest(u);
        }, page) as Promise<
          { evidence: EvidenceFile; upload?: { status: string; captureId?: string; evidenceRef?: Hex; batchId?: Hex; error?: string } } | { error: string }
        >;
      let result = await run();
      if ('error' in result && /witness busy|too many sessions|did not connect in time|timed out/i.test(result.error)) result = await run();
      if ('error' in result) throw new Error(`capture failed: ${result.error}`);
      const up = result.upload!;
      expect(up.status, up.error).toBe('pending');

      let approval: Page | undefined;
      await expect
        .poll(() => (approval = ext.context.pages().find((p) => p.url().includes(`#/approve/${up.captureId}`))), { timeout: 15_000 })
        .toBeTruthy();
      // The free upload the publish tab asks for (recall.uploadPending), sent from the app's origin.
      const send = <T,>(msg: object) =>
        approval!.evaluate(
          ([id, m]) =>
            new Promise<unknown>((resolve) => {
              const rt = (window as unknown as { chrome?: { runtime?: { sendMessage?: Function; lastError?: { message?: string } } } }).chrome
                ?.runtime;
              if (!rt?.sendMessage) return resolve({ lastError: 'chrome.runtime is not exposed to this page' });
              rt.sendMessage(id, m, (res: unknown) => resolve(res ?? { lastError: rt.lastError?.message ?? 'no answer' }));
            }),
          [ext.extensionId, msg] as const,
        ) as Promise<T>;
      expect(await send({ type: 'recall.uploadPending', captureId: up.captureId, mode: 'free' })).toEqual({ status: 'uploading' });
      let state: { status?: string; evidenceRef?: Hex; batchId?: Hex } = {};
      await expect
        .poll(
          async () =>
            (state = ((await send<{ upload?: typeof state }>({ type: 'recall.getPending', captureId: up.captureId })).upload ?? {})).status,
          { timeout: 60_000 },
        )
        .toBe('uploaded');
      expect(state.batchId).toBe(ZERO_BATCH);
      const ref = state.evidenceRef!;
      const tab = approval!;
      await allowLocalArkiv(tab);
      // A wallet is present (a mock with a real key), so "Connect MetaMask" is usable when the page is ready.
      await installMockWallet(tab, {
        privateKey: SETTINGS_WALLET_KEY,
        rpcByChainId: { 1337: LOCAL.arkiv.rpcUrl, 100: LOCAL.gnosis.rpcUrl },
        chainId: 1337,
      });
      const CORS = { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' };
      const gatewayRoute = new RegExp(`/bytes/${ref.slice(2)}$`);
      const publishButton = tab.locator('main').getByRole('button', { name: 'Publish record' });

      // 1. The gateway holds ANOTHER file under the reference: blocked, nothing could be published.
      await tab.route(gatewayRoute, (r) => r.fulfill({ status: 200, headers: CORS, body: Buffer.from('this is some other file') }));
      await tab.reload();
      await expect(tab.getByRole('heading', { name: "This capture can't be published" })).toBeVisible({ timeout: 30_000 });
      await expect(tab.getByText(/is not this capture's evidence/)).toBeVisible();
      await expect(tab.getByText('Nothing was published.')).toBeVisible();
      await expect(tab.getByRole('button', { name: 'Publish record' })).toHaveCount(0);
      await tab.unroute(gatewayRoute);

      // 2. The gateway holds exactly these bytes: ready, and no warning.
      await tab.route(gatewayRoute, (r) => r.fulfill({ status: 200, headers: CORS, body: Buffer.from(encodeEvidence(result.evidence)) }));
      await tab.reload();
      await expect(tab.getByRole('heading', { level: 1 })).toHaveText('Save this capture');
      await expect(publishButton).toBeVisible();
      await expect(tab.getByRole('heading', { name: 'Stored copy not confirmed' })).toHaveCount(0);
      await tab.unroute(gatewayRoute);

      // 3. The gateway does not answer for it: a soft warning, and publishing is still possible.
      await tab.route(gatewayRoute, (r) => r.fulfill({ status: 404, headers: CORS, body: '' }));
      await tab.reload();
      await expect(tab.getByRole('heading', { level: 1 })).toHaveText('Save this capture');
      await expect(tab.getByRole('heading', { name: 'Stored copy not confirmed' })).toBeVisible();
      await expect(publishButton).toBeVisible();
      await expect(publishButton).toBeEnabled();
      await tab.close();
    } finally {
      gw.server.closeAllConnections();
      gw.server.close();
    }
  });
});

