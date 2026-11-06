// Offscreen document: owns the tlsn-wasm prover (a worker) and runs captures for the
// service worker; then stamps and uploads the evidence to Swarm, and reads Arkiv
// records (and checks the evidence of earlier captures) for the service worker. Recall fork: the upstream plugin host
// (SessionManager, plugin execution, reveal approval overlays, page relay) was removed;
// captures start only from the popup, through the service worker.
import { logger } from '@tlsn/common';
import { getStoredLogLevel } from '../../utils/logLevelStorage';
import { captureUrl, proveManager } from '../../recall/capture';
import type { CaptureOutcome } from '../../recall/captureParts';
import { uploadEvidence } from '../../recall/swarmUpload';
import { readEntitySummary } from '../../recall/arkivRead';
import { readHistory, readWitnessUrl } from '../../recall/historyRead';
import { repoSnapshot, type OffscreenRepoSnapshot, type RepoSnapshotResult } from '../../recall/repoSnapshot';
import type { UploadOutcome } from '../../recall/uploadParts';
import type {
  CaptureResultMessage,
  CaptureStepMessage,
  OffscreenCapture,
  OffscreenUpload,
  RecallMessage,
  RepoProgressMessage,
  UploadProgressMessage,
  UploadResultMessage,
} from '../../recall/messages';

getStoredLogLevel().then((level) => {
  logger.init(level);
  logger.info('Offscreen document loaded');
});

// Load the wasm prover now, so the first capture does not wait for it.
proveManager().catch((err) => logger.error('[recall] prover init failed', err));

const running = new Map<string, AbortController>();

function send(
  msg: CaptureStepMessage | CaptureResultMessage | UploadResultMessage | RepoProgressMessage | UploadProgressMessage,
): void {
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

/**
 * The repository snapshot of a capture (R46). A cancel of the capture job aborts it. While it
 * runs, the step is re-sent every 5 s, which keeps the service worker (waiting for the answer)
 * awake.
 */
async function snapshot(req: OffscreenRepoSnapshot): Promise<RepoSnapshotResult> {
  const ctl = new AbortController();
  running.set(req.id, ctl);
  let step: 4 | 5 = 4;
  const ping = setInterval(() => send({ type: 'recall.repo.progress', id: req.id, step }), 5_000);
  try {
    return await repoSnapshot(req, ctl.signal, {
      onStep: (s) => {
        step = s;
        send({ type: 'recall.repo.progress', id: req.id, step: s });
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearInterval(ping);
    running.delete(req.id);
  }
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
      // Progress of a big (repository snapshot) upload, at most once a second, plus the last.
      let last = 0;
      const onProgress = (done: number, total: number) => {
        if (done < total && Date.now() - last < 1_000) return;
        last = Date.now();
        send({ type: 'recall.upload.progress', id: req.id, done, total });
      };
      outcome = await uploadEvidence(req, { onProgress }, ctl.signal);
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
  } else if (msg?.type === 'recall.offscreen.history') {
    readHistory(msg).then(sendResponse);
    return true; // async response
  } else if (msg?.type === 'recall.offscreen.witnessUrl') {
    readWitnessUrl(msg).then(sendResponse);
    return true; // async response
  } else if (msg?.type === 'recall.offscreen.repoSnapshot') {
    snapshot(msg).then(sendResponse);
    return true; // async response
  } else if (msg?.type === 'recall.offscreen.cancel') {
    running.get(msg.id)?.abort();
    sendResponse({ ok: true });
  }
});
