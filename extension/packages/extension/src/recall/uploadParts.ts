// Pure parts of the upload that follows a capture (no chrome APIs), so they are unit tested.
import type { Hex } from 'viem';
import { canonicalUrl, decodeEvidence, encodeEvidence, type EvidenceFile } from '@recall/evidence';
import { captureTarget } from './captureParts';
import type { CheckSummary } from './jobState';
import type { BatchUpdate, StamperState } from './poolState';

/** How long an upload waits for a fresh batch to become usable (bought ~1-2 min ago). */
export const USABLE_WAIT_MS = 120_000;
/** How long the stamped upload itself may take. */
export const UPLOAD_TIMEOUT_MS = 60_000;
/** How long the upload of a repository snapshot (up to 25 MB) may take. */
export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 10 * 60_000;

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
 * order, lower-case signature, checksummed signer). encodeEvidence itself now writes one
 * fixed key order whatever the input's (chrome.storage hands objects back with sorted keys);
 * this also normalises the values, so encodeEvidence of a pending record's evidence, or of
 * the downloaded file decoded again, gives exactly the uploaded bytes.
 */
export function canonicalEvidence(e: EvidenceFile): EvidenceFile {
  return decodeEvidence(encodeEvidence(e));
}

/**
 * The batch id a capture records when its evidence went to a gateway's free storage (free upload
 * mode): no batch was used, so there is none to extend. The web app treats exactly this value as
 * "free mode" (no Swarm root check, no keep-alive for Swarm). One definition, shared with the app.
 */
export { FREE_BATCH_ID } from '@recall/net/postage';

/** Whether a capture is uploaded after its checks: free mode needs no batch, stamped needs one in the pool. */
export function uploadIsPlanned(mode: 'stamped' | 'free', unusedBatches: number): boolean {
  return mode === 'free' || unusedBatches > 0;
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
  /** `free`: POST /bytes to the gateway (no stamp key, no batch). Default `stamped`. */
  mode?: 'stamped' | 'free';
  evidence: EvidenceFile;
  /** The stamp key (stamped mode only). Extension-internal only; never logged, never sent to a page. */
  stampKey?: Hex;
  candidates: UploadCandidate[];
  uploadUrl: string;
  gnosisRpcUrl: string;
  waitMs: number;
  /**
   * A repository snapshot (R46) to upload after the evidence, with the same batch (stamped) or
   * the gateway (free). The offscreen document reads its bytes from IndexedDB by captureId and
   * uploads them only if they still hash to `sha256` and have `size` bytes.
   */
  attachment?: { captureId: string; sha256: string; size: number };
};

/**
 * One upload attempt's result. `updates` says what the attempt learned about each batch
 * it touched (bucket heights, used, dead, demoted); the service worker stores them
 * whatever became of the job.
 */
export type UploadOutcome =
  | { ok: true; batchId: Hex; evidenceRef: Hex; attachmentRef?: Hex; updates: BatchUpdate[] }
  | {
      ok: false;
      /** not_ready: no live batch became usable in time; no_storage: every batch is dead. */
      code: 'not_ready' | 'no_storage' | 'failed';
      error: string;
      updates: BatchUpdate[];
    };

/** Offscreen -> service worker: the upload finished. */
export type UploadResultMessage = {
  type: 'recall.upload.result';
  id: string;
  outcome: UploadOutcome;
};
