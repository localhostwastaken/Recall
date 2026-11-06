// Offscreen document: owns the tlsn-wasm prover (a worker) and runs captures for the
// service worker; then stamps and uploads the evidence to Swarm, and reads Arkiv
// records for the service worker. Recall fork: the upstream plugin host
// (SessionManager, plugin execution, reveal approval overlays, page relay) was removed;
// captures start only from the popup, through the service worker.
import { logger } from '@tlsn/common';
import { getStoredLogLevel } from '../../utils/logLevelStorage';
import { captureUrl, proveManager } from '../../recall/capture';
import type { CaptureOutcome } from '../../recall/captureParts';
import { uploadEvidence } from '../../recall/swarmUpload';
import { readEntitySummary } from '../../recall/arkivRead';
import type { UploadOutcome } from '../../recall/uploadParts';
import type {
  CaptureResultMessage,
  CaptureStepMessage,
  OffscreenCapture,
  OffscreenUpload,
  RecallMessage,
  UploadResultMessage,
} from '../../recall/messages';

getStoredLogLevel().then((level) => {
  logger.init(level);
  logger.info('Offscreen document loaded');
});

// Load the wasm prover now, so the first capture does not wait for it.
proveManager().catch((err) => logger.error('[recall] prover init failed', err));

const running = new Map<string, AbortController>();

function send(msg: CaptureStepMessage | CaptureResultMessage | UploadResultMessage): void {
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

// Uploads run one at a time, so two jobs never stamp the same batch at once.
let uploads: Promise<unknown> = Promise.resolve();

/** Never logs the request: it carries the stamp key. */
function upload(req: OffscreenUpload): void {
  const ctl = new AbortController();
  running.set(req.id, ctl);
  const run = async () => {
    let outcome: UploadOutcome;
    try {
      outcome = await uploadEvidence(req, {}, ctl.signal);
    } catch (err) {
      outcome = {
        ok: false,
        code: 'failed',
        error: err instanceof Error ? err.message : String(err),
        updates: [],
      };
    } finally {
      running.delete(req.id);
    }
    send({ type: 'recall.upload.result', id: req.id, outcome });
  };
  // Runs after the previous upload whether it resolved or rejected, so one failure can
  // never stall the uploads queued behind it.
  uploads = uploads.then(run, run);
}

// Registered at load (not in a framework effect), so the first message is never missed.
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const msg = raw as RecallMessage;
  if (msg?.type === 'recall.offscreen.capture') {
    void run(msg);
    sendResponse({ accepted: true });
  } else if (msg?.type === 'recall.offscreen.upload') {
    upload(msg);
    sendResponse({ accepted: true });
  } else if (msg?.type === 'recall.offscreen.readEntity') {
    readEntitySummary(msg.net, msg.entityKey).then(sendResponse, (err) =>
      sendResponse({ error: err instanceof Error ? err.message : String(err) }),
    );
    return true; // async response
  } else if (msg?.type === 'recall.offscreen.cancel') {
    running.get(msg.id)?.abort();
    sendResponse({ ok: true });
  }
});
