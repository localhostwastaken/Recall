import { expect, test, type Frame, type Locator, type Page, type Route } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http as viemHttp, parseEther, sha256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { canonicalUrl, encodeEvidence, parseResponse, urlHash as hashUrl, type EvidenceFile } from '../../packages/evidence/src/index';
import { LOCAL, arkivPublic, arkivWallet, writeConfirmation, type CaptureRow } from '../../packages/net/src/index';
import { DEVNET_WITNESS_ADDRESS, DEV_PRIVATE_KEY } from '../fixtures/keys';
import { allowLocalArkiv } from '../fixtures/localCors';
import { NOTICE_HOST, Rig, record, requestBytes, signEvidence, tamperEvidence } from '../fixtures/verifyRig';

// The browse UI of the web app (apps/web on :5173): the per-address timeline, the "it said X,
// now says Y" diff, the sandboxed preview and the evidence download. Everything runs against the
// REAL local devnet (Arkiv :8545, Bee :1633/:1643, Gnosis fork :9545, notice fixture :443).
// Fixtures are built in beforeAll like p3-verify: the notice fixture is recorded at version 1,
// then version 2, signed with the public devnet witness key, uploaded under a bought batch and
// indexed on Arkiv. Nothing in the page is mocked.

const APP = 'http://localhost:5173';
test.use({ channel: 'chromium', colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
/** "4 Nov 2026, 14:02 UTC": the design brief's date format, written independently of the app. */
function utc(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}
/** "4 Nov": the diff heading's short date (the same year as now). */
function shortDay(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const CA = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures/notice/.certs/ca.pem'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Switches the notice fixture between its two versions (v1: "15 December", v2: "12 December"). */
function setNoticeVersion(v: 1 | 2): Promise<void> {
  const body = JSON.stringify({ v });
  return new Promise((done, fail) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: 443,
        servername: NOTICE_HOST,
        ca: CA,
        method: 'POST',
        path: '/__admin/version',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => (res.statusCode === 200 ? done() : fail(new Error(`set version: HTTP ${res.statusCode}`))));
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

type Captured = Awaited<ReturnType<typeof captureAt>>;

/** Records `target` from the notice fixture over TLS 1.2 and witness-signs it. */
async function captureAt(target: string, rec?: Awaited<ReturnType<typeof record>>, witnessKey?: Hex) {
  const recording = rec ?? (await record(target));
  const url = canonicalUrl(`https://${NOTICE_HOST}${target}`);
  const { evidence, signer, signedAt } = await signEvidence(recording, { capturedUrl: url, key: witnessKey });
  const body = parseResponse(recording.recv).body;
  return { url, urlHash: hashUrl(url), evidence, evidenceBytes: encodeEvidence(evidence), body, bodySha256: sha256(body), signer, signedAt };
}

/** A capture of a page the fixture does not serve: the witness "saw" exactly these bytes. */
function captureHtml(target: string, html: string) {
  const bytes = new TextEncoder().encode(html);
  const head = `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`;
  const recv = new Uint8Array([...new TextEncoder().encode(head), ...bytes]);
  return captureAt(target, { sent: requestBytes(target), recv });
}

let rig: Rig;
let confirmWriter: ReturnType<typeof arkivWallet>;

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

/** Uploads a capture's evidence and indexes it; `entity` patches the written row. */
async function publish(c: Captured, entity: Partial<CaptureRow> = {}): Promise<Hex> {
  const evidenceRef = await rig.upload(c.evidenceBytes);
  return rig.write({
    urlHash: c.urlHash,
    bodySha256: c.bodySha256,
    serverName: NOTICE_HOST,
    witness: c.signer,
    signedAt: c.signedAt,
    httpStatus: 200,
    batchId: rig.batchId,
    evidenceRef,
    canonicalUrl: c.url,
    ...entity,
  });
}

/** Indexes a confirmation (evidence inline) that names `captureKey`. */
async function confirm(c: Captured, captureKey: Hex): Promise<Hex> {
  const { entityKey } = await writeConfirmation(confirmWriter, {
    captureKey,
    urlHash: c.urlHash,
    bodySha256: c.bodySha256,
    witness: c.signer,
    signedAt: c.signedAt,
    evidence: c.evidenceBytes,
  });
  await eventually(() => arkivPublic(LOCAL).getEntity(entityKey), `confirmation ${entityKey}`);
  return entityKey;
}

const run = randomBytes(5).toString('hex');
const targetA = `/notice?tl=${run}`; // version 1, a confirmation of it, then version 2
const targetB = `/notice?tlb=${run}`; // one real capture plus one junk record
const targetC = `/notice?tlc=${run}`; // a capture plus a "confirmation" of different bytes
const targetD = `/notice?tld=${run}`; // more junk rows than a small row budget
const targetS = `/script?tls=${run}`; // a page with a script
const targetP = `/notice.pdf?tlp=${run}`; // a PDF
const targetE = `/notice?tle=${run}`; // one real capture plus four that must never be listed
const targetW = `/words?tlw=${run}`; // two versions that share almost no words
let a1: Captured, a1c: Captured, a2: Captured, b: Captured, c1: Captured, s: Captured, pdf: Captured, hostile: Captured;
let e0: Captured, w1: Captured, w2: Captured;
let keyW1: Hex, keyE0: Hex;
let keyA1: Hex, keyA2: Hex, keyB: Hex, keyC1: Hex, keyS: Hex, keyPdf: Hex, keyHostile: Hex;
let keyMxss: Hex, keyClosed: Hex, keyMention: Hex;
let mxss: Captured, closed: Captured, mention: Captured;

/** n random 5-letter words: two such texts have almost nothing in common. */
const randomWords = (n: number) => Array.from({ length: n }, () => randomBytes(4).toString('hex').slice(0, 5)).join(' ');
const junkRef = (): Hex => `0x${randomBytes(32).toString('hex')}` as Hex;

/** Where the hostile page's requests would go (the test listens there). */
const OUTSIDE_PORT = 15174;
const HOSTILE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=http://localhost:15174/away">
<link rel="stylesheet" href="http://localhost:15174/evil.css">
<link rel="preconnect" href="http://localhost:15174"><link rel="dns-prefetch" href="http://localhost:15174">
<script>window.__ran = 1; fetch('http://localhost:15174/script-fetch');</script></head>
<body><p>hostile page</p>
<img src="http://localhost:15174/pixel.png" onerror="window.__ran = 2">
<iframe src="http://localhost:15174/frame.html"></iframe>
<iframe srcdoc="<a href='http://localhost:15174/nested' target='_self'>nested</a>"></iframe>
<a href="http://localhost:15174/click">a link</a>
<a id="self" target="_self" href="http://localhost:15174/self">self link</a>
<a target="_top" href="http://localhost:15174/top">top link</a>
<svg width="320" height="40" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<a target="_self" xlink:href="http://localhost:15174/svg-xlink"><text x="5" y="25">svg xlink link</text></a>
<a target="_self" href="http://localhost:15174/svg-href"><text x="150" y="25">svg href link</text></a></svg>
<map name="m"><area shape="rect" coords="0,0,60,60" href="http://localhost:15174/area" target="_self"></map>
<img usemap="#m" width="60" height="60" alt="area map" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
<div><template shadowrootmode="open"><a target="_self" href="http://localhost:15174/dsd-html">dsd html link</a></template></div>
<div><template shadowrootmode="open"><svg width="200" height="30" xmlns="http://www.w3.org/2000/svg"><a target="_self" href="http://localhost:15174/dsd-svg"><text x="5" y="20">dsd svg link</text></a></svg></template></div>
<svg width="200" height="30" xmlns="http://www.w3.org/2000/svg"><a target="_self"><set attributeName="href" to="http://localhost:15174/smil" begin="0s" fill="freeze"/><text x="5" y="20">smil link</text></a></svg>
<math><mi href="http://localhost:15174/mathml" target="_self">mathml link</mi></math>
<form action="http://localhost:15174/form"><button type="submit">submit</button></form></body></html>`;

/** Page bodies that try to hide a link from a sanitiser (see the tests that use them). */
const MXSS_PAGE =
  `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1&gt;&lt;div&gt;&lt;template shadowrootmode=closed&gt;` +
  `&lt;a target=_self href=http://localhost:${OUTSIDE_PORT}/mxss style=display:block;width:400px;height:200px&gt;CLICK&lt;/a&gt;&lt;/template&gt;&lt;/div&gt;">`;
const CLOSED_PAGE = `<!doctype html><html><body><p>closed shadow page</p><div><template shadowrootmode="closed"><a target="_self" href="http://localhost:${OUTSIDE_PORT}/closed" style="display:block;width:400px;height:200px">closed link</a></template></div></body></html>`;
const MENTION_PAGE = `<!doctype html><html><body><h1>Shadow DOM notes</h1><p>The attribute shadowrootmode turns a template into a shadow root, for example <code>&lt;template shadowrootmode="open"&gt;</code>.</p></body></html>`;

test.beforeAll(async () => {
  test.setTimeout(420_000);
  rig = await Rig.create();
  // A writer of its own for confirmations (the rig only writes captures).
  const writerKey = generatePrivateKey();
  const pub = arkivPublic(LOCAL);
  const bank = createWalletClient({ account: privateKeyToAccount(DEV_PRIVATE_KEY), chain: pub.chain, transport: viemHttp(LOCAL.arkiv.rpcUrl) });
  await pub.waitForTransactionReceipt({
    hash: await bank.sendTransaction({ to: privateKeyToAccount(writerKey).address, value: parseEther('1') }),
  });
  confirmWriter = arkivWallet(LOCAL, viemHttp(LOCAL.arkiv.rpcUrl), privateKeyToAccount(writerKey));

  // Record everything while the fixture is switched, and put it back to v1 straight away
  // (other specs expect v1). Signed times must differ, hence the pauses.
  let v2a: Captured, v2c: Captured;
  try {
    await setNoticeVersion(1);
    a1 = await captureAt(targetA);
    b = await captureAt(targetB);
    c1 = await captureAt(targetC);
    s = await captureAt(targetS);
    pdf = await captureAt(targetP);
    await sleep(1_100);
    a1c = await captureAt(targetA); // the same bytes again: a confirmation
    await sleep(1_100);
    await setNoticeVersion(2);
    a2 = await captureAt(targetA);
    v2c = await captureAt(targetC); // v2 bytes, to be (wrongly) offered as a confirmation of c1
  } finally {
    await setNoticeVersion(1);
  }
  hostile = await captureHtml(`/hostile?tlh=${run}`, HOSTILE);
  mxss = await captureHtml(`/mxss?tlm=${run}`, MXSS_PAGE);
  closed = await captureHtml(`/closed?tlc2=${run}`, CLOSED_PAGE);
  mention = await captureHtml(`/mention?tlm2=${run}`, MENTION_PAGE);
  w1 = await captureHtml(targetW, `<!doctype html><html><body><p>${randomWords(6000)}</p></body></html>`);
  await sleep(1_100);
  w2 = await captureHtml(targetW, `<!doctype html><html><body><p>${randomWords(6000)}</p></body></html>`);
  expect(w2.signedAt).toBeGreaterThan(w1.signedAt);
  e0 = await captureAt(targetE);
  expect(a1.bodySha256).toBe(a1c.bodySha256);
  expect(a1.bodySha256).not.toBe(a2.bodySha256);
  expect(a1c.signedAt).toBeGreaterThan(a1.signedAt);
  expect(a2.signedAt).toBeGreaterThan(a1c.signedAt);

  keyA1 = await publish(a1);
  await confirm(a1c, keyA1);
  keyA2 = await publish(a2);

  keyB = await publish(b);
  await rig.write({ ...(await rowOf(b)), evidenceRef: junkRef() }); // junk: evidence that cannot be downloaded

  keyC1 = await publish(c1);
  await confirm(v2c, keyC1); // different bytes than the capture it names

  keyS = await publish(s);
  keyPdf = await publish(pdf);
  keyHostile = await publish(hostile);
  keyMxss = await publish(mxss);
  keyClosed = await publish(closed);
  keyMention = await publish(mention);

  // targetD: three junk rows, more than the budget of 2 the spec gives the page.
  const d = await captureAt(targetD, await record(targetD));
  for (let i = 0; i < 3; i++) await rig.write({ ...(await rowOf(d)), evidenceRef: junkRef() });

  keyW1 = await publish(w1);
  await publish(w2);

  // targetE: one real capture, plus four records that look like captures but must never be listed.
  keyE0 = await publish(e0);
  const other = (key?: Hex) => captureAt(targetE, undefined, key);
  const stranger = await other(`0x${randomBytes(32).toString('hex')}`); // signed by a witness nobody trusts
  await publish(stranger);
  const forged = await other(); // a good statement under the signature of a different one
  await publish({ ...forged, evidenceBytes: encodeEvidence({ ...forged.evidence, signature: e0.evidence.signature } satisfies EvidenceFile) });
  const tampered = await other(); // bytes changed after signing
  await publish({ ...tampered, evidenceBytes: tamperEvidence(tampered.evidence) });
  const lying = await other(); // genuine evidence under a record that says something else
  await publish(lying, { bodySha256: `0x${'ab'.repeat(32)}` });

  // The fixture itself must be sound, or every test below would prove nothing.
  expect([keyA1, keyA2, keyB, keyC1, keyS, keyPdf, keyHostile, keyMxss, keyClosed, keyMention].every((k) => /^0x[0-9a-f]{64}$/.test(k))).toBe(true);
  expect(DEVNET_WITNESS_ADDRESS).toBe(a1.signer);
});

async function rowOf(c: Captured): Promise<CaptureRow> {
  return {
    urlHash: c.urlHash,
    bodySha256: c.bodySha256,
    serverName: NOTICE_HOST,
    witness: c.signer,
    signedAt: c.signedAt,
    httpStatus: 200,
    batchId: rig.batchId,
    evidenceRef: junkRef(),
    canonicalUrl: c.url,
  };
}

// The local Arkiv node sends no CORS headers; see fixtures/localCors.ts.
test.beforeEach(async ({ page }) => {
  await allowLocalArkiv(page);
});
// A page still reading from the node when the test ends would make its route handler throw.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const timeline = (hash: Hex) => `${APP}/#/u/${hash}`;
const capturePage = (key: Hex) => `${APP}/#/c/${key}`;
const items = (page: Page, kind: 'version' | 'confirmation' | 'unverified' | 'pending'): Locator =>
  page.locator(`[data-kind="${kind}"]`);
const verdict = (page: Page): Locator => page.locator('[data-verdict]');
const status = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => page.locator(`[data-check="${id}"] [data-status]`);
const unverifiedSwitch = (page: Page): Locator => page.getByRole('switch', { name: /^Show unverified/ });
const preview = (page: Page): Locator => page.locator('iframe.preview-frame');

test('@p3 timeline shows v1, confirmation and v2 in order', async ({ page }) => {
  await page.goto(timeline(a1.urlHash));
  // The heading and the address come from the verified evidence, not from the index.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(NOTICE_HOST);
  await expect(page.locator('main')).toContainText(a1.url);
  await expect(items(page, 'version')).toHaveCount(2);
  await expect(items(page, 'confirmation')).toHaveCount(1);
  await expect(items(page, 'pending')).toHaveCount(0);

  // Oldest first: version 1, the confirmation under it, then version 2.
  const kinds = await page.locator('[data-kind]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
  expect(kinds).toEqual(['version', 'confirmation', 'version']);
  const [v1, v2] = [items(page, 'version').nth(0), items(page, 'version').nth(1)];
  await expect(v1).toContainText(`Version 1 · ${utc(a1.signedAt)}`);
  await expect(v2).toContainText(`Version 2 · ${utc(a2.signedAt)}`);
  await expect(v1).toContainText(`${a1.body.length} B · HTTP 200 · Recall Witness`);
  await expect(v1.locator('[data-status="pass"]')).toHaveText('Passed');
  await expect(v2.locator('[data-status="pass"]')).toHaveText('Passed');
  // The whole row is a link to the capture detail.
  await expect(v1.getByRole('link').first()).toHaveAttribute('href', `#/c/${keyA1}`);
  await expect(v2.getByRole('link').first()).toHaveAttribute('href', `#/c/${keyA2}`);
  // The confirmation sits under the capture it confirms, and says only what was checked.
  const conf = v1.locator('[data-kind="confirmation"]');
  await expect(conf).toHaveText(new RegExp(`Still unchanged on ${utc(a1c.signedAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await expect(v2.locator('[data-kind="confirmation"]')).toHaveCount(0);
  // Totals count verified items only, and the first captured time is the witness's.
  await expect(page.locator('[data-summary]')).toHaveText(`2 versions · 1 confirmation · first captured ${utc(a1.signedAt)}`);
  await expect(unverifiedSwitch(page)).toHaveCount(0);
  await expect(page.getByText(/Too many records/)).toHaveCount(0);
  await expect(page.getByText(/never changed|Confirmed unchanged|tamper-proof|authentic/i)).toHaveCount(0);

  // The capture detail knows its way back to the timeline.
  await v2.getByRole('link').first().click();
  await expect(page).toHaveURL(capturePage(keyA2));
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await page.getByRole('link', { name: 'View timeline' }).click();
  await expect(page).toHaveURL(timeline(a1.urlHash));
});

test('@p3 timeline shows Checking… and nothing verified while evidence loads', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/localhost:1643\/bytes\//, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(timeline(a1.urlHash));
  // The two captures and the confirmation are listed as pending: no date, no version, no pass,
  // no host as the title. (The confirmation waits for the capture it names.)
  await expect(items(page, 'pending')).toHaveCount(3);
  await expect(items(page, 'pending').first()).toContainText('Checking…');
  await expect(page.locator('[data-status="pass"]')).toHaveCount(0);
  await expect(items(page, 'version')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).not.toContainText(NOTICE_HOST);
  await expect(page.getByText(utc(a1.signedAt))).toHaveCount(0);
  release();
  await expect(items(page, 'version')).toHaveCount(2);
  await expect(items(page, 'pending')).toHaveCount(0);
});

test('@p3 timeline diff shows 15 December removed and 12 December added', async ({ page }) => {
  await page.goto(timeline(a1.urlHash));
  const heading = page.getByRole('heading', { level: 2, name: /^What changed/ });
  await expect(heading).toHaveText(`What changed: Version 1 (${shortDay(a1.signedAt)}) → Version 2 (${shortDay(a2.signedAt)})`);
  await expect(page.getByText('Text only. HTML tags and whitespace-only changes are ignored.')).toBeVisible();

  const diff = page.locator('[data-diff]');
  // Inline word diff: the date that changed is struck out and the new one added.
  await expect(diff.locator('del')).toHaveCount(1);
  await expect(diff.locator('ins')).toHaveCount(1);
  // Exactly the changed words (a hidden "removed:" / "added:" label comes first), nothing around them.
  await expect(diff.locator('del')).toHaveText('removed: 15');
  await expect(diff.locator('ins')).toHaveText('added: 12');
  await expect(diff.locator('del .visually-hidden')).toHaveText('removed: ');
  await expect(diff.locator('ins .visually-hidden')).toHaveText('added: ');
  await expect(diff).toContainText('Deadline:');
  await expect(diff).toContainText('December');
  // Markup is not text: no tag appears in the diff.
  await expect(diff).not.toContainText('<p');
  await expect(diff).not.toContainText('<h1');

  // Side by side: the whole old line on the left, the whole new line on the right.
  await page.getByRole('radio', { name: 'Side by side' }).check({ force: true });
  // (A hidden "removed:" / "added:" label sits in front of the changed word for screen readers.)
  await expect(page.locator('[data-side="old"]')).toContainText(/Deadline: (removed: )?15 December/);
  await expect(page.locator('[data-side="new"]')).toContainText(/Deadline: (added: )?12 December/);
  await expect(page.locator('[data-side="old"]')).not.toContainText('12 December');
  await expect(page.locator('[data-side="new"] ins')).toContainText('12');
  await expect(page.locator('[data-side="old"] del')).toContainText('15');

  // The versions can be swapped: now 12 is removed and 15 is added.
  await page.getByLabel('Compare', { exact: true }).selectOption({ label: `Version 2 (${shortDay(a2.signedAt)})` });
  await page.getByLabel('with', { exact: true }).selectOption({ label: `Version 1 (${shortDay(a1.signedAt)})` });
  await expect(page.locator('[data-side="old"] del')).toContainText('12');
  await expect(page.locator('[data-side="new"] ins')).toContainText('15');
  // Comparing a version with itself makes no claim.
  await page.getByLabel('with', { exact: true }).selectOption({ label: `Version 2 (${shortDay(a2.signedAt)})` });
  await expect(page.getByText('Choose two different versions to compare.')).toBeVisible();
  await expect(page.locator('[data-diff] del, [data-diff] ins')).toHaveCount(0);
});

test('@p3 timeline preview iframe is sandboxed and scripts do not run', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(capturePage(keyS));
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await expect(page.getByRole('heading', { level: 2, name: 'Preview of the captured bytes' })).toBeVisible();
  await expect(page.getByText('Sandboxed: scripts and outside resources are blocked, so it may look plain.')).toBeVisible();

  const frameEl = preview(page);
  await expect(frameEl).toHaveCount(1);
  // An EMPTY sandbox attribute: no scripts, no same-origin, no forms, no popups, no navigation.
  await expect(frameEl).toHaveAttribute('sandbox', '');
  expect(await frameEl.evaluate((el) => el.getAttribute('sandbox'))).toBe('');
  expect(await frameEl.evaluate((el) => (el as HTMLIFrameElement).sandbox.length)).toBe(0);
  // The captured bytes go in through srcdoc, not through a URL the page could navigate away from.
  expect(await frameEl.evaluate((el) => el.hasAttribute('srcdoc'))).toBe(true);
  expect(await frameEl.evaluate((el) => el.hasAttribute('src'))).toBe(false);

  const frame = await (await frameEl.elementHandle())!.contentFrame();
  expect(frame).not.toBeNull();
  await expect.poll(() => frame!.evaluate(() => document.body?.textContent ?? '')).toContain('script page');
  // The page's own script (window.__ran = 1) never ran, neither in the frame nor in the app.
  expect(await frame!.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();
  // The captured page is never in the app's own DOM.
  await expect(page.locator('main').getByText('script page')).toHaveCount(0);
  await expect(page.locator('main script')).toHaveCount(0);
  expect(errors).toEqual([]);
});

/**
 * A real server stands in for "the rest of the internet" while `body` runs. Whatever a captured page
 * asks of it (an image, a stylesheet, a frame, a fetch, a redirect, a preconnect, a link of any kind)
 * is counted: requests, and also bare connections. (The browser's own request events do not report a
 * sandboxed frame's requests, so they cannot be used.)
 */
async function withOutside(body: (outside: { hits: string[]; connections: () => number }) => Promise<void>): Promise<void> {
  const hits: string[] = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' }).end('outside');
  });
  server.on('connection', () => connections++);
  await new Promise<void>((done, fail) => {
    server.once('error', fail); // e.g. the port is taken: fail now instead of hanging
    server.listen(OUTSIDE_PORT, done);
  });
  try {
    await body({ hits, connections: () => connections });
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

/** Nothing reached "the internet", the frame never left about:srcdoc, no popup, the app did not navigate. */
async function expectQuiet(page: Page, frame: Frame, outside: { hits: string[]; connections: () => number }, key: Hex, what: string) {
  expect(outside.hits, what).toEqual([]);
  expect(outside.connections(), `${what}: connections`).toBe(0);
  expect(await frame.evaluate(() => location.href), what).toBe('about:srcdoc');
  expect(page.context().pages(), `${what}: popup`).toHaveLength(1);
  await expect(page).toHaveURL(capturePage(key));
}

const frameOf = async (page: Page): Promise<Frame> => (await (await preview(page).elementHandle())!.contentFrame())!;

test('@p3 timeline preview blocks scripts, outside resources, redirects, links and forms of a hostile page', async ({ page }) => {
  await withOutside(async (outside) => {
    await page.goto(capturePage(keyHostile));
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
    const frameEl = preview(page);
    const frame = await frameOf(page);
    await expect.poll(() => frame.evaluate(() => document.body?.textContent ?? '')).toContain('hostile page');
    await page.waitForTimeout(1_500); // a meta refresh or a late request would have fired by now
    const quiet = (what: string) => expectQuiet(page, frame, outside, keyHostile, what);
    await quiet('after load');
    expect(await frame.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();

    // Only plain HTML and CSS are left: no link target, template, SVG, MathML, animation, frame, form or href.
    expect(await frame.evaluate(() => document.querySelectorAll('template, svg, math, animate, set, link, iframe, form, script, meta[http-equiv="refresh"], base[href], [href], [*|href], [ping]').length)).toBe(0);
    expect(await frame.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length)).toBe(0);

    // Clicks: a plain link, target=_self, target=_top; then every hiding place the page tried (SVG links with
    // xlink:href and href, shadow roots, an SMIL-written href, MathML). Those are gone, so clicking a missing
    // one just times out quickly; if one survived, the click would reach the listener.
    for (const target of ['a link', 'self link', 'top link']) {
      await frame.getByText(target, { exact: true }).click({ force: true });
      await page.waitForTimeout(250);
      await quiet(`click "${target}"`);
    }
    for (const target of ['svg xlink link', 'svg href link', 'dsd html link', 'dsd svg link', 'smil link', 'mathml link']) {
      await frame.getByText(target, { exact: true }).click({ force: true, timeout: 1_500 }).catch(() => undefined);
      await page.waitForTimeout(250);
      await quiet(`click "${target}"`);
    }
    await frame.locator('area').click({ force: true, position: { x: 10, y: 10 } }).catch(() => undefined); // an area has no box
    await frame.locator('img[usemap]').click({ position: { x: 10, y: 10 }, timeout: 3_000 }).catch(() => undefined);
    await frame.getByRole('button', { name: 'submit' }).click({ timeout: 1_500 }).catch(() => undefined); // forms are gone
    await page.waitForTimeout(300);
    await quiet('image map and form');

    // Keyboard: Enter on a focused link goes nowhere. Focus is set inside the frame itself; a link that
    // cannot take focus (no href) simply leaves focus where it was.
    for (const sel of ['#self', 'a', 'area']) {
      await frame.locator(sel).first().evaluate((el) => (el as HTMLElement).focus());
      await page.keyboard.press('Enter');
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(300);
    await quiet('keyboard');
    // The preview is still there and was never replaced by the "stopped" notice.
    await expect(frameEl).toHaveCount(1);
    await expect(page.getByText('The preview was stopped.')).toHaveCount(0);
  });
});

test('@p3 timeline preview of a mutation-XSS page and of a hidden closed shadow root goes nowhere', async ({ page }) => {
  // The first page hides a closed shadow root with a link inside an attribute: after one parse and
  // serialise it becomes real markup that no query can see (a reviewer's payload, reproduced in
  // Chromium). The second writes the closed shadow root directly. A click anywhere in the 400 x 200
  // block, where the link would be, must go nowhere.
  for (const [what, key] of [['mutation XSS', keyMxss], ['closed shadow root', keyClosed]] as const) {
    await withOutside(async (outside) => {
      await page.goto(capturePage(key));
      await expect(verdict(page), what).toHaveAttribute('data-verdict', 'pass');
      const frameEl = preview(page);
      await expect(frameEl, what).toHaveCount(1);
      const frame = await frameOf(page);
      await page.waitForTimeout(1_000);
      expect(await frame.evaluate(() => [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length), what).toBe(0);
      expect(await frame.evaluate(() => document.querySelectorAll('template, [href]').length), what).toBe(0);
      for (const [x, y] of [[40, 30], [150, 80], [300, 150]]) {
        await frameEl.click({ position: { x, y }, force: true });
        await page.waitForTimeout(250);
        await expectQuiet(page, frame, outside, key, `${what}: click at ${x},${y}`);
      }
      await frame.locator('body').press('Enter').catch(() => undefined);
      await page.waitForTimeout(300);
      await expectQuiet(page, frame, outside, key, `${what}: keyboard`);
    });
  }
});

test('@p3 timeline a page that only talks about shadowrootmode still previews', async ({ page }) => {
  await page.goto(capturePage(keyMention));
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  const frame = await frameOf(page);
  await expect.poll(() => frame.evaluate(() => document.body?.textContent ?? '')).toContain('The attribute shadowrootmode turns a template into a shadow root');
  expect(await frame.evaluate(() => document.body.textContent)).toContain('<template shadowrootmode="open">');
  await expect(page.getByText('This page could not be shown safely.')).toHaveCount(0);
  expect(await frame.evaluate(() => document.querySelector('h1')?.textContent)).toBe('Shadow DOM notes');
});

test('@p3 timeline a preview that loads twice is stopped', async ({ page }) => {
  // The backstop: if anything ever made the frame load another document, it is not left on screen.
  await page.goto(capturePage(keyS));
  await expect(preview(page)).toHaveCount(1);
  await expect.poll(async () => (await (await preview(page).elementHandle())!.contentFrame())!.evaluate(() => document.body?.textContent ?? '')).toContain('script page');
  await preview(page).evaluate((el) => {
    (el as HTMLIFrameElement).srcdoc += '<!-- reloaded -->'; // a second load of the same frame
  });
  await expect(page.getByText('The preview was stopped.')).toBeVisible();
  await expect(preview(page)).toHaveCount(0);
});

test('@p3 timeline a PDF capture is offered for download, not drawn in the sandbox', async ({ page }) => {
  // Chrome refuses its PDF viewer inside an iframe with an empty sandbox (a broken-page icon),
  // so a PDF is never put in a frame: the captured file is offered for download instead.
  await page.goto(capturePage(keyPdf));
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await expect(page.locator('.exhibit')).toContainText('application/pdf');
  await expect(page.getByRole('heading', { level: 2, name: 'Preview of the captured bytes' })).toBeVisible();
  await expect(preview(page)).toHaveCount(0);
  await expect(page.locator('iframe, embed, object')).toHaveCount(0);
  await expect(page.getByText("PDF files can't be previewed in the sandbox.")).toBeVisible();
  const link = page.getByRole('link', { name: 'Download the captured PDF' });
  await expect(link).toHaveAttribute('href', /^blob:/);
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(`recall-${pdf.urlHash.slice(2, 10)}-${pdf.signedAt}.pdf`);
  const saved = join(tmpdir(), `recall-t16-pdf-${run}.pdf`);
  await download.saveAs(saved);
  // The exact bytes the witness saw.
  expect(sha256(new Uint8Array(readFileSync(saved)))).toBe(pdf.bodySha256);
});

test('@p3 timeline downloaded evidence re-verifies when dropped', async ({ page }) => {
  await page.goto(capturePage(keyA1));
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download evidence file' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`recall-${a1.urlHash.slice(2, 10)}-${a1.signedAt}.json`);
  const saved = join(tmpdir(), `recall-t16-${run}.json`);
  await download.saveAs(saved);
  expect(Buffer.from(readFileSync(saved)).equals(Buffer.from(a1.evidenceBytes))).toBe(true);

  // Dropped back on the home page, it verifies by itself (no Recall server, no network needed).
  await page.goto(`${APP}/#/`);
  await page.getByLabel('Evidence file', { exact: true }).setInputFiles(saved);
  await expect(page).toHaveURL(/#\/file$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(NOTICE_HOST);
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass');
  }
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await expect(verdict(page)).toHaveText(`Checks passed. The witness saw these exact bytes from ${NOTICE_HOST} at ${utc(a1.signedAt)}.`);
  // The dropped file gets the same sandboxed preview.
  await expect(preview(page)).toHaveAttribute('sandbox', '');
});

test('@p3 timeline junk record is hidden behind show unverified (1)', async ({ page }) => {
  await page.goto(timeline(b.urlHash));
  await expect(items(page, 'version')).toHaveCount(1);
  await expect(items(page, 'pending')).toHaveCount(0);
  // The junk row is not listed, not counted, and nothing about it is shown by default.
  await expect(items(page, 'unverified')).toHaveCount(0);
  await expect(page.locator('[data-summary]')).toHaveText(`1 version · 0 confirmations · first captured ${utc(b.signedAt)}`);
  const sw = unverifiedSwitch(page);
  await expect(sw).toHaveText('Show unverified (1)');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText("Evidence couldn't be downloaded")).toHaveCount(0);

  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(items(page, 'unverified')).toHaveCount(1);
  await expect(items(page, 'unverified')).toContainText("Evidence couldn't be downloaded");
  // It shows a not-passed badge (never green) and the totals above did not change.
  await expect(items(page, 'unverified').locator('[data-status]')).toHaveAttribute('data-status', 'unavailable');
  await expect(items(page, 'unverified').locator('[data-status="pass"]')).toHaveCount(0);
  await expect(page.locator('[data-summary]')).toHaveText(`1 version · 0 confirmations · first captured ${utc(b.signedAt)}`);
  // The junk row's claimed date is an index field: it is not displayed.
  await expect(items(page, 'unverified')).not.toContainText(/UTC/);

  await sw.click();
  await expect(items(page, 'unverified')).toHaveCount(0);
});

test('@p3 timeline a confirmation of different bytes is not shown as a confirmation', async ({ page }) => {
  await page.goto(timeline(c1.urlHash));
  await expect(items(page, 'version')).toHaveCount(1);
  await expect(items(page, 'confirmation')).toHaveCount(0);
  await expect(page.getByText(/Still unchanged/)).toHaveCount(0);
  await expect(unverifiedSwitch(page)).toHaveText('Show unverified (1)');
  await unverifiedSwitch(page).click();
  await expect(items(page, 'unverified')).toHaveCount(1);
  await expect(items(page, 'unverified')).toContainText("Doesn't match the capture it confirms");
  await expect(page.locator('[data-summary]')).toContainText('1 version · 0 confirmations');
});

test('@p3 timeline truncated results show the spam notice', async ({ page }) => {
  // A row budget of 2 (a dev-server-only test hook); the address has 3 rows.
  await page.goto(`${APP}/?maxRows=2#/u/${hashUrl(canonicalUrl(`https://${NOTICE_HOST}${targetD}`))}`);
  const notice = page.getByText('Too many records for this URL (possible spam); some may be hidden');
  await expect(notice).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Results may be incomplete' })).toBeVisible();
  // It never claims completeness: nothing here is a verified version, the junk is behind the switch.
  await expect(items(page, 'version')).toHaveCount(0);
  await expect(unverifiedSwitch(page)).toHaveText('Show unverified (2)');
  await expect(page.getByText('No captures of this page yet.')).toHaveCount(0);

  // The same address without the hook (production budget) lists all three and shows no notice.
  await page.goto(`${APP}/#/u/${hashUrl(canonicalUrl(`https://${NOTICE_HOST}${targetD}`))}`);
  await expect(unverifiedSwitch(page)).toHaveText('Show unverified (3)');
  await expect(page.getByText(/Too many records/)).toHaveCount(0);
});

test('@p3 timeline an address with no captures says so', async ({ page }) => {
  const none = hashUrl(canonicalUrl(`https://${NOTICE_HOST}/nothing-here?${randomBytes(6).toString('hex')}`));
  await page.goto(timeline(none));
  await expect(page.getByText('No captures of this page yet.')).toBeVisible();
  await expect(page.getByText('Capture it with the Recall extension.')).toBeVisible();
  await expect(page.locator('[data-status="pass"]')).toHaveCount(0);
});

test('@p3 timeline unreachable Arkiv shows an error with Retry', async ({ page }) => {
  const unreachable = (route: Route) => route.abort();
  const arkiv = /^http:\/\/localhost:8545\//;
  await page.route(arkiv, unreachable);
  await page.goto(timeline(a1.urlHash));
  await expect(page.getByText("Couldn't reach Arkiv.")).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check settings' })).toBeVisible();
  await expect(items(page, 'version')).toHaveCount(0);
  await expect(page.getByText('No captures of this page yet.')).toHaveCount(0);
  // Retry works once the node is reachable again.
  await page.unroute(arkiv, unreachable);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(items(page, 'version')).toHaveCount(2);
});

test('@p3 timeline records that are not a pass never become a version', async ({ page }) => {
  // One real capture of the address, and four records that look like captures: an unknown witness,
  // a signature that does not belong to the statement, bytes changed after signing, and a record
  // that says something other than its evidence. Each must be hidden, with its own reason.
  await page.goto(timeline(e0.urlHash));
  await expect(items(page, 'version')).toHaveCount(1);
  await expect(items(page, 'version')).toContainText(`Version 1 · ${utc(e0.signedAt)}`);
  await expect(items(page, 'pending')).toHaveCount(0);
  await expect(page.locator('[data-summary]')).toContainText('1 version · 0 confirmations');
  const sw = unverifiedSwitch(page);
  await expect(sw).toHaveText('Show unverified (4)');
  await expect(items(page, 'unverified')).toHaveCount(0);
  await sw.click();
  const rows = items(page, 'unverified');
  await expect(rows).toHaveCount(4);
  const reasons: [string, string][] = [
    ['Unknown witness', 'warn'],
    ['Signature invalid', 'fail'],
    ["Bytes don't match", 'fail'],
    ["Record doesn't match its evidence", 'fail'],
  ];
  for (const [reason, kind] of reasons) {
    const row = rows.filter({ hasText: reason });
    await expect(row, reason).toHaveCount(1);
    await expect(row.locator('[data-status]'), reason).toHaveAttribute('data-status', kind);
  }
  // None of them is green, and none became a version or changed the totals.
  await expect(rows.locator('[data-status="pass"]')).toHaveCount(0);
  await expect(items(page, 'version')).toHaveCount(1);
  await expect(page.locator('[data-summary]')).toContainText('1 version · 0 confirmations');
});

test('@p3 timeline the diff gives up on two very different versions instead of freezing the tab', async ({ page }) => {
  await page.goto(timeline(w1.urlHash));
  await expect(items(page, 'version')).toHaveCount(2);
  const started = Date.now();
  await expect(page.getByText('Too different or too large to compare here.')).toBeVisible();
  expect(Date.now() - started).toBeLessThan(5_000);
  await expect(page.locator('[data-diff] del, [data-diff] ins')).toHaveCount(0);
  // The page still answers: switching the view and following a link work straight away.
  await page.getByRole('radio', { name: 'Side by side' }).check({ force: true });
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
  await items(page, 'version').first().getByRole('link').first().click();
  await expect(page).toHaveURL(capturePage(keyW1));
});

test('@p3 timeline only the first batch is checked automatically; the rest is Not checked until asked', async ({ page }) => {
  // The dev-server hook ?batch=2 stands in for the production 100; the address has 3 junk rows.
  const hash = hashUrl(canonicalUrl(`https://${NOTICE_HOST}${targetD}`));
  await page.goto(`${APP}/?batch=2#/u/${hash}`);
  await expect(page.getByText('1 record not checked yet')).toBeVisible();
  await expect(page.getByText('Checked 2 of 3 records so far.')).toBeVisible();
  await expect(unverifiedSwitch(page)).toHaveText('Show unverified (2)'); // the unchecked one is not counted as anything
  await expect(items(page, 'version')).toHaveCount(0);
  await expect(page.locator('[data-status="pass"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check the next 1' }).click();
  await expect(unverifiedSwitch(page)).toHaveText('Show unverified (3)');
  await expect(page.getByText(/not checked yet/)).toHaveCount(0);
});

test('@p3 timeline long lists are cut with Show more', async ({ page }) => {
  // The dev-server hook ?page=2 stands in for the production 50 rows per list.
  const hash = hashUrl(canonicalUrl(`https://${NOTICE_HOST}${targetD}`));
  await page.goto(`${APP}/?page=2#/u/${hash}`);
  await unverifiedSwitch(page).click();
  await expect(items(page, 'unverified')).toHaveCount(2);
  const more = page.getByRole('button', { name: 'Show more (1 more)' });
  await expect(more).toBeVisible();
  await more.click();
  await expect(items(page, 'unverified')).toHaveCount(3);
  await expect(page.getByRole('button', { name: /Show more/ })).toHaveCount(0);
});

test.describe('@p3 timeline storage check never goes green on a nonsense Arkiv expiry', () => {
  // arkiv_getBlockTiming is answered by the test: the capture's own Arkiv expiry is judged from it.
  const timing = (page: Page, answer: Record<string, unknown>) =>
    page.route(/^http:\/\/localhost:8545\//, async (route) => {
      const body = route.request().postData() ?? '';
      if (!body.includes('arkiv_getBlockTiming')) return route.fallback();
      const { id } = JSON.parse(body) as { id: number };
      await route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, result: answer }),
      });
    });
  const e = (page: Page) => page.locator('[data-check="E"]');

  test('a block duration that is not a number is "Not checked"', async ({ page }) => {
    await timing(page, { current_block: 1, current_block_time: 1, duration: 'soon' });
    await page.goto(capturePage(keyA1));
    await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
    await expect(e(page)).toContainText('Arkiv record expiry could not be read');
    await expect(e(page)).not.toContainText('NaN');
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass'); // E never counts toward the verdict
  });

  test('a record past its expiry says expired, not "in -1 days"', async ({ page }) => {
    await timing(page, { current_block: 10 ** 12, current_block_time: 1, duration: 2 });
    await page.goto(capturePage(keyA1));
    await expect(status(page, 'E')).toHaveAttribute('data-status', 'warn');
    await expect(e(page)).toContainText('The Arkiv record has expired');
    await expect(e(page)).not.toContainText(/-\d/); // no negative number of days
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  });
});
