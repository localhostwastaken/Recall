// Popup copy for a capture (design brief section 4.1 and the A-C table in 4.5).
// Pure functions, so the wording is unit tested.
import type { CheckResult, EvidenceFile } from '@recall/evidence';
import type { Status } from './ui/StatusBadge';
import type { NoticeKind } from './ui/Notice';
import { middle } from './ui/MonoValue';
import { formatSize, type CaptureErrorCode } from './captureParts';
import type { CheckSummary } from './jobState';

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
