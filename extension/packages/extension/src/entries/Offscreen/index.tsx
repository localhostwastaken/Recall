// Offscreen document: owns the tlsn-wasm prover (a worker) and runs captures for the
// service worker. Recall fork: the upstream plugin host (SessionManager, plugin
// execution, reveal approval overlays, page relay) was removed; captures start only
// from the popup, through the service worker.
import { logger } from '@tlsn/common';
import { getStoredLogLevel } from '../../utils/logLevelStorage';
import { captureUrl, proveManager } from '../../recall/capture';
import type { CaptureOutcome } from '../../recall/captureParts';
import type {
  CaptureResultMessage,
  CaptureStepMessage,
  OffscreenCapture,
  RecallMessage,
} from '../../recall/messages';

getStoredLogLevel().then((level) => {
  logger.init(level);
  logger.info('Offscreen document loaded');
});

// Load the wasm prover now, so the first capture does not wait for it.
proveManager().catch((err) => logger.error('[recall] prover init failed', err));

const running = new Map<string, AbortController>();

function send(msg: CaptureStepMessage | CaptureResultMessage): void {
  chrome.runtime
    .sendMessage(msg)
    .catch((err) => logger.warn('[recall] message to service worker failed', err));
}

async function run(req: OffscreenCapture): Promise<void> {
  const ctl = new AbortController();
  running.set(req.id, ctl);
  let outcome: CaptureOutcome;
  try {
    outcome = await captureUrl(req.url, {
      witnessUrl: req.witnessUrl,
      maxRecvData: req.maxRecvData,
      overrides: req.overrides,
      signal: ctl.signal,
      onStep: (step) => send({ type: 'recall.capture.step', id: req.id, step }),
    });
  } catch (err) {
    outcome = { error: err instanceof Error ? err.message : String(err), code: 'failed' };
  } finally {
    running.delete(req.id);
  }
  send({ type: 'recall.capture.result', id: req.id, outcome });
}

// Registered at load (not in a framework effect), so the first message is never missed.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const msg = raw as RecallMessage;
  if (msg?.type === 'recall.offscreen.capture') {
    void run(msg);
    sendResponse({ accepted: true });
  } else if (msg?.type === 'recall.offscreen.cancel') {
    running.get(msg.id)?.abort();
    sendResponse({ ok: true });
  }
});
