// The capture job's stored state (chrome.storage.session), shared by the service
// worker and the popup. Types and constants only, so the popup stays light.
import type { Address, Hex } from 'viem';
import type { CheckResult, EvidenceFile } from '@recall/evidence';
import type { CaptureErrorCode, CaptureStep } from './captureParts';

export const CAPTURE_STATE_KEY = 'recall.capture';

/** A running capture older than this is treated as lost (offscreen crashed, browser slept). */
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

export type CaptureBase = { id: string; url: string; startedAt: number };
type Base = CaptureBase;
export type CaptureState =
  | (Base & { status: 'running'; step: CaptureStep })
  | (Base & { status: 'done'; finishedAt: number; evidence: EvidenceFile; checks: CheckSummary })
  | (Base & {
      status: 'error';
      finishedAt: number;
      error: string;
      code: CaptureErrorCode;
      size?: number;
    })
  | (Base & { status: 'cancelled'; finishedAt: number });

export type FinalState = Exclude<CaptureState, { status: 'running' }>;
