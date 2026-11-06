import { decodeEvidence, runChecks, type CheckResult, type VerifiedFacts } from '@recall/evidence';
import type { Address, Hex } from 'viem';
import { formatUtc, safeDate } from '../format';

/**
 * What the page knows about one capture after the checks. Every field that is shown as a fact
 * about the page (URL, site, time, witness, status, type, size) comes from `facts`, which
 * `runChecks` produces only from evidence whose checks A and B passed and whose signature is
 * not invalid. Nothing here is read from an Arkiv index field.
 */
export type VerifiedReport = {
  A: CheckResult;
  B: CheckResult;
  C: CheckResult;
  /** Present only when the person gave a file to compare. */
  D?: CheckResult;
  facts?: VerifiedFacts;
  /**
   * The signer named by the evidence. Set only when check C ran to a pass or a warning, i.e.
   * when the signature really recovers to this address.
   */
  signer?: Address;
  /** Set when the evidence file itself could not be read; A then explains why. */
  malformed?: string;
  /** R13: the record fields that disagree with the evidence. Set by `crossCheck` users. */
  mismatch?: string[];
  /**
   * The file given for check D when this report was computed (undefined: none). A report only
   * speaks about D for the file it was computed for; see `verdictOf` and the check panel.
   */
  forFile?: Uint8Array;
  /** The raw cause of a failure to obtain or run something, for "Technical details" only. */
  technical?: string;
};

const unavailable = (detail: string): CheckResult => ({ status: 'unavailable', detail });

/** The report for evidence that could not be obtained: nothing was checked, nothing is green. */
export function unavailableReport(reason: string, forFile?: Uint8Array, technical?: string): VerifiedReport {
  return {
    A: unavailable(`Evidence unavailable. ${reason}`),
    B: unavailable('Not checked: the evidence is unavailable.'),
    C: unavailable('Not checked: the evidence is unavailable.'),
    forFile,
    ...(technical ? { technical } : {}),
  };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Decodes an evidence file and runs checks A to C (and D when `userFileBytes` is given), all
 * in the browser. Check B is only trusted when A passed: if the bytes are not the signed ones,
 * a clean parse of them says nothing, so B is "Not checked" instead of green. A response that
 * is not HTTP 200 turns B into a warning.
 */
export async function verifyEvidence(
  bytes: Uint8Array,
  opts: { pinnedWitnesses: readonly Address[]; userFileBytes?: Uint8Array },
): Promise<VerifiedReport> {
  let evidence;
  try {
    evidence = decodeEvidence(bytes);
  } catch (e) {
    const reason = msg(e).replace(/^invalid evidence file: /, '');
    const skipped = unavailable('Not checked: the evidence file could not be read.');
    return {
      A: { status: 'fail', detail: `The evidence file is malformed: ${reason}` },
      B: skipped,
      C: skipped,
      malformed: reason,
      forFile: opts.userFileBytes,
    };
  }
  const run = await runChecks(evidence, {
    pinnedWitnesses: opts.pinnedWitnesses,
    ...(opts.userFileBytes ? { userFileBytes: opts.userFileBytes } : {}),
  });
  const report: VerifiedReport = { A: run.A, B: run.B, C: run.C, forFile: opts.userFileBytes };
  if (run.D) report.D = run.D;
  if (run.facts) report.facts = run.facts;
  if (run.C.status === 'pass' || run.C.status === 'warn') report.signer = evidence.signer;

  // The signature code is loaded on demand. If it could not be loaded (offline before the first
  // check), say so: that is not a bad signature.
  if (run.C.status === 'fail' && /dynamically imported module|importing a module script|failed to fetch/i.test(run.C.detail)) {
    report.C = unavailable('The signature checker could not be loaded. Reload the page while online, then try again.');
    delete report.facts;
    delete report.signer;
  }
  if (run.A.status !== 'pass') {
    report.B = unavailable('Not checked: check A did not pass, so these are not the bytes the witness signed.');
  } else if (run.B.status === 'pass' && run.facts && run.facts.httpStatus !== 200) {
    report.B = { status: 'warn', detail: String(run.facts.httpStatus) };
  }
  return report;
}

/** The record fields a capture entity claims (all unverified index values). */
export type RecordClaims = { urlHash: Hex; bodySha256: Hex; witness: Address; signedAt: bigint };

/**
 * R13: the verified evidence facts must equal the Arkiv entity's indexed fields. A record that
 * points at someone else's genuine evidence, or whose fields were made up, fails here. Returns
 * the names of the fields that differ (empty means the record matches its evidence).
 */
export function crossCheck(facts: VerifiedFacts, record: RecordClaims): string[] {
  const differs: string[] = [];
  if (record.urlHash.toLowerCase() !== facts.urlHash.toLowerCase()) differs.push('page address');
  if (record.bodySha256.toLowerCase() !== facts.bodySha256.toLowerCase()) differs.push('content hash');
  if (record.witness.toLowerCase() !== facts.witness.toLowerCase()) differs.push('witness');
  if (record.signedAt !== facts.signedAt) differs.push('capture time');
  return differs;
}

export type VerdictKind = 'pending' | 'pass' | 'warn' | 'fail' | 'na';
export type Verdict = { kind: VerdictKind; text: string };

/**
 * The one-line verdict (design brief 4.5). It comes from A, B and C, plus D when a file was
 * given, plus the record cross-check. Storage (E) never counts.
 *
 * `file` is the file the person has given now (undefined: none). A report only speaks about D
 * for the file it was computed for, so when the file was given or changed since, the verdict is
 * "Checking…" until the checks have run again: a stale pass (or stale D match) is never shown.
 * "Checks passed" needs A, B and C to have passed, D too when a file is given, and facts that
 * name the host and a real time; anything missing, unknown or unreachable is
 * "Couldn't fully verify.".
 */
export function verdictOf(report: VerifiedReport | null, file?: Uint8Array): Verdict {
  const pending: Verdict = { kind: 'pending', text: 'Checking the evidence…' };
  if (!report) return pending;
  if (file !== undefined && report.forFile !== file) return pending;
  // D counts only when a file is given now. A file removed since leaves a stale D behind.
  const d: CheckResult | undefined =
    file === undefined ? undefined : (report.D ?? unavailable('No comparison was made.'));
  const results = [report.A, report.B, report.C, ...(d ? [d] : [])];
  const mismatch = (report.mismatch?.length ?? 0) > 0;
  if (mismatch || results.some((r) => r.status === 'fail')) {
    return { kind: 'fail', text: "A check failed. Don't rely on this capture." };
  }
  if (results.some((r) => r.status === 'unavailable')) return { kind: 'na', text: "Couldn't fully verify." };
  if (report.C.status === 'warn') {
    return { kind: 'warn', text: "Valid signature, but from a witness you haven't trusted." };
  }
  if (report.B.status === 'warn') {
    return {
      kind: 'warn',
      text: `The signature and bytes check out, but the witness saw HTTP ${report.B.detail}, not a normal page.`,
    };
  }
  const f = report.facts;
  const allPassed =
    report.A.status === 'pass' && report.B.status === 'pass' && report.C.status === 'pass' && (!d || d.status === 'pass');
  if (!allPassed || !f || safeDate(f.signedAt) === null) return { kind: 'na', text: "Couldn't fully verify." };
  return {
    kind: 'pass',
    text: `Checks passed. The witness saw these exact bytes from ${f.serverName} at ${formatUtc(f.signedAt)}.`,
  };
}

/**
 * True only when checks A, B and C all passed on a real, in-range capture and the record agrees
 * with its evidence: the verdict without any file ("Checks passed"). What an action that vouches
 * for a record, such as paying to keep it alive, has to require.
 */
export const isVerifiedReport = (report: VerifiedReport | null): report is VerifiedReport =>
  verdictOf(report).kind === 'pass';
