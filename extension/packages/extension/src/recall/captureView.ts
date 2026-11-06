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
  'Recording the page (~30 s)',
  'Checking the witness signature',
] as const;

/** Shown when witnesses are pinned: the same-page check after the signature check. */
export const LOOKUP_STEP = 'Looking for earlier captures';

/** A GitHub repository (R46): after the checks, the code of the notarized commit. */
export const DOWNLOAD_STEP = 'Downloading the code';
export const CODE_CHECK_STEP = 'Checking the code against the commit';

/** The primary button on a GitHub repository page, and its sub-line. */
export const REPO_BUTTON = 'Capture this repository';
export const PAGE_BUTTON = 'Capture this page';
/** "Uploading the code… 1,234 / 3,800" (the repository snapshot's chunks accepted so far). */
export function uploadProgressText(p: { done: number; total: number }): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return `Uploading the code… ${n(p.done)} / ${n(p.total)}`;
}

export function repoSubline(branch: string): string {
  return `branch ${branch} · notarizes GitHub's commit, then checks the code`;
}

/** The popup's footer helper while a capture can start (design brief 4.1). */
export const CAPTURE_HELPER = 'Takes about 30 s and about 80 MB of data. Pages up to 64 KB.';

export type StepPlan = {
  step: number;
  lookupPlanned?: boolean;
  /** Step 3 with the checks done: the same-page check is running. */
  lookup?: boolean;
  /** A GitHub repository capture: steps 4 and 5 download and check the code. */
  repo?: unknown;
};

/**
 * The steps a job shows (R44) and which one is current: the capture's three, then the
 * same-page check when witnesses are pinned. Storage is chosen afterwards, in the Recall tab,
 * so there is no upload step here.
 */
export function jobSteps(p: StepPlan): { labels: string[]; current: number } {
  const labels: string[] = [...CAPTURE_STEPS];
  if (p.lookupPlanned || p.lookup) labels.push(LOOKUP_STEP);
  if (p.repo) labels.push(DOWNLOAD_STEP, CODE_CHECK_STEP);
  const label =
    p.repo && p.step === 4
      ? DOWNLOAD_STEP
      : p.repo && p.step === 5
        ? CODE_CHECK_STEP
        : p.step === 3 && p.lookup
          ? LOOKUP_STEP
          : CAPTURE_STEPS[Math.max(0, Math.min(2, p.step - 1))];
  return { labels, current: Math.max(0, labels.indexOf(label)) };
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

export type UploadCopy = {
  kind: NoticeKind;
  title: string;
  body: string;
  actions: ('openApprove' | 'copy')[];
};

const sentence = (s: string) => {
  const t = s.trim().replace(/\.+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** "Continue in the Recall tab" (R44): the person chooses there how to save the capture. */
export const CONTINUE_TITLE = 'Continue in the Recall tab';

/**
 * The notice under a finished capture's checks: what happens next. `verified`: all three checks
 * passed with a pinned witness; only then is a kept capture shown in green.
 */
export function uploadCopy(upload: UploadState, verified = false): UploadCopy {
  switch (upload.status) {
    case 'pending':
      // The Recall tab opens by itself; the button is the fallback.
      return {
        kind: verified ? 'success' : 'info',
        title: CONTINUE_TITLE,
        body: 'Choose how to save and publish this capture there. Nothing is uploaded until you do.',
        actions: ['openApprove'],
      };
    case 'confirmation':
      // "the capture", not "your capture": the earlier one may be anyone's.
      return {
        kind: 'info',
        title: CONTINUE_TITLE,
        body: `Unchanged since ${formatUtc(Number(upload.since))}. Confirm it there; no upload is needed.`,
        actions: ['openApprove'],
      };
    case 'skipped':
      return {
        kind: 'info',
        title: 'Not uploaded',
        body: `${sentence(upload.reason)}, so the evidence was not uploaded. ${NOTHING}`,
        actions: [],
      };
    case 'failed':
      return {
        kind: 'error',
        title: 'Capture not kept',
        body: `${sentence(upload.error)}. ${NOTHING}`,
        actions: ['copy'],
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

/** The web app's publish tab for a pending capture; `ext` tells the page which extension to ask. */
export function approveUrl(appUrl: string, captureId: string, extensionId: string): string {
  return new URL(`#/approve/${captureId}?ext=${extensionId}`, appUrl).href;
}

/** The web app's Buy storage page; `ext` tells the page which extension owns the batches. */
export function storageUrl(appUrl: string, extensionId: string): string {
  return new URL(`#/storage?ext=${extensionId}`, appUrl).href;
}

/** The web app's timeline of a page. */
export function timelineUrl(appUrl: string, urlHash: string): string {
  return new URL(`#/u/${urlHash}`, appUrl).href;
}

/** A capture record's page in the web app (where it can be kept alive). */
export function captureUrl(appUrl: string, entityKey: string): string {
  return new URL(`#/c/${entityKey}`, appUrl).href;
}

/**
 * The checked history of a page for the popup (service worker answer). Counts are of
 * verified records only; `trusted: false` means no witness is pinned, so none can verify.
 */
export type EarlierCaptures =
  | {
      urlHash: string;
      timelineUrl: string;
      trusted: boolean;
      versions: number;
      confirmations: number;
      /** Unix seconds (decimal) of the newest verified record. */
      latest?: string;
      /** Records listed for the page, verified or not. */
      records: number;
      /** Capture records whose evidence could not be downloaded (unknown, not failed). */
      unavailable: number;
      incomplete: boolean;
    }
  | { error: string };

export type EarlierView =
  | { kind: 'loading'; text: string }
  | { kind: 'error' | 'none'; text: string }
  | { kind: 'unchecked' | 'unavailable'; text: string; timelineUrl: string }
  | { kind: 'some'; counts: string; latest: string; note?: string; timelineUrl: string };

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Earlier captures" (design brief 4.1). Unverified records are never counted. */
export function earlierCopy(r: EarlierCaptures | undefined): EarlierView {
  if (!r) return { kind: 'loading', text: 'Checking earlier captures…' };
  if ('error' in r) {
    return { kind: 'error', text: "Couldn't load earlier captures. You can still capture this page." };
  }
  if (!r.trusted) {
    return {
      kind: 'unchecked',
      text: "No trusted witness is set, so earlier captures can't be checked here.",
      timelineUrl: r.timelineUrl,
    };
  }
  if (r.versions === 0) {
    // "None" only for an empty, complete listing. Unreachable evidence is "Not checked"
    // (design brief 5), and records that did not verify are not "no captures".
    if (r.records === 0 && !r.incomplete) return { kind: 'none', text: 'No captures of this page yet.' };
    if (r.unavailable > 0) {
      return {
        kind: 'unavailable',
        text: "Earlier captures couldn't be checked right now (their evidence couldn't be downloaded). You can still capture this page.",
        timelineUrl: r.timelineUrl,
      };
    }
    return {
      kind: 'unchecked',
      text: 'No verified captures among the records checked here. The timeline checks them all.',
      timelineUrl: r.timelineUrl,
    };
  }
  const note =
    r.unavailable > 0
      ? `${count(r.unavailable, 'record')} couldn't be checked right now. The timeline checks them all.`
      : r.incomplete
        ? 'Some records were not checked here. The timeline checks them all.'
        : undefined;
  return {
    kind: 'some',
    counts: `${count(r.versions, 'version')} · ${count(r.confirmations, 'confirmation')}`,
    latest: `Latest: ${r.latest ? formatUtc(Number(r.latest)) : 'unknown'}`,
    ...(note ? { note } : {}),
    timelineUrl: r.timelineUrl,
  };
}
