import { RECALL_DEV, DEV_ROOT_CERTS } from './build';
import { ensureSettings } from './settings';

/** Recall's service-worker setup: default settings, plus a test handle in dev builds. */
export function initRecallBackground(): void {
  chrome.runtime.onInstalled.addListener(() => {
    ensureSettings().catch((err) => console.error('[recall] settings init failed', err));
  });
  if (RECALL_DEV) {
    // Read by Playwright through the service worker (e2e/fixtures/extension.ts).
    (globalThis as unknown as { recall: object }).recall = {
      build: { dev: true, devCa: DEV_ROOT_CERTS !== undefined },
    };
  }
}
