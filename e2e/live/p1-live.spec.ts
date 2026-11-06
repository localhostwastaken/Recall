import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { getAddress, type Address } from 'viem';
import { tabIdFor } from '../fixtures/extension';
import { runChecks, type EvidenceFile } from '../../packages/evidence/src/index';

// P1 live check: the RELEASE extension build (Mozilla roots, no test hook) captures the
// public GitHub Pages notice through the live witness behind the Cloudflare quick tunnel
// (`pnpm tunnel:up` writes WITNESS_PUBLIC_URL to .env.local). Driven through the popup.

const NOTICE_URL = 'https://localhostwastaken.github.io/Recall/notice/';
const NOTICE_HOST = 'localhostwastaken.github.io';
/** The live witness signer: the address of WITNESS_PRIVATE_KEY in .env.local. */
const LIVE_WITNESS: Address = '0xC9319e18e86cd7EB653c0Ed0693c0cf5B63db37D';
/** The container scripts/tunnel.sh starts (used only to measure traffic). */
const LIVE_CONTAINER = 'recall-witness-live';

const RELEASE_BUILD_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../extension/packages/extension/build-release',
);

/** Witness conditions worth one retry: busy, admission limits, or the known rare setup hang. */
const RETRYABLE = /witness busy|too many sessions|did not connect in time|timed out/i;

type CaptureState = {
  id: string;
  url: string;
  startedAt: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  finishedAt?: number;
  error?: string;
  evidence?: EvidenceFile;
  checks?: Record<'A' | 'B' | 'C', { status: string; detail: string }>;
};

let context: BrowserContext;
let extensionId: string;

/** The extension's live service worker (Chrome may replace the first one right after launch). */
function sw(): Worker {
  const live = context.serviceWorkers().filter((w) => w.url().includes(extensionId));
  if (!live.length) throw new Error('the extension service worker is gone');
  return live[live.length - 1];
}

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

/** Network counters of the live witness container, or null when docker is not reachable. */
function witnessTraffic(): { rx: number; tx: number } | null {
  try {
    const out = execFileSync(
      'docker',
      ['exec', LIVE_CONTAINER, 'cat', '/sys/class/net/eth0/statistics/rx_bytes', '/sys/class/net/eth0/statistics/tx_bytes'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const [rx, tx] = out.trim().split(/\s+/).map(Number);
    return Number.isFinite(rx) && Number.isFinite(tx) ? { rx, tx } : null;
  } catch {
    return null;
  }
}

/** Waits for a capture other than `previousId` to end, and returns its final state. */
async function finished(previousId?: string): Promise<CaptureState> {
  let last: CaptureState | undefined;
  await expect
    .poll(
      async () => {
        last = (await storage('session', 'recall.capture')) as CaptureState | undefined;
        return last && last.id !== previousId ? last.status : undefined;
      },
      { timeout: 200_000, intervals: [1_000] },
    )
    .toMatch(/^(done|error|cancelled)$/);
  return last!;
}

test.describe('@live p1', () => {
  test.beforeAll(async () => {
    if (!existsSync(join(RELEASE_BUILD_DIR, 'manifest.json'))) {
      throw new Error(`No release build at ${RELEASE_BUILD_DIR}. Run: pnpm extension:release`);
    }
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${RELEASE_BUILD_DIR}`, `--load-extension=${RELEASE_BUILD_DIR}`],
    });
    const first = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    extensionId = new URL(first.url()).host;
    await settleServiceWorker();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('p1 captures Pages notice via tunnel', async () => {
    test.setTimeout(480_000);

    // The release build: plain name, no dev test hook.
    const build = await sw().evaluate(() => {
      const g = globalThis as unknown as {
        chrome: { runtime: { getManifest(): { name: string } } };
        recall?: unknown;
      };
      return { name: g.chrome.runtime.getManifest().name, hook: typeof g.recall };
    });
    expect(build).toEqual({ name: 'Recall', hook: 'undefined' });

    // The tunnel serves the live witness, signing with the expected key.
    const witnessUrl = process.env.WITNESS_PUBLIC_URL ?? '';
    expect(witnessUrl, 'WITNESS_PUBLIC_URL (.env.local) must be the tunnel URL: run pnpm tunnel:up').toMatch(
      /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?$/,
    );
    const info = await fetch(new URL('/info', witnessUrl), { signal: AbortSignal.timeout(15_000) })
      .then((r) => r.json() as Promise<{ signer?: string }>)
      .catch((e: Error) => ({ error: `witness unreachable at ${witnessUrl}: ${e.message}` }));
    expect(info).toMatchObject({ signer: LIVE_WITNESS });

    const settings = ((await storage('local', 'recall.settings')) ?? {}) as Record<string, unknown>;
    await storage('local', 'recall.settings', {
      ...settings,
      witnessUrl: witnessUrl.replace(/\/$/, ''),
      pinnedWitnesses: [LIVE_WITNESS],
    });

    const tab = await context.newPage();
    await tab.goto(NOTICE_URL);
    const tabId = await tabIdFor(sw(), NOTICE_URL);
    let popup: Page = await context.newPage();
    const openPopup = async () => {
      // The popup's /info probe allows 2 s; a cold tunnel may need a second look.
      for (let i = 0; ; i++) {
        await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
        try {
          await expect(popup.getByText('Witness online')).toBeVisible({ timeout: 10_000 });
          return;
        } catch (err) {
          if (i === 2) throw err;
        }
      }
    };
    await openPopup();

    let attempts = 0;
    let state: CaptureState | undefined;
    let wallMs = 0;
    let traffic: { rx: number; tx: number } | null = null;
    for (;;) {
      attempts++;
      const before = witnessTraffic();
      const t0 = Date.now();
      const button =
        attempts === 1
          ? popup.getByRole('button', { name: 'Capture this page' })
          : popup.getByRole('button', { name: 'Try again' });
      await expect(button).toBeEnabled({ timeout: 15_000 });
      await button.click();
      state = await finished(state?.id);
      wallMs = Date.now() - t0;
      const after = witnessTraffic();
      traffic = before && after ? { rx: after.rx - before.rx, tx: after.tx - before.tx } : null;
      if (state.status === 'error' && attempts === 1 && RETRYABLE.test(state.error ?? '')) {
        test.info().annotations.push({ type: 'retried capture', description: state.error ?? '' });
        // Reopen the popup on its error notice, whose [Try again] retries the capture.
        if (popup.isClosed()) popup = await context.newPage();
        await openPopup();
        continue;
      }
      break;
    }
    expect(state.status, state.error).toBe('done');

    // The popup shows the green verdict with all three checks passed.
    await expect(popup.getByRole('heading', { name: 'Checks passed' })).toBeVisible({ timeout: 15_000 });
    await expect(popup.getByText(`The witness saw these exact bytes from ${NOTICE_HOST}`)).toBeVisible();
    for (const title of [
      'Bytes match the signed hashes',
      'Request and response are well-formed',
      'Signed by a trusted witness',
    ]) {
      await expect(popup.getByRole('listitem').filter({ hasText: title }).getByText('Passed')).toBeVisible();
    }
    const own = state.checks!;
    expect([own.A.status, own.B.status, own.C.status], JSON.stringify(own)).toEqual(['pass', 'pass', 'pass']);

    // Independent re-check of the evidence file outside the extension.
    const e = state.evidence!;
    expect(getAddress(e.signer)).toBe(LIVE_WITNESS);
    expect(e.statement.serverName).toBe(NOTICE_HOST);
    expect(e.statement.tlsVersion).toBe(12);
    const report = await runChecks(e, { pinnedWitnesses: [LIVE_WITNESS] });
    expect(report.A.status, report.A.detail).toBe('pass');
    expect(report.B.status, report.B.detail).toBe('pass');
    expect(report.C.status, report.C.detail).toBe('pass');
    expect(report.facts?.canonicalUrl).toBe(NOTICE_URL);
    expect(report.facts?.httpStatus).toBe(200);
    const body = new TextDecoder().decode(report.facts!.body);
    expect(body).toContain('15 December');

    const summary = {
      at: new Date().toISOString(),
      witnessHost: new URL(witnessUrl).host,
      signer: e.signer,
      attempts,
      jobMs: state.finishedAt! - state.startedAt,
      wallMs,
      sentLen: e.statement.sentLen,
      recvLen: e.statement.recvLen,
      bodyBytes: report.facts!.body.length,
      evidenceJsonBytes: JSON.stringify(e).length,
      witnessTrafficBytes: traffic,
      signedAt: String(report.facts!.signedAt),
      bodySha256: report.facts!.bodySha256,
    };
    console.log('P1 LIVE', JSON.stringify(summary));
    writeFileSync(test.info().outputPath('p1-live-summary.json'), JSON.stringify(summary, null, 2));
    test.info().annotations.push({ type: 'p1 live', description: JSON.stringify(summary) });

    await storage('local', 'recall.settings', settings);
    await popup.close();
    await tab.close();
  });
});
