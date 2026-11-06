import type { CheckResult, VerifiedFacts } from '@recall/evidence';
import { CaptureSchema, arkivPublic, batchTtlSeconds, isFreeBatch, type NetConfig } from '@recall/net';
import { useCallback, useEffect, useState } from 'react';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { gnosis } from 'viem/chains';
import { downloadEvidence } from '../download';
import { formatDay } from '../format';
import { getNetConfig } from '../net';
import { trustedWitnesses } from '../witness';
import { crossCheck, unavailableReport, verifyEvidence, type RecordClaims, type VerifiedReport } from './verify';

/** What the Arkiv entity says about itself. These fields are claims until the evidence confirms them. */
export type CaptureRecord = {
  entityKey: Hex;
  urlHash: Hex;
  bodySha256: Hex;
  witness: Address;
  signedAt: bigint;
  batchId: Hex;
  evidenceRef: Hex;
  /** Arkiv block at which the entity expires. */
  expiresAtBlock: bigint;
};

/** Live storage figures behind check E. `ttlSeconds` is null when the batch is expired or unknown. */
export type StorageInfo = {
  ttlSeconds: bigint | null;
  arkivExpiresAtBlock: bigint;
  /** Seconds until the Arkiv record expires, from the chain's block timing (null if unreadable). */
  arkivSecondsLeft: number | null;
  swarmExpiresAt: Date | null;
  arkivExpiresAt: Date | null;
};

export type StorageState =
  | { phase: 'pending' }
  | { phase: 'done'; check: CheckResult; info: StorageInfo | null };

export type CapturePhase = 'loading' | 'ready' | 'missing' | 'not-capture' | 'error';

export type VerifiedCapture = {
  phase: CapturePhase;
  /** Why the record could not be read (phase 'error'). */
  error?: string;
  record: CaptureRecord | null;
  /** null until the evidence has been downloaded and checked (or found unavailable). */
  report: VerifiedReport | null;
  /** The verified facts, or null. Everything displayed about the page comes from here only. */
  facts: VerifiedFacts | null;
  storage: StorageState;
  /** The evidence file exactly as Swarm served it (its root hash was verified), or null. */
  evidenceBytes: Uint8Array | null;
  retry: () => void;
  /**
   * Re-reads the record's expiry and the batch TTL and updates check E from those reads only
   * (never from what a keep-alive meant to do). E shows "Checking…" until the reads are back.
   */
  refreshStorage: () => Promise<void>;
};

type Load =
  | { phase: 'loading' }
  | { phase: 'missing' | 'not-capture' }
  | { phase: 'error'; message: string }
  | { phase: 'record'; record: CaptureRecord; evidence: Evidence };

type Evidence = { state: 'downloading' } | { state: 'ok'; bytes: Uint8Array } | { state: 'failed'; reason: string; raw: string };

const SOON_SECONDS = 7 * 86_400;

async function fetchCapture(cfg: NetConfig, entityKey: Hex): Promise<CaptureRecord> {
  const e = await arkivPublic(cfg).getEntity(entityKey, CaptureSchema);
  return {
    entityKey: e.$key,
    urlHash: e.urlHash.value,
    bodySha256: e.bodySha256.value,
    witness: e.witness.value as Address,
    signedAt: e.signedAt.value,
    batchId: e.batchId.value,
    evidenceRef: e.evidenceRef.value,
    expiresAtBlock: e.$expiresAt,
  };
}

function downloadReason(err: unknown): { reason: string; raw: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (/invalid swarm reference/.test(raw)) return { reason: 'The record has no valid evidence reference.', raw };
  if (/reference mismatch/.test(raw)) {
    return { reason: 'A gateway returned bytes that do not match the Swarm reference, so they were discarded.', raw };
  }
  return { reason: 'No Swarm gateway could provide the evidence file.', raw };
}

const expiresIn = (seconds: number): string => {
  const d = Math.floor(seconds / 86_400);
  const when = d < 1 ? 'within a day' : `in ${d} ${d === 1 ? 'day' : 'days'}`;
  return `Expires ${when}. Keep it alive or download the evidence file.`;
};

/**
 * Check E from live reads. It informs, but never counts toward the verdict. Green needs a
 * successful live read of BOTH the Swarm batch TTL and the Arkiv record expiry; if either
 * could not be read it is never a pass.
 */
function storageCheck(info: StorageInfo): CheckResult {
  const swarmSeconds = info.ttlSeconds === null ? 0 : Number(info.ttlSeconds);
  if (swarmSeconds <= 0) {
    return {
      status: 'warn',
      detail: 'Storage has expired; the evidence may no longer be downloadable. Anyone can keep a capture alive before it expires.',
    };
  }
  if (swarmSeconds < SOON_SECONDS) return { status: 'warn', detail: expiresIn(swarmSeconds) };
  // A missing or nonsensical figure (null, NaN, infinite) is "unavailable", never a pass.
  const left = info.arkivSecondsLeft;
  if (left === null || !Number.isFinite(left)) {
    return {
      status: 'unavailable',
      detail: 'Storage status not fully checked: the Arkiv record expiry could not be read (offline or RPC unreachable).',
    };
  }
  if (left <= 0) {
    return {
      status: 'warn',
      detail: 'The Arkiv record has expired and may disappear from listings. Download the evidence file to keep a copy.',
    };
  }
  if (left < SOON_SECONDS) return { status: 'warn', detail: expiresIn(left) };
  return {
    status: 'pass',
    detail: `Evidence paid on Swarm until ${info.swarmExpiresAt ? formatDay(info.swarmExpiresAt) : 'an unknown date'} · record on Arkiv until ${info.arkivExpiresAt ? formatDay(info.arkivExpiresAt) : `block ${info.arkivExpiresAtBlock}`}.`,
  };
}

const STORAGE_UNREADABLE: { check: CheckResult; info: StorageInfo | null } = {
  check: { status: 'unavailable', detail: 'Storage status not checked (offline or RPC unreachable).' },
  info: null,
};

/**
 * Evidence on a gateway's free storage has no batch, so there is no end date to read and the
 * check can never be a pass (and is not "expired" either: there is no batch that could expire).
 */
function freeStorageCheck(arkivEndsAt: Date | null): CheckResult {
  return {
    status: 'unavailable',
    detail: `This capture used the gateway's free storage, which has no known end date.${
      arkivEndsAt ? ` Record on Arkiv until ${formatDay(arkivEndsAt)}.` : ''
    }`,
  };
}

/**
 * Reads the batch TTL on Gnosis and the Arkiv block timing. A failed read is "Not checked",
 * never a pass, and never "expired": only a contract revert means expired (see `batchTtlSeconds`).
 */
async function readStorage(cfg: NetConfig, record: CaptureRecord): Promise<{ check: CheckResult; info: StorageInfo | null }> {
  const free = isFreeBatch(record.batchId);
  const gnosisClient = createPublicClient({ chain: gnosis, transport: http(cfg.gnosis.rpcUrl) });
  const [ttl, timing] = await Promise.allSettled([
    free ? Promise.resolve(null) : batchTtlSeconds(gnosisClient, record.batchId),
    arkivPublic(cfg).getBlockTiming(),
  ]);
  if (ttl.status === 'rejected') return STORAGE_UNREADABLE;
  const now = Date.now();
  let arkivSecondsLeft: number | null = null;
  if (timing.status === 'fulfilled') {
    arkivSecondsLeft = Number(record.expiresAtBlock - timing.value.currentBlock) * timing.value.blockDuration;
  }
  const info: StorageInfo = {
    ttlSeconds: ttl.value,
    arkivExpiresAtBlock: record.expiresAtBlock,
    arkivSecondsLeft,
    swarmExpiresAt: ttl.value !== null && ttl.value > 0n ? new Date(now + Number(ttl.value) * 1000) : null,
    arkivExpiresAt: arkivSecondsLeft !== null && Number.isFinite(arkivSecondsLeft) ? new Date(now + arkivSecondsLeft * 1000) : null,
  };
  return { check: free ? freeStorageCheck(info.arkivExpiresAt) : storageCheck(info), info };
}

/**
 * Checks A to C (and D with `userFileBytes`) of the evidence a record points to, then the R13
 * cross-check of the verified facts against the record's indexed fields. A record that
 * disagrees with its evidence fails and its facts are withheld: genuine evidence under a record
 * that says something else must not be presented as that record's capture.
 */
export async function verifyRecordEvidence(
  record: RecordClaims,
  bytes: Uint8Array,
  userFileBytes?: Uint8Array,
): Promise<VerifiedReport> {
  try {
    const r = await verifyEvidence(bytes, {
      pinnedWitnesses: trustedWitnesses().map((w) => w.address),
      ...(userFileBytes ? { userFileBytes } : {}),
    });
    const mismatch = r.facts ? crossCheck(r.facts, record) : [];
    if (mismatch.length === 0) return r;
    const { facts: _withheld, ...rest } = r;
    return { ...rest, mismatch };
  } catch (e) {
    // Never leave the page on "Checking…": an unexpected failure is "not checked".
    return unavailableReport('The checks could not run in this browser.', userFileBytes, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Loads one capture record from Arkiv, downloads its evidence from Swarm (the root hash is
 * checked locally, so a gateway cannot alter the bytes), runs checks A to C (and D with
 * `userFile`) in the browser, cross-checks the verified facts against the record's indexed
 * fields (R13) and reads live storage for check E.
 *
 * It never reports a pass it did not earn: a failed download or a gateway returning other
 * bytes is "evidence unavailable"; a record that disagrees with its evidence fails and its
 * facts are withheld; unreadable storage is "Not checked". Storage (E) is independent of the
 * verdict.
 */
export function useVerifiedCapture(entityKey: Hex, userFile?: Uint8Array): VerifiedCapture {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [storage, setStorage] = useState<StorageState>({ phase: 'pending' });
  const [report, setReport] = useState<VerifiedReport | null>(null);

  useEffect(() => {
    let alive = true;
    setLoad({ phase: 'loading' });
    setStorage({ phase: 'pending' });
    setReport(null);
    (async () => {
      try {
        const cfg = getNetConfig();
        let record: CaptureRecord;
        try {
          record = await fetchCapture(cfg, entityKey);
        } catch (e) {
          if (!alive) return;
          const name = (e as { name?: string })?.name;
          if (name === 'NoEntityFoundError') setLoad({ phase: 'missing' });
          else if (name === 'SchemaMismatchError') setLoad({ phase: 'not-capture' });
          else setLoad({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
          return;
        }
        if (!alive) return;
        setLoad({ phase: 'record', record, evidence: { state: 'downloading' } });
        readStorage(cfg, record)
          .catch(() => STORAGE_UNREADABLE)
          .then((s) => {
            if (alive) setStorage({ phase: 'done', ...s });
          });
        try {
          const { bytes } = await downloadEvidence(cfg, record);
          if (alive) setLoad({ phase: 'record', record, evidence: { state: 'ok', bytes } });
        } catch (e) {
          if (alive) setLoad({ phase: 'record', record, evidence: { state: 'failed', ...downloadReason(e) } });
        }
      } catch (e) {
        if (alive) setLoad({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [entityKey, attempt]);

  // Checks run again (cheaply, offline) when the person gives or removes a file for check D.
  useEffect(() => {
    if (load.phase !== 'record' || load.evidence.state === 'downloading') return;
    if (load.evidence.state === 'failed') {
      setReport(unavailableReport(load.evidence.reason, userFile, load.evidence.raw));
      return;
    }
    let alive = true;
    const { record, evidence } = load;
    void verifyRecordEvidence(record, evidence.bytes, userFile).then((r) => {
      if (alive) setReport(r);
    });
    return () => {
      alive = false;
    };
  }, [load, userFile]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const refreshStorage = useCallback(async () => {
    setStorage({ phase: 'pending' });
    try {
      const cfg = getNetConfig();
      // The expiry block moves when a record is extended, so read the record again too.
      const fresh = await fetchCapture(cfg, entityKey);
      setStorage({ phase: 'done', ...(await readStorage(cfg, fresh)) });
    } catch {
      setStorage({ phase: 'done', ...STORAGE_UNREADABLE });
    }
  }, [entityKey]);
  const record = load.phase === 'record' ? load.record : null;
  return {
    phase: load.phase === 'record' ? 'ready' : load.phase,
    error: load.phase === 'error' ? load.message : undefined,
    record,
    report,
    facts: report?.facts ?? null,
    storage,
    evidenceBytes: load.phase === 'record' && load.evidence.state === 'ok' ? load.evidence.bytes : null,
    retry,
    refreshStorage,
  };
}

/** Checks A to C (and D) of an evidence file the person dropped: offline, no network at all. */
export function useVerifiedEvidenceFile(bytes: Uint8Array | null, userFile?: Uint8Array): VerifiedReport | null {
  const [report, setReport] = useState<VerifiedReport | null>(null);
  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    verifyEvidence(bytes, {
      pinnedWitnesses: trustedWitnesses().map((w) => w.address),
      ...(userFile ? { userFileBytes: userFile } : {}),
    })
      .catch((e) =>
        unavailableReport('The checks could not run in this browser.', userFile, e instanceof Error ? e.message : String(e)),
      )
      .then((r) => {
        if (alive) setReport(r);
      });
    return () => {
      alive = false;
    };
  }, [bytes, userFile]);
  return bytes ? report : null;
}
