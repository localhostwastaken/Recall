import { expect, test, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { sha256, type Hex } from 'viem';
import { canonicalUrl, encodeEvidence, runChecks, urlHash } from '../../packages/evidence/src/index';
import { DEVNET_WITNESS_ADDRESS, DEVNET_WITNESS_KEY } from '../fixtures/keys';
import { allowLocalArkiv } from '../fixtures/localCors';
import { NOTICE_HOST, Rig, record, signEvidence, tamperEvidence, type Published } from '../fixtures/verifyRig';

// The verification UI of the web app (apps/web on :5173), against the REAL local devnet
// (Arkiv :8545, Bee :1633/:1643, Gnosis fork :9545, notice fixture :443). Fixtures are built
// in beforeAll: recorded TLS transcripts, witness-signed with the public devnet witness key,
// uploaded to Swarm under a bought batch and indexed on Arkiv. Nothing in the page is mocked.
// The one rule under test: the page never says "verified" unless the checks actually passed.

const APP = 'http://localhost:5173';
test.use({ channel: 'chromium', colorScheme: 'light' });
test.describe.configure({ mode: 'serial' });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "4 Nov 2026, 14:02 UTC": the design brief's date format, written independently of the app. */
function utc(seconds: bigint): string {
  const d = new Date(Number(seconds) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

let rig: Rig;
let good: Published;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  rig = await Rig.create();
  good = await rig.publish();
  // The fixture must itself be sound, or every test below would prove nothing.
  const report = await runChecks(good.evidence, { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
  expect([report.A.status, report.B.status, report.C.status]).toEqual(['pass', 'pass', 'pass']);
});

// The local Arkiv node sends no CORS headers; see fixtures/localCors.ts.
test.beforeEach(async ({ page }) => {
  await allowLocalArkiv(page);
});
// A page still reading from the node when a test ends (the timeline it was sent to) would make the
// route handler throw.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const check = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator => page.locator(`[data-check="${id}"]`);
const status = (page: Page, id: 'A' | 'B' | 'C' | 'D' | 'E'): Locator =>
  check(page, id).locator('[data-status]');
const verdict = (page: Page): Locator => page.locator('[data-verdict]');
// getByLabel matches substrings, and a drop zone's group name contains its input's name.
const fileInput = (page: Page, name: string): Locator => page.getByLabel(name, { exact: true });
const capturePage = (key: Hex) => `${APP}/#/c/${key}`;
const file = (name: string, bytes: Uint8Array, mimeType = 'application/octet-stream') => ({
  name,
  mimeType,
  buffer: Buffer.from(bytes),
});

test('@p3 verify detail page shows A–E pass for real capture', async ({ page }) => {
  await page.goto(capturePage(good.entityKey));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(NOTICE_HOST);

  // A, B, C and E ran and passed; D has no file yet, so it is "Not checked", never green.
  for (const id of ['A', 'B', 'C', 'E'] as const) {
    await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass');
  }
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'D')).toContainText('No file given. Drop a file to compare.');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await expect(verdict(page)).toHaveText(
    `Checks passed. The witness saw these exact bytes from ${NOTICE_HOST} at ${utc(good.signedAt)}.`,
  );

  // Check texts name the exact facts that were checked.
  await expect(check(page, 'A')).toContainText('The evidence matches the hashes the witness signed.');
  await expect(check(page, 'B')).toContainText(`GET ${good.url} to ${NOTICE_HOST}, no cookies sent, complete response (HTTP 200).`);
  await expect(check(page, 'C')).toContainText('which is in your trusted list.');
  await expect(check(page, 'E')).toContainText(/Evidence paid on Swarm until .+ · record on Arkiv until /);

  // The exhibit card shows facts from the verified evidence.
  const card = page.locator('.exhibit');
  await expect(card).toContainText(good.url);
  await expect(card).toContainText(utc(good.signedAt));
  await expect(card).toContainText('HTTP status');
  await expect(card).toContainText('200');
  await expect(card).toContainText('text/html');
  await expect(card).toContainText(`${good.body.length} B`);
  await expect(card.getByRole('button', { name: `Copy ${good.witness}`, exact: false })).toBeVisible();

  // D: the page's own bytes pass, any other file fails and turns the verdict red.
  const chooser = fileInput(page, 'File to compare');
  await chooser.setInputFiles(file('notice.html', good.body, 'text/html'));
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'pass');
  await expect(check(page, 'D')).toContainText(`Your file matches this capture (sha256 ${sha256(good.body).slice(2, 6)}`);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');

  await chooser.setInputFiles(file('other.html', new TextEncoder().encode('<p>something else</p>'), 'text/html'));
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'fail');
  await expect(check(page, 'D')).toContainText('Your file is different from this capture.');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'fail');
  await expect(verdict(page)).toHaveText("A check failed. Don't rely on this capture.");

  // Download hands out the exact evidence bytes that passed the Swarm root check.
  await page.getByRole('button', { name: 'Remove file' }).click();
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'unavailable');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download evidence file' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`recall-${good.urlHash.slice(2, 10)}-${good.signedAt}.json`);
  const saved = await (await download.createReadStream()).toArray();
  expect(Buffer.concat(saved as Buffer[]).equals(Buffer.from(good.evidenceBytes))).toBe(true);
});

test('@p3 verify nothing is green while the checks are still running', async ({ page }) => {
  // Hold the evidence download back: the page must stay in "Checking…" and never show a pass.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/localhost:1643\/bytes\//, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(capturePage(good.entityKey));
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pending');
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id)).toHaveAttribute('data-status', 'pending');
  }
  // Storage (E) reads on its own and may already have an answer; the capture checks must not.
  await expect(page.locator('[data-check="A"],[data-check="B"],[data-check="C"],[data-check="D"]').locator('[data-status="pass"]')).toHaveCount(0);
  await expect(page.getByText(/^Checks passed/)).toHaveCount(0);
  release();
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
});

test('@p3 verify changing the file never shows a stale pass or a stale match', async ({ page }) => {
  await page.goto(capturePage(good.entityKey));
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  const chooser = fileInput(page, 'File to compare');
  await chooser.setInputFiles(file('notice.html', good.body, 'text/html'));
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'pass');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');

  // From here on, record every state the DOM goes through.
  await page.evaluate(() => {
    type Snap = { verdict: string | null; d: string | null; file: string | null };
    const log: Snap[] = [];
    (window as unknown as { __log: Snap[] }).__log = log;
    const snap = (): Snap => ({
      verdict: document.querySelector('[data-verdict]')?.getAttribute('data-verdict') ?? null,
      d: document.querySelector('[data-check="D"] [data-status]')?.getAttribute('data-status') ?? null,
      file: document.querySelector('.file-line .mono')?.textContent ?? null,
    });
    new MutationObserver(() => log.push(snap())).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await chooser.setInputFiles(file('other.html', new TextEncoder().encode('<p>something else</p>'), 'text/html'));
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'fail');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'fail');

  const log = await page.evaluate(
    () => (window as unknown as { __log: { verdict: string | null; d: string | null; file: string | null }[] }).__log,
  );
  const forNew = log.filter((e) => e.file === 'other.html');
  expect(forNew.length).toBeGreaterThan(0);
  // While the new file is shown, neither a pass verdict nor a D match may ever appear:
  // those belong to the previous file. The in-between state is "Checking…".
  expect(forNew.filter((e) => e.verdict === 'pass' || e.d === 'pass')).toEqual([]);
  expect(forNew.some((e) => e.verdict === 'pending' && e.d === 'pending')).toBe(true);
});

test('@p3 verify a dropped evidence file is verified offline', async ({ page, context }) => {
  await page.goto(`${APP}/#/`);
  await expect(page.getByRole('heading', { level: 1, name: 'Recall' })).toBeVisible();
  await page.waitForLoadState('networkidle'); // the app has loaded everything it needs
  await expect(page.getByText('Drop an evidence file to verify')).toBeVisible();
  await expect(page.getByText('Works offline. The file never leaves your browser.')).toBeVisible();

  // No network from here on: the file must be checked inside the browser.
  await context.setOffline(true);
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  await fileInput(page, 'Evidence file').setInputFiles(file('evidence.json', good.evidenceBytes, 'application/json'));

  await expect(page).toHaveURL(/#\/file$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(NOTICE_HOST);
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass');
  }
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'unavailable');
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'E')).toContainText('not checked');
  await expect(page.getByText('Checked offline. A–C ran in your browser; storage (E) was not checked.')).toBeVisible();
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
  await expect(page.locator('.exhibit')).toContainText(good.url);

  // D works offline too.
  await fileInput(page, 'File to compare').setInputFiles(file('notice.html', good.body, 'text/html'));
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'pass');
  expect(requested.filter((u) => /:(8545|1633|1643|9545)\b/.test(u))).toEqual([]);
});

test('@p3 verify dropped tampered evidence shows A failed in red', async ({ page }) => {
  await page.goto(`${APP}/#/`);
  await fileInput(page, 'Evidence file').setInputFiles(file('tampered.json', tamperEvidence(good.evidence), 'application/json'));

  await expect(page).toHaveURL(/#\/file$/);
  await expect(status(page, 'A')).toHaveAttribute('data-status', 'fail');
  await expect(check(page, 'A')).toContainText('The evidence was changed after signing.');
  // Failed means red: the badge uses the --fail colour (#b3261e in the light theme).
  await expect(status(page, 'A')).toHaveCSS('color', 'rgb(179, 38, 30)');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'fail');
  await expect(verdict(page)).toHaveText("A check failed. Don't rely on this capture.");
  // Nothing about the tampered capture is presented as fact, and nothing is green about its bytes.
  await expect(page.locator('.exhibit')).toHaveCount(0);
  await expect(page.getByText(/Checks passed/)).toHaveCount(0);
  await expect(status(page, 'B')).not.toHaveAttribute('data-status', 'pass');
});

test('@p3 verify an impossible signed time cannot crash the page or pass', async ({ page }) => {
  // A uint64 signedAt of 2^64-1: not a date. It once made `toISOString()` throw and blank the app.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const rec = await record(`/notice?run=${randomBytes(6).toString('hex')}`);
  const forever = 2n ** 64n - 1n;
  const stranger = await signEvidence(rec, { key: `0x${randomBytes(32).toString('hex')}` as Hex, override: { signedAt: forever } });
  const trusted = await signEvidence(rec, { key: DEVNET_WITNESS_KEY, override: { signedAt: forever } });

  for (const [who, signed, kind] of [
    ['an unpinned witness', stranger, 'warn'],
    ['the pinned witness', trusted, 'na'],
  ] as const) {
    await page.goto(`${APP}/#/`);
    await fileInput(page, 'Evidence file').setInputFiles(file('evidence.json', encodeEvidence(signed.evidence), 'application/json'));
    await expect(page).toHaveURL(/#\/file$/);
    await expect(page.getByRole('heading', { level: 1 }), who).toContainText(NOTICE_HOST);
    await expect(page.locator('.exhibit'), who).toContainText('Invalid time');
    await expect(page.locator('time[datetime]'), who).toHaveCount(0);
    await expect(page.getByText(/Couldn't display/), who).toHaveCount(0);
    // Never a pass: an unpinned signer warns, and even the pinned witness cannot make a time up.
    await expect(verdict(page), who).toHaveAttribute('data-verdict', kind);
    await expect(page.getByText(/Checks passed/), who).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('@p3 verify a page that fails to draw shows no result at all', async ({ page }) => {
  // Make the one date call the detail page makes throw, as an unforeseen value could.
  await page.addInitScript(() => {
    Date.prototype.toISOString = () => {
      throw new RangeError('boom');
    };
  });
  await page.goto(capturePage(good.entityKey));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("Couldn't display this record");
  await expect(page.getByText('Nothing here counts as checked.')).toBeVisible();
  // No verdict, no badge, no exhibit: nothing in the fallback can read as a pass.
  await expect(page.locator('main').locator('[data-verdict], [data-status], .exhibit')).toHaveCount(0);
  // The next page starts fresh.
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Recall' })).toBeVisible();
});

test('@p3 verify a file that is not evidence is refused', async ({ page }) => {
  await page.goto(`${APP}/#/`);
  await fileInput(page, 'Evidence file').setInputFiles(file('notes.json', new TextEncoder().encode('{"hello":1}'), 'application/json'));
  await expect(
    page.getByText("This isn't a Recall evidence file. Choose the .json file you downloaded from Recall."),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
  await fileInput(page, 'Evidence file').setInputFiles(file('bytes.json', randomBytes(64), 'application/json'));
  await expect(
    page.getByText("This isn't a Recall evidence file. Choose the .json file you downloaded from Recall."),
  ).toBeVisible();
});

test('@p3 verify unknown witness shows C warning', async ({ page }) => {
  const stranger = await rig.publish({ witnessKey: (`0x${randomBytes(32).toString('hex')}`) as Hex });
  await page.goto(capturePage(stranger.entityKey));
  await expect(status(page, 'C')).toHaveAttribute('data-status', 'warn');
  await expect(check(page, 'C')).toContainText(/unknown witness/i);
  await expect(check(page, 'C')).toContainText(stranger.witness);
  // A and B still passed, but the verdict is neither green nor "Checks passed".
  await expect(status(page, 'A')).toHaveAttribute('data-status', 'pass');
  await expect(status(page, 'B')).toHaveAttribute('data-status', 'pass');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'warn');
  await expect(verdict(page)).toHaveText("Valid signature, but from a witness you haven't trusted.");
});

test('@p3 verify gateway serving altered bytes shows A unavailable, never verified', async ({ page }) => {
  // A gateway that flips one byte of every response, like a hostile or broken node.
  let served = 0;
  await page.route(/localhost:1643\/bytes\//, async (route) => {
    const res = await route.fetch();
    const body = Buffer.from(await res.body());
    body[Math.floor(body.length / 2)] ^= 0x01;
    served++;
    await route.fulfill({ response: res, body });
  });
  await page.goto(capturePage(good.entityKey));
  await expect(status(page, 'A')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'A')).toContainText(/evidence unavailable/i);
  expect(served).toBeGreaterThan(0);
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'na');
  await expect(verdict(page)).toHaveText("Couldn't fully verify.");
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id)).not.toHaveAttribute('data-status', 'pass');
  }
  await expect(page.getByText(/Checks passed/)).toHaveCount(0);
  // No facts from unproven bytes.
  await expect(page.locator('.exhibit')).toHaveCount(0);
});

test('@p3 verify missing ref shows evidence unavailable, never verified', async ({ page }) => {
  const orphan = await rig.write({
    ...good.row,
    evidenceRef: `0x${randomBytes(32).toString('hex')}` as Hex,
  });
  await page.goto(capturePage(orphan));
  await expect(status(page, 'A')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'A')).toContainText(/evidence unavailable/i);
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id)).not.toHaveAttribute('data-status', 'pass');
  }
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'na');
  await expect(verdict(page)).toHaveText("Couldn't fully verify.");
  await expect(page.getByText(/Checks passed/)).toHaveCount(0);
  await expect(page.locator('.exhibit')).toHaveCount(0);
});

test.describe('@p3 verify entity fields that do not match the evidence fail', () => {
  // R13: genuine evidence attached to a record that says something else (a swapped
  // evidence file) must fail, even though checks A to C pass on the evidence itself.
  const other = '0x' + 'ab'.repeat(32);
  const variants: [string, () => Partial<Published['row']>][] = [
    ['urlHash', () => ({ urlHash: urlHash(canonicalUrl('https://notice.recall.test/other')) })],
    ['bodySha256', () => ({ bodySha256: other as Hex })],
    ['witness', () => ({ witness: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' })],
    ['signedAt', () => ({ signedAt: good.signedAt + 1n })],
  ];
  for (const [field, patch] of variants) {
    test(`record with a different ${field}`, async ({ page }) => {
      const key = await rig.write({ ...good.row, ...patch() });
      await page.goto(capturePage(key));
      await expect(page.getByText('Record does not match its evidence')).toBeVisible();
      // The evidence itself is genuine (A to C pass): only the record cross-check fails.
      for (const id of ['A', 'B', 'C'] as const) {
        await expect(status(page, id), `check ${id}`).toHaveAttribute('data-status', 'pass');
      }
      await expect(verdict(page)).toHaveAttribute('data-verdict', 'fail');
      await expect(verdict(page)).toHaveText("A check failed. Don't rely on this capture.");
      await expect(page.getByText(/Checks passed/)).toHaveCount(0);
      // The evidence's facts are not shown for a record that does not match them.
      await expect(page.locator('.exhibit')).toHaveCount(0);
    });
  }
});

test('@p3 verify expired storage warns in E but does not change the verdict', async ({ page }) => {
  const key = await rig.write({ ...good.row, batchId: `0x${randomBytes(32).toString('hex')}` as Hex });
  await page.goto(capturePage(key));
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'warn');
  await expect(check(page, 'E')).toContainText(/expired|not found/i);
  // E never counts toward the verdict: A to C passed, so it says so.
  for (const id of ['A', 'B', 'C'] as const) {
    await expect(status(page, id)).toHaveAttribute('data-status', 'pass');
  }
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
});

test('@p3 verify storage is never green when the Arkiv expiry cannot be read', async ({ page }) => {
  // Registered after the CORS shim, so it sees the request first and passes the others on.
  await page.route(/^http:\/\/localhost:8545\//, async (route) => {
    const body = route.request().postData() ?? '';
    if (!body.includes('arkiv_getBlockTiming')) return route.fallback();
    const { id } = JSON.parse(body) as { id: number };
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }),
    });
  });
  await page.goto(capturePage(good.entityKey));
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'E')).toContainText('Arkiv record expiry could not be read');
  // E informs only: the capture checks are untouched.
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
});

test('@p3 verify storage that cannot be read at all is Not checked, not stuck on Checking', async ({ page }) => {
  await page.route(/^http:\/\/localhost:9545\//, (route) => route.abort());
  await page.goto(capturePage(good.entityKey));
  await expect(status(page, 'E')).toHaveAttribute('data-status', 'unavailable');
  await expect(check(page, 'E')).toContainText('Storage status not checked (offline or RPC unreachable).');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');
});

test('@p3 verify a link to a record that does not exist says so', async ({ page }) => {
  await page.goto(capturePage(`0x${'12'.repeat(32)}` as Hex));
  await expect(page.getByText('Record not found')).toBeVisible();
  await expect(page.getByText(/Checks passed/)).toHaveCount(0);
  await expect(page.locator('[data-status="pass"]')).toHaveCount(0);
  await page.goto(`${APP}/#/c/not-a-key`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
});

test('@p3 verify home search goes to the timeline of the canonical address', async ({ page }) => {
  await page.goto(`${APP}/#/`);
  const input = page.getByLabel('Page address');
  await expect(input).toHaveAttribute('placeholder', 'https://example.org/notice');
  await input.fill('example.org/notice');
  await page.getByRole('button', { name: 'Show captures' }).click();
  await expect(page.getByText('Enter a full address starting with https://')).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);

  await input.fill('HTTPS://Notice.Recall.test:443/notice?run=7#section');
  await page.getByRole('button', { name: 'Show captures' }).click();
  const expected = urlHash(canonicalUrl('https://notice.recall.test/notice?run=7'));
  await expect(page).toHaveURL(`${APP}/#/u/${expected}`);
});

test('@p3 verify a raw file plus its address finds the matching capture', async ({ page }) => {
  // A capture of its own URL, so exactly one record can match.
  const own = await rig.publish();
  await page.goto(`${APP}/#/`);
  await page.getByText('Compare a file with captures').click();
  await page.getByLabel('Address the file came from').fill(own.url);
  await fileInput(page, 'File to compare').setInputFiles(file('notice.html', own.body, 'text/html'));
  await expect(page).toHaveURL(new RegExp(`#/c/${own.entityKey}$`));
  // The detail page ran check D against the verified capture.
  await expect(status(page, 'D')).toHaveAttribute('data-status', 'pass');
  await expect(verdict(page)).toHaveAttribute('data-verdict', 'pass');

  // A file with other bytes finds nothing and says so without claiming anything.
  await page.goto(`${APP}/#/`);
  await page.getByText('Compare a file with captures').click();
  await page.getByLabel('Address the file came from').fill(own.url);
  await fileInput(page, 'File to compare').setInputFiles(file('x.html', new TextEncoder().encode('<p>nope</p>'), 'text/html'));
  await expect(page.getByText('No capture of this address has these exact bytes.')).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
});

test('@p3 verify a junk record claiming the file\'s hash is never opened as a match', async ({ page }) => {
  // Anyone can index a record with any content hash; only verified evidence may match a file.
  const real = await rig.publish();
  const junkUrl = canonicalUrl(`https://${NOTICE_HOST}/notice?junk=${randomBytes(6).toString('hex')}`);
  await rig.write({
    ...real.row,
    urlHash: urlHash(junkUrl),
    canonicalUrl: junkUrl,
    evidenceRef: `0x${randomBytes(32).toString('hex')}` as Hex,
  });
  await page.goto(`${APP}/#/`);
  await page.getByText('Compare a file with captures').click();
  await page.getByLabel('Address the file came from').fill(junkUrl);
  await fileInput(page, 'File to compare').setInputFiles(file('notice.html', real.body, 'text/html'));
  await expect(page.getByText('Records were found, but none passed their checks.')).toBeVisible();
  await expect(page).toHaveURL(/#\/$/);
});
