import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';

/** Output of `npm run build` in `extension/` (see extension/README.md). */
export const EXTENSION_BUILD_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../extension/packages/extension/build',
);

/** Host of the TLS 1.2 notice fixture served by the devnet on 127.0.0.1:443. */
export const NOTICE_HOST = 'notice.recall.test';

export type ExtensionSession = {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
};

/**
 * Launches Chromium with the built Recall extension in a fresh persistent profile.
 * `dev: true` maps `notice.recall.test` to the local devnet and accepts its test CA
 * in the browser tabs (the extension's prover trusts it through the dev-CA build flag).
 */
export async function launchWithExtension({ dev }: { dev: boolean }): Promise<ExtensionSession> {
  if (!existsSync(join(EXTENSION_BUILD_DIR, 'manifest.json'))) {
    throw new Error(
      `No extension build at ${EXTENSION_BUILD_DIR}. Build it first: cd extension && npm install && ` +
        'RECALL_DEV_CA_DER_B64=$(base64 -i ../fixtures/notice/.certs/ca.der) npm run build',
    );
  }
  const args = [
    `--disable-extensions-except=${EXTENSION_BUILD_DIR}`,
    `--load-extension=${EXTENSION_BUILD_DIR}`,
  ];
  if (dev) {
    args.push(`--host-resolver-rules=MAP ${NOTICE_HOST} 127.0.0.1`, '--ignore-certificate-errors');
  }
  // channel 'chromium' runs the full browser in new headless mode, which supports extensions.
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args,
  });
  try {
    const serviceWorker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
    const extensionId = new URL(serviceWorker.url()).host;
    return { context, extensionId, serviceWorker };
  } catch (err) {
    await context.close();
    throw err;
  }
}

/** The id of the first tab whose URL matches `urlPattern` (a chrome.tabs match pattern). */
export async function tabIdFor(serviceWorker: Worker, urlPattern: string): Promise<number> {
  const id = await serviceWorker.evaluate(async (pattern) => {
    const tabs = (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id?: number }[]> } } })
      .chrome.tabs;
    const [tab] = await tabs.query({ url: pattern });
    return tab?.id ?? null;
  }, urlPattern);
  if (id === null) throw new Error(`no tab matches ${urlPattern}`);
  return id;
}
