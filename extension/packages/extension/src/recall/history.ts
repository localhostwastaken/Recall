// Earlier records of one address, checked before they count for anything. Anyone can
// write Arkiv records with our schema tags, so a record is only "verified" when its
// evidence passes checks A-C with a pinned witness, the response was HTTP 200, and the
// record's indexed fields equal what the evidence says (R13). Used by the popup's
// "Earlier captures" and by the same-page check (an identical, verified latest capture
// lets a capture be published as a confirmation instead of a new upload).
// Pure apart from the injected download, so it is unit tested.
import { decodeEvidence, runChecks, type VerifiedFacts } from '@recall/evidence';
import type { Listed } from '@recall/net/arkiv';
import type { Address, Hex } from 'viem';

/** Captures the same-page check tries (newest claimed first) before giving up and uploading. */
export const LATEST_MAX_TRIES = 10;
/** Captures and confirmations the popup's summary checks; more makes it "incomplete". */
export const SUMMARY_MAX_CAPTURES = 20;
export const SUMMARY_MAX_CONFIRMATIONS = 50;
/** Downloads run this many at a time for the summary. */
const CONCURRENCY = 4;
/** 31 Dec 9999: later (or zero) signed times are impossible and never verified. */
const MAX_SIGNED_AT = 253_402_300_799n;

/** What a record says about its evidence; claims until the evidence confirms them. */
export type Claims = { urlHash: Hex; bodySha256: Hex; witness: Address; signedAt: bigint };

export type HistoryDeps = {
  /** The address being looked at. */
  urlHash: Hex;
  pinned: readonly Address[];
  /** The evidence file a capture record points to (root-checked); throws when unavailable. */
  download(ref: Hex): Promise<Uint8Array>;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The verified facts of an evidence file for a record, or null. Needs checks A, B and C to
 * pass (so the signer is pinned), HTTP 200, a possible signed time, the evidence to be about
 * `urlHash`, and the record's claims to equal the evidence (R13).
 */
export async function verifiedFacts(
  bytes: Uint8Array,
  claims: Claims,
  deps: Pick<HistoryDeps, 'urlHash' | 'pinned'>,
): Promise<VerifiedFacts | null> {
  if (deps.pinned.length === 0) return null;
  try {
    const r = await runChecks(decodeEvidence(bytes), { pinnedWitnesses: deps.pinned });
    const f = r.facts;
    if (r.A.status !== 'pass' || r.B.status !== 'pass' || r.C.status !== 'pass' || !f) return null;
    if (f.httpStatus !== 200 || f.signedAt <= 0n || f.signedAt > MAX_SIGNED_AT) return null;
    if (!same(f.urlHash, deps.urlHash)) return null;
    const matches =
      same(claims.urlHash, f.urlHash) &&
      same(claims.bodySha256, f.bodySha256) &&
      same(claims.witness, f.witness) &&
      claims.signedAt === f.signedAt;
    return matches ? f : null;
  } catch {
    return null;
  }
}

type CaptureRow = Extract<Listed, { kind: 'capture' }>;
type ConfirmationRow = Extract<Listed, { kind: 'confirmation' }>;

const newestFirst = <T extends { signedAt: bigint }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.signedAt === b.signedAt ? 0 : a.signedAt > b.signedAt ? -1 : 1));

async function verifyCapture(row: CaptureRow, deps: HistoryDeps): Promise<VerifiedFacts | null> {
  let bytes: Uint8Array;
  try {
    bytes = await deps.download(row.evidenceRef);
  } catch {
    return null;
  }
  return verifiedFacts(bytes, row, deps);
}

export type LatestCapture = { entityKey: Hex; bodySha256: Hex; signedAt: bigint };

/**
 * The newest verified capture of the address, or null when there is none or it cannot be
 * found within `maxTries` downloads. Candidates are tried newest claimed time first: a
 * verified record's claimed time is its real signed time (R13), so the first one that
 * verifies is the newest verified capture; junk that claims a later time only costs a try.
 */
export async function latestVerifiedCapture(
  rows: readonly Listed[],
  deps: HistoryDeps,
  maxTries = LATEST_MAX_TRIES,
): Promise<LatestCapture | null> {
  if (deps.pinned.length === 0) return null;
  const captures = newestFirst(rows.filter((r): r is CaptureRow => r.kind === 'capture'));
  for (const row of captures.slice(0, maxTries)) {
    const f = await verifyCapture(row, deps);
    if (f) return { entityKey: row.entityKey, bodySha256: f.bodySha256, signedAt: f.signedAt };
  }
  return null;
}

export type HistorySummary = {
  /** Verified captures; the same observation published twice counts once. */
  versions: number;
  /** Verified confirmations of a version, dated before any newer version. */
  confirmations: number;
  /** The newest signed time among them (Unix seconds). */
  latest?: bigint;
  /** The listing was cut short, or there were more records than were checked. */
  incomplete: boolean;
};

async function mapLimited<T, R>(items: readonly T[], fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

const observation = (f: VerifiedFacts) =>
  `${f.urlHash.toLowerCase()}|${f.witness.toLowerCase()}|${f.signedAt}|${f.bodySha256.toLowerCase()}`;

/**
 * Counts the verified versions and confirmations of an address (the same rules as the web
 * app's timeline). Nothing unverified is counted.
 */
export async function summarizeHistory(
  rows: readonly Listed[],
  truncated: boolean,
  deps: HistoryDeps,
): Promise<HistorySummary> {
  const allCaptures = newestFirst(rows.filter((r): r is CaptureRow => r.kind === 'capture'));
  const allConfirmations = newestFirst(rows.filter((r): r is ConfirmationRow => r.kind === 'confirmation'));
  const captures = allCaptures.slice(0, SUMMARY_MAX_CAPTURES);
  const confirmations = allConfirmations.slice(0, SUMMARY_MAX_CONFIRMATIONS);
  const incomplete =
    truncated || allCaptures.length > captures.length || allConfirmations.length > confirmations.length;

  // Versions: verified captures, one per observation, oldest first.
  const checked = await mapLimited(captures, (r) => verifyCapture(r, deps));
  const versions = new Map<string, VerifiedFacts>();
  const versionOfKey = new Map<string, VerifiedFacts>();
  captures.forEach((row, i) => {
    const f = checked[i];
    if (!f) return;
    const k = observation(f);
    if (!versions.has(k)) versions.set(k, f);
    versionOfKey.set(row.entityKey.toLowerCase(), versions.get(k)!);
  });
  const ordered = [...versions.values()].sort((a, b) => (a.signedAt < b.signedAt ? -1 : a.signedAt > b.signedAt ? 1 : 0));

  // Confirmations: verified inline evidence, the same bytes as the version it names, signed
  // after it and not after the next version.
  const seen = new Set<string>();
  let confirmed = 0;
  let latest = ordered.length ? ordered[ordered.length - 1].signedAt : undefined;
  for (const row of confirmations) {
    const target = versionOfKey.get(row.captureKey.toLowerCase());
    if (!target) continue;
    const f = await verifiedFacts(row.evidence, row, deps);
    if (!f || !same(f.bodySha256, target.bodySha256) || f.signedAt <= target.signedAt) continue;
    const newer = ordered[ordered.indexOf(target) + 1];
    if (newer && f.signedAt > newer.signedAt) continue;
    const k = observation(f);
    if (seen.has(k)) continue;
    seen.add(k);
    confirmed++;
    if (latest === undefined || f.signedAt > latest) latest = f.signedAt;
  }
  return {
    versions: ordered.length,
    confirmations: confirmed,
    ...(latest !== undefined ? { latest } : {}),
    incomplete,
  };
}
