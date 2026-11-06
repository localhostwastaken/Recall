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
  pending: Pending[];
};

const lower = (h: string): string => h.toLowerCase();
/** The same witness signing the same bytes at the same second is one observation, however many records point at it. */
const observation = (f: VerifiedFacts): string => `${lower(f.urlHash)}|${lower(f.witness)}|${f.signedAt}|${lower(f.bodySha256)}`;
const byTime = (a: VerifiedFacts, b: VerifiedFacts): number => (a.signedAt === b.signedAt ? 0 : a.signedAt < b.signedAt ? -1 : 1);

/**
 * Builds the timeline from the records and their check results (a record without a result is
 * still being checked).
 *
 * - Verified captures are ordered by their signed time (not by an index field) and numbered.
 *   Records that carry the same verified observation collapse into one, so anyone re-publishing
 *   a real capture cannot add a second version.
 * - A confirmation sits under the capture it names once its own evidence verified (A to C), it
 *   is signed after that capture, and its bytes are the capture's bytes.
 */
export function buildTimeline(rows: readonly Listed[], checked: ReadonlyMap<Hex, Checked>): Timeline {
  const get = (key: Hex) => checked.get(key);
  const pending: Pending[] = [];
  const unverified: Unverified[] = [];

  type VCap = { entityKey: Hex; facts: VerifiedFacts; alias: Hex[] };
  const caps = new Map<string, VCap>(); // observation -> capture
  const capByKey = new Map<string, VCap>(); // any record key of a verified capture -> capture
  const capRowKeys = new Set<string>();
  const capRows = rows.filter((r) => r.kind === 'capture');
  for (const r of capRows) {
    capRowKeys.add(lower(r.entityKey));
    const c = get(r.entityKey);
    if (!c) pending.push({ entityKey: r.entityKey, kind: 'capture' });
    else if (c.state === 'unverified') unverified.push({ entityKey: r.entityKey, kind: 'capture', reason: c.reason, status: c.status });
    else {
      const k = observation(c.facts);
      const known = caps.get(k);
      if (known) known.alias.push(r.entityKey);
      else caps.set(k, { entityKey: r.entityKey, facts: c.facts, alias: [r.entityKey] });
      capByKey.set(lower(r.entityKey), caps.get(k)!);
    }
  }

  const ordered = [...caps.values()].sort((a, b) => byTime(a.facts, b.facts) || (a.entityKey < b.entityKey ? -1 : 1));
  const versions: Version[] = ordered.map((c, i) => ({ n: i + 1, entityKey: c.entityKey, facts: c.facts, confirmations: [] }));
  const versionOf = new Map(versions.map((v, i) => [ordered[i], v] as const));

  const seenConfirmations = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'confirmation') continue;
    const c = get(r.entityKey);
    if (!c) {
      pending.push({ entityKey: r.entityKey, kind: 'confirmation' });
      continue;
    }
    if (c.state === 'unverified') {
      unverified.push({ entityKey: r.entityKey, kind: 'confirmation', reason: c.reason, status: c.status });
      continue;
    }
    const target = capByKey.get(lower(r.captureKey));
    if (!target) {
      // The capture it names is still being checked, or is not shown (unverified, expired, hidden).
      if (capRowKeys.has(lower(r.captureKey)) && !get(r.captureKey)) pending.push({ entityKey: r.entityKey, kind: 'confirmation' });
      else unverified.push({ entityKey: r.entityKey, kind: 'confirmation', reason: "The capture it confirms isn't shown", status: 'unavailable' });
      continue;
    }
    if (lower(c.facts.bodySha256) !== lower(target.facts.bodySha256)) {
      unverified.push({ entityKey: r.entityKey, kind: 'confirmation', reason: "Doesn't match the capture it confirms", status: 'fail' });
      continue;
    }
    if (c.facts.signedAt <= target.facts.signedAt) {
      unverified.push({ entityKey: r.entityKey, kind: 'confirmation', reason: 'Dated before the capture it confirms', status: 'fail' });
      continue;
    }
    const version = versionOf.get(target)!;
    const newer = versions[version.n]; // the next version, if there is one
    if (newer && c.facts.signedAt > newer.facts.signedAt) {
      // "Unchanged" cannot hold across a newer version, even if the page later went back.
      unverified.push({ entityKey: r.entityKey, kind: 'confirmation', reason: 'Dated after a newer version', status: 'fail' });
      continue;
    }
    const k = observation(c.facts);
    if (seenConfirmations.has(k)) continue; // the same confirmation published twice
    seenConfirmations.add(k);
    version.confirmations.push({ entityKey: r.entityKey, facts: c.facts });
  }
  for (const v of versions) v.confirmations.sort((a, b) => byTime(a.facts, b.facts));
  return { versions, unverified, pending };
}
