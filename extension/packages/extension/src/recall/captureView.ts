// Popup copy for a capture (design brief section 4.1 and the A-C table in 4.5).
// Pure functions, so the wording is unit tested.
import type { CheckResult, EvidenceFile } from '@recall/evidence';
import type { Status } from './ui/StatusBadge';
import type { NoticeKind } from './ui/Notice';
import { middle } from './ui/MonoValue';
import { captureTarget, formatSize, type CaptureErrorCode } from './captureParts';
import type { CheckSummary, UploadState } from './jobState';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "4 Nov 2026, 14:02 UTC" from Unix seconds. */
export function formatUtc(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "0:12" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export const CAPTURE_STEPS = [
  'Connecting to the witness',
  'Proving the page with the witness',
  'Checking the witness signature',
] as const;

/** Step 4, shown when the pool has a batch to upload with. */
export const UPLOAD_STEP = 'Uploading evidence to Swarm';

/** The popup's footer helper while a capture can start (design brief 4.1). */
export const CAPTURE_HELPER = 'Takes about 30 s and about 80 MB of data. Pages up to 64 KB.';

/** The helper when the pool is empty: the capture still runs, but is not uploaded. */
export const CAPTURE_HELPER_NO_STORAGE =
  'No storage left: the page will be checked but not uploaded. Pages up to 64 KB.';

/** The steps a job shows: the capture's three, plus the upload when one is planned. */
export function jobSteps(uploadPlanned: boolean | undefined, step: number): string[] {
  return uploadPlanned || step > 3 ? [...CAPTURE_STEPS, UPLOAD_STEP] : [...CAPTURE_STEPS];
}

export type CheckLine = {
  letter: 'A' | 'B' | 'C';
  title: string;
  status: Status;
  result: string;
  how: string[];
};

/** The three popup check rows. Green only for a check that ran and passed. */
export function checkLines(checks: CheckSummary, evidence: EvidenceFile): CheckLine[] {
  const f = checks.facts;
  const witness = f?.witness ?? evidence.signer;
  const s = evidence.statement;

  const a: CheckLine = {
    letter: 'A',
    title: 'Bytes match the signed hashes',
    status: checks.A.status,
    result:
      checks.A.status === 'pass'
        ? 'The evidence matches the hashes the witness signed.'
        : checks.A.status === 'fail'
          ? 'The evidence was changed after signing.'
          : 'Not checked.',
    how: [checks.A.detail, `sent sha256 ${s.sentSha256}`, `received sha256 ${s.recvSha256}`],
  };

  let bStatus: Status = checks.B.status;
  let bResult = 'Not checked.';
  if (checks.B.status === 'pass' && f) {
    if (f.httpStatus === 200) {
      bResult = `GET ${f.canonicalUrl} to ${f.serverName}, no cookies sent, complete response (HTTP 200).`;
    } else {
      bStatus = 'warn';
      bResult = `The witness saw HTTP ${f.httpStatus}, not a normal page.`;
    }
  } else if (checks.B.status === 'pass') {
    bResult = 'The request and response are well-formed.';
  } else if (checks.B.status === 'fail') {
    bResult = "The request doesn't match the address claimed.";
  }
  const b: CheckLine = {
    letter: 'B',
    title: 'Request and response are well-formed',
    status: bStatus,
    result: bResult,
    how: [checks.B.detail, ...(f ? [`body sha256 ${f.bodySha256}`] : [])],
  };

  const c: CheckLine = {
    letter: 'C',
    title: 'Signed by a trusted witness',
    status: checks.C.status,
    result:
      checks.C.status === 'pass'
        ? `Signed by ${middle(witness)}, which is in your trusted list.`
        : checks.C.status === 'warn'
          ? `Signed by an unknown witness ${middle(witness)}. Trust it only if you trust its operator.`
          : checks.C.status === 'fail'
            ? 'The signature is invalid.'
            : 'Not checked.',
    how: [checks.C.detail, `witness ${witness}`],
  };
  return [a, b, c];
}

export type Verdict = { kind: NoticeKind; title: string; body?: string; witnessSettings?: boolean };

const statuses = (l: CheckLine[]) => l.map((x) => x.status);

/** Verdict from A, B, C (design brief 4.5). Never green unless all three passed. */
export function verdict(lines: CheckLine[], checks: CheckSummary): Verdict {
  const st = statuses(lines);
  if (st.includes('fail'))
    return { kind: 'error', title: "A check failed. Don't rely on this capture." };
  if (st.includes('unavailable') || st.includes('pending'))
    return { kind: 'info', title: "Couldn't fully verify." };
  const [a, b, c] = lines;
  if (b.status === 'warn') return { kind: 'warn', title: b.result.replace(/\.$/, '') + '.' };
  if (c.status === 'warn') {
    return {
      kind: 'warn',
      title: "Valid signature, but from a witness you haven't trusted.",
      witnessSettings: true,
    };
  }
  if (a.status === 'pass' && b.status === 'pass' && c.status === 'pass' && checks.facts) {
    const f = checks.facts;
    return {
      kind: 'success',
      title: 'Checks passed',
      body: `The witness saw these exact bytes from ${f.serverName} at ${formatUtc(Number(f.signedAt))}.`,
    };
  }
  return { kind: 'info', title: "Couldn't fully verify." };
}

/** Plain words for a failure reason; the witness's own message stays recognisable. */
export function plainReason(error: string): string {
  const e = error.trim().replace(/\.+$/, '');
  if (e.startsWith('recall: '))
    return `The witness refused this capture: ${e.slice('recall: '.length)}`;
  return e.charAt(0).toUpperCase() + e.slice(1);
}

export type ErrorCopy = {
  kind: NoticeKind;
  title: string;
  body?: string;
  actions: ('ok' | 'retry' | 'witnessSettings' | 'copy')[];
};

const NOTHING = 'Nothing was published.';

/** Error notices (design brief 4.1). Every error that stops a capture ends with "Nothing was published." */
export function errorCopy(
  code: CaptureErrorCode,
  error: string,
  host: string,
  size?: number,
): ErrorCopy {
  switch (code) {
    case 'too_large':
      return {
        kind: 'error',
        title: 'Page too large',
        body: `This page is ${size !== undefined ? formatSize(size) : 'over 64 KB'}. Recall can capture pages up to 64 KB for now. ${NOTHING}`,
        actions: ['ok'],
      };
    case 'tls':
      return {
        kind: 'error',
        title: "This site can't be captured",
        body: `${host} doesn't support TLS 1.2, which the witness needs. ${NOTHING}`,
        actions: ['ok'],
      };
    case 'witness_offline':
      return {
        kind: 'error',
        title: 'Witness offline',
        body: `New captures are paused until the witness is back. Existing captures can still be verified by anyone. ${NOTHING}`,
        actions: ['retry', 'witnessSettings'],
      };
    case 'busy':
      return {
        kind: 'warn',
        title: 'Witness busy',
        body: `The witness is busy. Try again in a minute. ${NOTHING}`,
        actions: ['retry'],
      };
    case 'cancelled':
      return { kind: 'info', title: `Capture cancelled. ${NOTHING}`, actions: [] };
    default:
      return {
        kind: 'error',
        title: 'Capture failed',
        body: `${plainReason(error)}. ${NOTHING}`,
        actions: ['retry', 'copy'],
      };
  }
}

export type { CheckResult };

/** "No storage left" (design brief 4.1). */
export const NO_STORAGE_TITLE = 'No storage left';
export const NO_STORAGE_BODY = 'Your prepaid storage is used up. Buy more to keep capturing.';

export type UploadCopy = {
  kind: NoticeKind;
  title: string;
  body: string;
  actions: ('buyStorage' | 'uploadNow' | 'retryUpload' | 'copy')[];
};

const sentence = (s: string) => {
  const t = s.trim().replace(/\.+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * The notice under a finished capture's checks: what happened to its evidence.
 * `hasStorage`: the pool has an unused batch now (so a no-storage capture can upload).
 */
export function uploadCopy(upload: UploadState, hasStorage: boolean): UploadCopy {
  switch (upload.status) {
    case 'uploaded':
      return {
        kind: 'success',
        title: 'Uploaded. Ready to publish',
        body: 'The evidence file is on Swarm. Publishing its record on Arkiv comes next.',
        actions: [],
      };
    case 'no_storage':
      return hasStorage
        ? {
            kind: 'info',
            title: 'Not uploaded yet',
            body: `There was no storage left when this capture finished. You can upload it now. ${NOTHING}`,
            actions: ['uploadNow'],
          }
        : {
            kind: 'error',
            title: NO_STORAGE_TITLE,
            body: `${NO_STORAGE_BODY} ${NOTHING}`,
            actions: ['buyStorage'],
          };
    case 'skipped':
      return {
        kind: 'info',
        title: 'Not uploaded',
        body: `${sentence(upload.reason)}, so the evidence was not uploaded. ${NOTHING}`,
        actions: [],
      };
    case 'failed':
      return upload.code === 'not_ready'
        ? {
            kind: 'warn',
            title: 'Storage not ready yet',
            body: `New storage takes about 1–2 minutes to become usable. Try again in a minute. ${NOTHING}`,
            actions: ['retryUpload'],
          }
        : {
            kind: 'error',
            title: 'Upload failed',
            body: `${sentence(upload.error)}. ${NOTHING}`,
            actions: ['retryUpload', 'copy'],
          };
  }
}

/**
 * Why the current page cannot be captured, as helper text ("Only https:// pages can be
 * captured."), or null when it can. Same rules as the capture itself (captureTarget).
 */
export function pageBlockedReason(url: string): string | null {
  const t = captureTarget(url);
  if (t instanceof URL) return null;
  return t.error.charAt(0).toUpperCase() + t.error.slice(1) + '.';
}
