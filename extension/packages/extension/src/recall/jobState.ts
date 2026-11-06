// The capture job's stored state (chrome.storage.session), shared by the service
// worker and the popup. Types and constants only, so the popup stays light.
import type { Address, Hex } from 'viem';
import type { CheckResult, EvidenceFile } from '@recall/evidence';
import type { CaptureErrorCode, CaptureStep } from './captureParts';

export const CAPTURE_STATE_KEY = 'recall.capture';

/** A running step that has not moved for this long is treated as lost (offscreen crashed, browser slept). */
export const STALE_AFTER_MS = 4 * 60_000;

/** JSON-safe checks A-C of a fresh capture (chrome.storage cannot hold bigint or bytes). */
export type CheckSummary = {
  A: CheckResult;
  B: CheckResult;
  C: CheckResult;
  facts?: {
    canonicalUrl: string;
    serverName: string;
    httpStatus: number;
    contentType?: string;
    /** Unix seconds, as a decimal string. */
    signedAt: string;
    witness: Address;
    bodySha256: Hex;
    bodySize: number;
  };
};

/** Job steps: the capture's three, then 4 = uploading the evidence to Swarm. */
export type JobStep = CaptureStep | 4;

/** What happened to the evidence after the checks. */
export type UploadState =
  | { status: 'uploaded'; captureId: string; evidenceRef: Hex; batchId: Hex }
  /**
   * The newest verified capture of the page has the same bytes: a confirmation (evidence
   * inline, no Swarm upload) waits in the approval tab. `since`: that capture's signed time
   * (Unix seconds, decimal).
   */
  | { status: 'confirmation'; captureId: string; captureKey: Hex; since: string }
  /** The pool had no unused batch. */
  | { status: 'no_storage' }
  /** The checks did not allow an upload. */
  | { status: 'skipped'; reason: string }
  /** `not_ready`: no batch became usable in time (fresh storage takes 1-2 minutes). */
  | { status: 'failed'; error: string; code?: 'not_ready' };

export type CaptureBase = { id: string; url: string; startedAt: number };
type Base = CaptureBase;
export type CaptureState =
  | (Base & {
      status: 'running';
      step: JobStep;
      /** When the current step began (the staleness clock); defaults to startedAt. */
      stepAt?: number;
      /** The pool had a batch at the start, so the steps include the upload. */
      uploadPlanned?: boolean;
      /** Step 3 (same-page check) and step 4 (upload): the checked capture. */
      evidence?: EvidenceFile;
      checks?: CheckSummary;
    })
  | (Base & {
      status: 'done';
      finishedAt: number;
      evidence: EvidenceFile;
      checks: CheckSummary;
      upload?: UploadState;
    })
  | (Base & {
      status: 'error';
      finishedAt: number;
      error: string;
      code: CaptureErrorCode;
      size?: number;
    })
  | (Base & { status: 'cancelled'; finishedAt: number });

export type FinalState = Exclude<CaptureState, { status: 'running' }>;
export type RunningState = Extract<CaptureState, { status: 'running' }>;

/** A running job that is still alive (its current step began less than STALE_AFTER_MS ago). */
export function isLiveRunning(s: CaptureState | undefined, now: number): s is RunningState {
  return s?.status === 'running' && now - (s.stepAt ?? s.startedAt) < STALE_AFTER_MS;
}
