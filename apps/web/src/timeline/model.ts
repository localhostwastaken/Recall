import type { VerifiedFacts } from '@recall/evidence';
import type { Listed } from '@recall/net';
import type { Hex } from 'viem';
import { safeDate } from '../format';
import { verdictOf, type VerifiedReport } from '../verify/verify';

/**
 * One record of an address, after the browser has checked it. Only `verified` records are
 * shown as part of the timeline. Everything displayed about a verified record comes from
 * `facts` (the verified evidence); an Arkiv index field is never displayed.
 */
export type Checked =
  | { state: 'verified'; facts: VerifiedFacts }
  | { state: 'unverified'; reason: string; status: 'fail' | 'warn' | 'unavailable' };

const no = (reason: string, status: 'fail' | 'warn' | 'unavailable'): Checked => ({ state: 'unverified', reason, status });

export const COULDNT_DOWNLOAD = "Evidence couldn't be downloaded";

/**
 * A record is verified when checks A to C passed (so the signer is a pinned witness) and the
 * record agrees with its evidence (R13), and the evidence is about this address. Anything else
 * is unverified, with the first reason that applies.
 */
export function classify(report: VerifiedReport, urlHash: Hex): Checked {
  if (report.mismatch?.length) return no("Record doesn't match its evidence", 'fail');
  const verdict = verdictOf(report);
  if (verdict.kind === 'pass' && report.facts) {
    if (report.facts.urlHash.toLowerCase() !== urlHash.toLowerCase()) return no('Belongs to a different address', 'fail');
    return { state: 'verified', facts: report.facts };
  }
  const { A, B, C } = report;
  if (A.status === 'unavailable') return no(COULDNT_DOWNLOAD, 'unavailable');
  if (A.status === 'fail') return no(report.malformed ? "Evidence file can't be read" : "Bytes don't match", 'fail');
  if (C.status === 'fail') return no('Signature invalid', 'fail');
  if (B.status === 'fail') return no("Request or response isn't well-formed", 'fail');
  if (C.status === 'warn') return no('Unknown witness', 'warn');
  if (B.status === 'warn') return no(`HTTP ${B.detail}, not a normal page`, 'warn');
  if (C.status === 'unavailable' || B.status === 'unavailable') return no("Signature couldn't be checked", 'unavailable');
  // Everything passed but the time: the witness signed a moment that is not a date.
  if (report.facts && safeDate(report.facts.signedAt) === null) return no('Impossible capture time', 'fail');
  return no("Couldn't be verified", 'unavailable');
}

export type Confirmation = { entityKey: Hex; facts: VerifiedFacts };
export type Version = {
  /** 1 for the oldest verified capture. */
  n: number;
  /** The record the row links to (the first, when identical records were collapsed). */
  entityKey: Hex;
  facts: VerifiedFacts;
  confirmations: Confirmation[];
};
export type Unverified = { entityKey: Hex; kind: 'capture' | 'confirmation'; reason: string; status: 'fail' | 'warn' | 'unavailable' };
export type Pending = { entityKey: Hex; kind: 'capture' | 'confirmation' };

export type Timeline = {
  versions: Version[];
  unverified: Unverified[];
  /** Being checked right now. */
  pending: Pending[];
  /** Not checked yet (the budget of automatic checks was used up). Never shown as verified. */
  unchecked: Pending[];
};

const lower = (h: string): string => h.toLowerCase();
/** The same witness signing the same bytes at the same second is one observation, however many records point at it. */
const observation = (f: VerifiedFacts): string => `${lower(f.urlHash)}|${lower(f.witness)}|${f.signedAt}|${lower(f.bodySha256)}`;
const byTime = (a: VerifiedFacts, b: VerifiedFacts): number => (a.signedAt === b.signedAt ? 0 : a.signedAt < b.signedAt ? -1 : 1);

/**
 * Builds the timeline from the records and their check results. A record without a result is
 * either being checked (`pending`) or, when listed in `notStarted`, not checked yet
 * (`unchecked`).
 *
 * - Verified captures are ordered by their signed time (not by an index field) and numbered.
 *   Records that carry the same verified observation collapse into one, so anyone re-publishing
 *   a real capture cannot add a second version.
 * - A confirmation sits under the capture it names once its own evidence verified (A to C), it
 *   is signed after that capture and before any newer version, and its bytes are the capture's
 *   bytes.
 */
export function buildTimeline(
  rows: readonly Listed[],
  checked: ReadonlyMap<Hex, Checked>,
  notStarted: ReadonlySet<Hex> = new Set(),
): Timeline {
  // Keys in an index can be written in any case; a confirmation's `captureKey` must still find its capture.
  const results = new Map<string, Checked>();
  for (const [k, v] of checked) results.set(lower(k), v);
  const idle = new Set<string>();
  for (const k of notStarted) idle.add(lower(k));
  const get = (key: Hex) => results.get(lower(key));

  const pending: Pending[] = [];
  const unchecked: Pending[] = [];
  const unverified: Unverified[] = [];
  const wait = (r: Listed) => (idle.has(lower(r.entityKey)) ? unchecked : pending).push({ entityKey: r.entityKey, kind: r.kind });

  type VCap = { entityKey: Hex; facts: VerifiedFacts };
  const caps = new Map<string, VCap>(); // observation -> capture
  const capByKey = new Map<string, VCap>(); // any record key of a verified capture -> capture
  const capRows = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'capture') continue;
    capRows.add(lower(r.entityKey));
    const c = get(r.entityKey);
    if (!c) wait(r);
    else if (c.state === 'unverified') unverified.push({ entityKey: r.entityKey, kind: 'capture', reason: c.reason, status: c.status });
    else {
      const k = observation(c.facts);
      if (!caps.has(k)) caps.set(k, { entityKey: r.entityKey, facts: c.facts });
      capByKey.set(lower(r.entityKey), caps.get(k)!);
    }
  }

  const ordered = [...caps.values()].sort((a, b) => byTime(a.facts, b.facts) || (a.entityKey < b.entityKey ? -1 : 1));
  const versions: Version[] = ordered.map((c, i) => ({ n: i + 1, entityKey: c.entityKey, facts: c.facts, confirmations: [] }));
  const versionOf = new Map(versions.map((v, i) => [ordered[i], v] as const));

  const seenConfirmations = new Set<string>();
  const reject = (r: Listed, reason: string, status: Unverified['status']) =>
    unverified.push({ entityKey: r.entityKey, kind: 'confirmation', reason, status });
  for (const r of rows) {
    if (r.kind !== 'confirmation') continue;
    const c = get(r.entityKey);
    if (!c) {
      wait(r);
      continue;
    }
    if (c.state === 'unverified') {
      reject(r, c.reason, c.status);
      continue;
    }
    const target = capByKey.get(lower(r.captureKey));
    if (!target) {
      // Still being checked, not checked yet, or not shown at all (unverified, expired, hidden).
      const named = lower(r.captureKey);
      if (capRows.has(named) && !results.has(named)) {
        (idle.has(named) ? unchecked : pending).push({ entityKey: r.entityKey, kind: 'confirmation' });
      } else reject(r, "The capture it confirms isn't shown", 'unavailable');
      continue;
    }
    if (lower(c.facts.bodySha256) !== lower(target.facts.bodySha256)) {
      reject(r, "Doesn't match the capture it confirms", 'fail');
      continue;
    }
    if (c.facts.signedAt <= target.facts.signedAt) {
      reject(r, 'Dated before the capture it confirms', 'fail');
      continue;
    }
    const version = versionOf.get(target)!;
    const newer = versions[version.n]; // the next version, if there is one
    if (newer && c.facts.signedAt > newer.facts.signedAt) {
      // "Unchanged" cannot hold across a newer version, even if the page later went back.
      reject(r, 'Dated after a newer version', 'fail');
      continue;
    }
    const k = observation(c.facts);
    if (seenConfirmations.has(k)) continue; // the same confirmation published twice
    seenConfirmations.add(k);
    version.confirmations.push({ entityKey: r.entityKey, facts: c.facts });
  }
  for (const v of versions) v.confirmations.sort((a, b) => byTime(a.facts, b.facts));
  return { versions, unverified, pending, unchecked };
}
