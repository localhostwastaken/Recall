// The capture job's stored state (chrome.storage.session), shared by the service
// worker and the popup. Types and constants only, so the popup stays light.
import type { Address, Hex } from 'viem';
import type { CheckResult, EvidenceFile } from '@recall/evidence';
import type { CaptureErrorCode, CaptureStep } from './captureParts';
import type { RepoTarget } from './gitRepo';

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

/**
 * Job steps: the capture's three (the same-page check runs within step 3), then for a repository
 * (R46) 4 = downloading the code, 5 = checking it against the notarized commit.
 */
export type JobStep = CaptureStep | 4 | 5;

/** What happened to the capture after the checks (R44: nothing is uploaded here). */
export type UploadState =
  /** A new or changed page: kept in the extension; the publish tab decides how to store it. */
  | { status: 'pending'; captureId: string }
  /**
   * The newest verified capture of the page has the same bytes: a confirmation (evidence
   * inline, no Swarm upload) waits in the publish tab. `since`: that capture's signed time
   * (Unix seconds, decimal).
   */
  | { status: 'confirmation'; captureId: string; captureKey: Hex; since: string }
  /** The checks did not allow publishing. */
  | { status: 'skipped'; reason: string }
  /** The capture could not be kept for publishing. */
  | { status: 'failed'; error: string };

/**
 * `url`: the page the capture was started on (the popup matches its tab by it). On a GitHub
 * repository page (R46) `repo` is the branch and `captureUrl` the GitHub API URL actually captured.
 */
export type CaptureBase = { id: string; url: string; startedAt: number; captureUrl?: string; repo?: RepoTarget };
type Base = CaptureBase;
export type CaptureState =
  | (Base & {
      status: 'running';
      step: JobStep;
      /** When the current step began (the staleness clock); defaults to startedAt. */
      stepAt?: number;
      /** Witnesses are pinned, so the same-page check (and maybe a confirmation) comes after the checks. */
      lookupPlanned?: boolean;
      /** Step 3 only: the checks passed and the same-page check is running. */
      lookup?: boolean;
      /** Step 3 (same-page check): the checked capture. */
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
