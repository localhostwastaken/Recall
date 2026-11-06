import { expect, test, type Page, type Worker } from '@playwright/test';
import { sha256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { launchWithExtension, NOTICE_HOST, tabIdFor, type ExtensionSession } from '../fixtures/extension';
import { DEVNET_WITNESS_ADDRESS } from '../fixtures/keys';
import {
  base64ToBytes,
  bytesToBase64,
  runChecks,
  type EvidenceFile,
} from '../../packages/evidence/src/index';

// Real MPC-TLS captures: the dev extension build proves fixture pages against the
// devnet witness (WITNESS_DEV_CA_DER), which signs the EIP-712 statement. One browser
// for the whole file; captures run one at a time (the witness has no session cap yet).

type CaptureOverrides = {
  mode?: 'Proxy';
  extraHeaders?: Record<string, string>;
  recvRevealEnd?: number;
  commit?: boolean;
  hostHeader?: string;
};
type ExtensionChecks = Record<'A' | 'B' | 'C', { status: string; detail: string }>;
type CaptureResult = { evidence: EvidenceFile; checks: ExtensionChecks } | { error: string };

const url = (path: string) => `https://${NOTICE_HOST}${path}`;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

let ext: ExtensionSession;
let noticeCapture: Promise<CaptureResult> | undefined;

/**
 * The extension's live service worker. Chrome sometimes replaces it once, within about
 * a second of launch, while Playwright still holds the first one; always look it up.
 */
function sw(): Worker {
  const live = ext.context.serviceWorkers().filter((w) => w.url().includes(ext.extensionId));
  return live[live.length - 1] ?? ext.serviceWorker;
}

/** Waits until the same service worker has stayed up for 1.5 s. */
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

/** Witness conditions worth one retry: busy, admission limits, or the known rare setup hang. */
const RETRYABLE = /witness busy|too many sessions|did not connect in time|timed out/i;

async function capture(path: string, overrides?: CaptureOverrides): Promise<CaptureResult> {
  const first = await captureOnce(path, overrides);
  if ('error' in first && RETRYABLE.test(first.error)) {
    test.info().annotations.push({ type: 'retried capture', description: `${path}: ${first.error}` });
    return captureOnce(path, overrides);
  }
  return first;
}

async function captureOnce(path: string, overrides?: CaptureOverrides): Promise<CaptureResult> {
  return sw().evaluate(
    async ([u, o]) => {
      const g = globalThis as unknown as {
        recall?: { captureForTest?: (url: string, o?: object) => Promise<unknown> };
      };
      if (!g.recall?.captureForTest) return { error: 'no recall.captureForTest in this build' };
      return g.recall.captureForTest(u, o);
    },
    [url(path), overrides] as const,
  ) as Promise<CaptureResult>;
}

function evidenceOf(r: CaptureResult): EvidenceFile {
  if (!('evidence' in r)) throw new Error(`capture failed: ${r.error}`);
  return r.evidence;
}

/** The /notice capture, shared by the tests that only inspect its evidence. */
const notice = () => (noticeCapture ??= capture('/notice'));

/** Chrome storage read/write through the extension's service worker. */
async function storage(area: 'local' | 'session', key: string, value?: unknown): Promise<unknown> {
  return sw().evaluate(
    async ([a, k, v, write]) => {
      type Area = { get(k: string): Promise<Record<string, unknown>>; set(i: object): Promise<void> };
      const s = (globalThis as unknown as { chrome: { storage: Record<string, Area> } }).chrome.storage[a];
      if (write) await s.set({ [k]: v });
      return (await s.get(k))[k];
    },
    [area, key, value, value !== undefined] as const,
  );
}

async function openPopupFor(path: string): Promise<{ tab: Page; popup: Page }> {
  const tab = await ext.context.newPage();
  await tab.goto(url(path));
  const tabId = await tabIdFor(sw(), url(path));
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
  return { tab, popup };
}

test.describe('@p1 capture', () => {
  test.describe.configure({ timeout: 150_000 });

  test.beforeAll(async () => {
    ext = await launchWithExtension({ dev: true });
    await settleServiceWorker();
    // The notice fixture serves version 1 ("Deadline: 15 December") unless a test changed it.
    const page = await ext.context.newPage();
    await page.goto(url('/notice'));
    const reset = await page.evaluate(async () => {
      const res = await fetch('/__admin/version', { method: 'POST', body: JSON.stringify({ v: 1 }) });
      return res.status;
    });
    await page.close();
    expect(reset).toBe(200);
  });

  test.afterAll(async () => {
    await ext?.context.close();
  });

  test('dev build is labelled and exposes the test hook', async () => {
    const info = await sw().evaluate(() => {
      const g = globalThis as unknown as {
        chrome: { runtime: { getManifest(): { name: string } } };
        recall?: { captureForTest?: unknown };
      };
      return { name: g.chrome.runtime.getManifest().name, hook: typeof g.recall?.captureForTest };
    });
    expect(info).toEqual({ name: 'Recall (dev)', hook: 'function' });
  });

  test('captures fixture notice and all checks pass', async () => {
    const t0 = Date.now();
    const r = await notice();
    const e = evidenceOf(r);
    test.info().annotations.push({ type: 'capture ms', description: String(Date.now() - t0) });

    // The extension ran the same checks itself (default settings pin no witness: C warns).
    const own = (r as { checks: ExtensionChecks }).checks;
    expect([own.A.status, own.B.status, own.C.status], JSON.stringify(own)).toEqual(['pass', 'pass', 'warn']);

    expect(e.schema).toBe('recall.evidence.v1');
    expect(e.signer).toBe(DEVNET_WITNESS_ADDRESS);
    expect(e.statement.serverName).toBe(NOTICE_HOST);
    expect(e.statement.tlsVersion).toBe(12);
    expect(e.meta.capturedUrl).toBe(url('/notice'));

    const report = await runChecks(e, { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    expect(report.A.status, report.A.detail).toBe('pass');
    expect(report.B.status, report.B.detail).toBe('pass');
    expect(report.C.status, report.C.detail).toBe('pass');
    expect(report.facts?.canonicalUrl).toBe(url('/notice'));
    expect(report.facts?.httpStatus).toBe(200);
    expect(text(report.facts!.body)).toContain('15 December');

    // R20: only allowlisted request headers, identity encoding, no cookies.
    // (hyper writes header names in lower case)
    const sent = text(base64ToBytes(e.transcript.sent)).toLowerCase();
    expect(sent).toMatch(/^get \/notice http\/1\.1\r\n/);
    expect(sent).toContain('\r\naccept-encoding: identity\r\n');
    expect(sent).toContain('\r\nhost: notice.recall.test\r\n');
    expect(sent).not.toContain('cookie');
  });

  test('pdf capture works', async () => {
    const e = evidenceOf(await capture('/notice.pdf'));
    const report = await runChecks(e, { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    expect(report.A.status, report.A.detail).toBe('pass');
    expect(report.B.status, report.B.detail).toBe('pass');
    expect(report.facts?.contentType).toBe('application/pdf');
    expect(text(report.facts!.body.subarray(0, 5))).toBe('%PDF-');
  });

  test('chunked page hashes de-chunked body', async () => {
    const e = evidenceOf(await capture('/chunked'));
    expect(text(base64ToBytes(e.transcript.recv))).toMatch(/transfer-encoding: chunked/i);
    const report = await runChecks(e, { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    expect(report.B.status, report.B.detail).toBe('pass');
    const body =
      '<!doctype html><html><body><h1>Mumbai Institute of Studies — Admissions Notice</h1>' +
      '<p>chunked response</p></body></html>';
    expect(text(report.facts!.body)).toBe(body);
    expect(report.facts!.bodySha256).toBe(sha256(toBytes(body)));
  });

  test('page over 64 KB fails fast with size message', async () => {
    const t0 = Date.now();
    const r = await capture('/big');
    const ms = Date.now() - t0;
    expect('error' in r && r.error).toMatch(/too large/);
    expect(ms).toBeLessThan(10_000);
  });

  const rejected: [string, CaptureOverrides, string][] = [
    ['proxy mode', { mode: 'Proxy' }, 'recall: proxy mode not allowed'],
    ['cookie header', { extraHeaders: { Cookie: 'a=1' } }, 'recall: cookies/auth not allowed'],
    ['partial reveal', { recvRevealEnd: 100 }, 'recall: partial reveal not allowed'],
    ['hash commitment', { commit: true }, 'recall: commitments not allowed'],
    ['host header mismatch', { hostHeader: 'evil.example' }, 'recall: host mismatch'],
    ['non-allowlisted header', { extraHeaders: { Range: 'bytes=0-10' } }, 'recall: header not allowed: range'],
  ];
  for (const [name, overrides, message] of rejected) {
    test(`${name} rejected with the witness message`, async () => {
      const r = await capture('/notice', overrides);
      expect('error' in r ? r.error : 'captured', JSON.stringify(overrides)).toBe(message);
    });
  }

  test('tampered evidence fails A', async () => {
    const e = evidenceOf(await notice());
    const recv = base64ToBytes(e.transcript.recv);
    recv[recv.length - 10] ^= 0x01;
    const tampered = { ...e, transcript: { ...e.transcript, recv: bytesToBase64(recv) } };
    const report = await runChecks(tampered, { pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    expect(report.A.status).toBe('fail');
    expect(report.facts).toBeUndefined();
  });

  test('unknown witness warns C', async () => {
    const e = evidenceOf(await notice());
    const stranger = privateKeyToAddress(generatePrivateKey());
    const report = await runChecks(e, { pinnedWitnesses: [stranger] });
    expect(report.A.status).toBe('pass');
    expect(report.C.status).toBe('warn');
  });

  test('popup capture shows steps then passed checks', async () => {
    const settings = (await storage('local', 'recall.settings')) as Record<string, unknown>;
    await storage('local', 'recall.settings', { ...settings, pinnedWitnesses: [DEVNET_WITNESS_ADDRESS] });
    const { tab, popup } = await openPopupFor('/notice');
    try {
      await expect(popup.getByText('Witness online')).toBeVisible();
      const button = popup.getByRole('button', { name: 'Capture this page' });
      await expect(button).toBeEnabled();
      await button.click();
      await expect(popup.getByText('Step 2 of 3')).toBeVisible({ timeout: 30_000 });
      await expect(popup.getByText('Proving the page with the witness')).toBeVisible();
      await expect(popup.getByText(/elapsed · usually 15–30 s/)).toBeVisible();

      await expect(popup.getByRole('heading', { name: 'Checks passed' })).toBeVisible({ timeout: 120_000 });
      await expect(popup.getByText(`The witness saw these exact bytes from ${NOTICE_HOST}`)).toBeVisible();
      for (const title of [
        'Bytes match the signed hashes',
        'Request and response are well-formed',
        'Signed by a trusted witness',
      ]) {
        const row = popup.getByRole('listitem').filter({ hasText: title });
        await expect(row.getByText('Passed')).toBeVisible();
      }
    } finally {
      await storage('local', 'recall.settings', settings);
      await popup.close();
      await tab.close();
    }
  });

  test('cancel stops the capture and the next capture still works', async () => {
    const { tab, popup } = await openPopupFor('/notice');
    try {
      await popup.getByRole('button', { name: 'Capture this page' }).click();
      await expect(popup.getByText('Step 2 of 3')).toBeVisible({ timeout: 30_000 });
      await popup.getByRole('button', { name: 'Cancel capture' }).click();
      await expect(popup.getByRole('heading', { name: 'Capture cancelled. Nothing was published.' })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Capture this page' })).toBeEnabled();
    } finally {
      await popup.close();
      await tab.close();
    }
    const again = await capture('/notice');
    expect('evidence' in again ? 'captured' : again.error).toBe('captured');
  });

  test('capture keeps running after the popup closes', async () => {
    const { tab, popup } = await openPopupFor('/notice');
    try {
      await popup.getByRole('button', { name: 'Capture this page' }).click();
      await expect(popup.getByText('Step 1 of 3').or(popup.getByText('Step 2 of 3'))).toBeVisible();
      await popup.close();

      await expect
        .poll(async () => ((await storage('session', 'recall.capture')) as { status?: string } | undefined)?.status, {
          timeout: 120_000,
          intervals: [1_000],
        })
        .toBe('done');

      const again = await ext.context.newPage();
      const tabId = await tabIdFor(sw(), url('/notice'));
      await again.goto(`chrome-extension://${ext.extensionId}/popup.html?tab=${tabId}`);
      // Default settings pin no witness, so C is a warning and the verdict says so (never green).
      await expect(
        again.getByRole('heading', { name: "Valid signature, but from a witness you haven't trusted" }),
      ).toBeVisible();
      await again.close();
    } finally {
      if (!popup.isClosed()) await popup.close();
      await tab.close();
    }
  });
});
