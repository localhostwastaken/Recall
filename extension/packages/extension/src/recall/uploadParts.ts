// Pure parts of the upload that follows a capture (no chrome APIs), so they are unit tested.
import type { Hex } from 'viem';
import { canonicalUrl, decodeEvidence, encodeEvidence, type EvidenceFile } from '@recall/evidence';
import { captureTarget } from './captureParts';
import type { CheckSummary } from './jobState';
import type { StamperState } from './poolState';

/** How long an upload waits for a fresh batch to become usable (bought ~1-2 min ago). */
export const USABLE_WAIT_MS = 120_000;
/** How long the stamped upload itself may take. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Evidence is uploaded only when checks A and B passed and C did not fail (an unknown
 * witness is a warning and still uploads), and when the witness saw the page that was
 * asked for.
 */
export function uploadGate(
  checks: CheckSummary,
  jobUrl: string,
): { ok: true } | { ok: false; reason: string } {
  if (checks.A.status !== 'pass') return { ok: false, reason: 'check A did not pass' };
  if (checks.B.status !== 'pass') return { ok: false, reason: 'check B did not pass' };
  if (checks.C.status === 'fail') return { ok: false, reason: 'the witness signature is invalid' };
  const seen = checks.facts?.canonicalUrl;
  if (!seen) return { ok: false, reason: 'the checks gave no verified address' };
  let asked = '';
  try {
    const target = captureTarget(jobUrl);
    if (target instanceof URL) asked = canonicalUrl(target.href);
  } catch {
    /* an address canonicalUrl refuses cannot match */
  }
  if (asked !== seen) return { ok: false, reason: `the witness saw ${seen}, not ${jobUrl}` };
  return { ok: true };
}

/**
 * The evidence file in its canonical form (the shape decodeEvidence returns: fixed key
 * order, lower-case signature). encodeEvidence keeps the statement's key order, and
 * chrome.storage hands objects back with sorted keys. So the extension uploads and keeps
 * (as JSON text) only this form, and encodeEvidence of a pending record's evidence, or of
 * the downloaded file decoded again, gives exactly the uploaded bytes.
 */
export function canonicalEvidence(e: EvidenceFile): EvidenceFile {
  return decodeEvidence(encodeEvidence(e));
}

/** A batch the offscreen document may upload with. */
export type UploadCandidate = {
  batchId: Hex;
  depth: number;
  startBlock: string;
  stamper?: StamperState;
};

/** Service worker -> offscreen: stamp and upload one evidence file. Answered with `{accepted:true}`. */
export type OffscreenUpload = {
  type: 'recall.offscreen.upload';
  id: string;
  evidence: EvidenceFile;
  /** The stamp key. Extension-internal only; never logged, never sent to a page. */
  stampKey: Hex;
  candidates: UploadCandidate[];
  uploadUrl: string;
  gnosisRpcUrl: string;
  waitMs: number;
};

export type UploadOutcome =
  | { ok: true; batchId: Hex; evidenceRef: Hex; stamper: StamperState }
  | {
      ok: false;
      code: 'not_ready' | 'failed';
      error: string;
      /** The batch that was tried, with its bucket heights (slots stamped stay used). */
      batchId?: Hex;
      stamper?: StamperState;
    };

/** Offscreen -> service worker: the upload finished. */
export type UploadResultMessage = {
  type: 'recall.upload.result';
  id: string;
  outcome: UploadOutcome;
};
