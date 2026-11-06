import { RECALL_DEV, DEV_ROOT_CERTS } from './build';
import { ensureSettings } from './settings';
import { ensureOffscreen } from './offscreen';
import {
  cancelCapture,
  captureForTest,
  dismissCapture,
  onCaptureResult,
  onCaptureStep,
  startCapture,
} from './job';
import type { RecallMessage } from './messages';

/** Messages from our own pages only: the popup and the offscreen document. */
function fromOwnPage(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id && (sender.url ?? '').startsWith(chrome.runtime.getURL(''))
  );
}

/** Recall's service-worker setup: default settings, the capture job, and a test handle in dev builds. */
export function initRecallBackground(): void {
  chrome.runtime.onInstalled.addListener(() => {
    ensureSettings().catch((err) => console.error('[recall] settings init failed', err));
  });

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!fromOwnPage(sender)) return;
    const msg = raw as RecallMessage;
    const reply = (p: Promise<unknown>) => {
      p.then(sendResponse, (err) => sendResponse({ error: String(err) }));
      return true; // async response
    };
    switch (msg?.type) {
      case 'recall.startCapture':
        // The popup never sends overrides; only the dev test hook below can.
        return reply(startCapture(msg.url));
      case 'recall.cancelCapture':
        return reply(cancelCapture().then(() => ({ ok: true })));
      case 'recall.dismissCapture':
        return reply(dismissCapture().then(() => ({ ok: true })));
      case 'recall.capture.step':
        void onCaptureStep(msg.id, msg.step);
        return;
      case 'recall.capture.result':
        void onCaptureResult(msg.id, msg.outcome);
        return;
      default:
        return;
    }
  });

  ensureOffscreen().catch((err) => console.error('[recall] offscreen document failed', err));

  if (RECALL_DEV) {
    // Read by Playwright through the service worker (e2e/fixtures/extension.ts).
    (globalThis as unknown as { recall: object }).recall = {
      build: { dev: true, devCa: DEV_ROOT_CERTS !== undefined },
      captureForTest,
    };
  }
}
