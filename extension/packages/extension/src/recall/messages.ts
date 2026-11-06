// Messages between the popup, the service worker and the offscreen document.
// All of them stay inside the extension (it has no content scripts).
import type { CaptureOutcome, CaptureOverrides, CaptureStep } from './captureParts';

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

/** Popup -> service worker. */
export type PopupRequest =
  | { type: 'recall.startCapture'; url: string }
  | { type: 'recall.cancelCapture' }
  | { type: 'recall.dismissCapture' };

export type RecallMessage =
  | OffscreenCapture
  | OffscreenCancel
  | CaptureStepMessage
  | CaptureResultMessage
  | PopupRequest;
