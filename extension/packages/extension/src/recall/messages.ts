// Messages between the popup, the service worker and the offscreen document.
// All of them stay inside the extension (it has no content scripts). The web app's
// messages (chrome.runtime.onMessageExternal) are in external.ts.
import type { CaptureOutcome, CaptureOverrides, CaptureStep } from './captureParts';
import type { OffscreenUpload, UploadResultMessage } from './uploadParts';
import type { OffscreenReadEntity } from './arkivRead';
import type { OffscreenHistory, OffscreenWitnessUrl } from './historyRead';

export type { OffscreenUpload, UploadResultMessage } from './uploadParts';
export type { OffscreenReadEntity } from './arkivRead';
export type { OffscreenHistory, OffscreenWitnessUrl } from './historyRead';
export type { ExternalRequest } from './external';

/** Service worker -> offscreen: run one capture. Answered at once with `{accepted:true}`. */
export type OffscreenCapture = {
  type: 'recall.offscreen.capture';
  id: string;
  url: string;
  witnessUrl: string;
  maxRecvData: number;
  overrides?: CaptureOverrides;
};

/** Service worker -> offscreen: cancel the capture with this id. */
export type OffscreenCancel = { type: 'recall.offscreen.cancel'; id: string };

/** Offscreen -> service worker: the capture reached a step. */
export type CaptureStepMessage = { type: 'recall.capture.step'; id: string; step: CaptureStep };

/** Offscreen -> service worker: the capture finished. */
export type CaptureResultMessage = {
  type: 'recall.capture.result';
  id: string;
  outcome: CaptureOutcome;
};

/**
 * Popup -> service worker.
 * - witnessStatus: is a witness reachable (its announced URL first, then the settings URL)?
 * - earlierCaptures: the verified history of a page, for "Earlier captures".
 */
export type PopupRequest =
  | { type: 'recall.startCapture'; url: string }
  | { type: 'recall.cancelCapture' }
  | { type: 'recall.dismissCapture' }
  | { type: 'recall.retryUpload' }
  | { type: 'recall.witnessStatus' }
  | { type: 'recall.earlierCaptures'; url: string };

export type RecallMessage =
  | OffscreenCapture
  | OffscreenCancel
  | OffscreenUpload
  | OffscreenReadEntity
  | OffscreenHistory
  | OffscreenWitnessUrl
  | CaptureStepMessage
  | CaptureResultMessage
  | UploadResultMessage
  | PopupRequest;
