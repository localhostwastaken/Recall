// Loads a RELEASE extension folder in Chromium ("Load unpacked", persistent context) and checks
// that chrome.runtime.id is the fixed ID. Needs no devnet and no network.
//   node scripts/check-release-extension-id.mjs [folder]   (default: the release build folder)
// Run it on the unzipped dist/recall-extension.zip to check what teammates get.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(process.argv[2] ?? join(ROOT, 'extension/packages/extension/build-release'));
if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`No manifest.json in ${dir}`);

const { RELEASE_EXTENSION_ID } = createRequire(import.meta.url)(join(ROOT, 'extension/packages/extension/utils/recallManifest.js'));

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const fromUrl = new URL(worker.url()).host;
  // Straight after launch the worker's chrome APIs can still be missing: wait for chrome.runtime.
  let runtimeId;
  for (const deadline = Date.now() + 15_000; !runtimeId && Date.now() < deadline; ) {
    runtimeId = await context.serviceWorkers().at(-1).evaluate(() => globalThis.chrome?.runtime?.id).catch(() => undefined);
    if (!runtimeId) await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`chrome.runtime.id = ${runtimeId}\nexpected          = ${RELEASE_EXTENSION_ID}`);
  if (runtimeId !== RELEASE_EXTENSION_ID || fromUrl !== RELEASE_EXTENSION_ID) {
    throw new Error(`extension ID mismatch (service worker host ${fromUrl})`);
  }
  console.log('OK: the release extension has the fixed ID');
} finally {
  await context.close();
}
