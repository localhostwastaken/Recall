// Pending records: a capture whose evidence is on Swarm and that waits for the user to
// publish its Arkiv record in the web app's approve tab. Each one is stored under an
// unguessable 128-bit captureId; there is no way to list them (ruling R27).
import type { Hex } from 'viem';
import type { EvidenceFile } from '@recall/evidence';

export const PENDING_PREFIX = 'recall.pending.';
/** After markPublished: a small tombstone (no evidence), so a repeated mark stays ok. */
export const PUBLISHED_PREFIX = 'recall.published.';

/** 16 random bytes as 32 lower-case hex characters. */
export const CAPTURE_ID = /^[0-9a-f]{32}$/;

export type PendingRecord = {
  captureId: string;
  kind: 'capture' | 'confirmation';
  evidence: EvidenceFile;
  evidenceRef?: Hex;
  batchId?: Hex;
  captureKey?: Hex;
  /** From the verified facts; what the Arkiv record must carry. */
  bodySha256: Hex;
  createdAt: number;
};

/** The indexed fields of an Arkiv record, as the offscreen document read them. */
export type EntitySummary =
  | { kind: 'capture'; bodySha256: Hex; evidenceRef: Hex }
  | { kind: 'confirmation'; bodySha256: Hex; captureKey: Hex };

export type PendingArea = {
  /** `null` reads everything (used only to prune old records). */
  get(key: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
};

/** Pending records and tombstones older than this are dropped. */
export const PENDING_MAX_AGE_MS = 7 * 86_400_000;
/** At most this many pending records are kept (the newest). */
export const PENDING_MAX = 20;

/** A published capture: the record key it was published under, and when. */
type Tombstone = { entityKey: string; at: number };

const defaultArea = (): PendingArea => chrome.storage.local as unknown as PendingArea;

export function newCaptureId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const isCaptureId = (v: unknown): v is string => typeof v === 'string' && CAPTURE_ID.test(v);
const isEntityKey = (v: unknown): v is Hex =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Stored as a JSON string: chrome.storage would sort the keys of an object, and the
 * evidence must come back in the order it was uploaded in (see canonicalEvidence).
 */
export async function savePending(
  rec: PendingRecord,
  area: PendingArea = defaultArea(),
): Promise<void> {
  await area.set({ [PENDING_PREFIX + rec.captureId]: JSON.stringify(rec) });
  await prunePending(area, rec.createdAt);
}

/**
 * Drops pending records and tombstones older than 7 days, and all but the newest 20
 * pending records. An unpublished capture's evidence stays on Swarm; only the
 * extension's hand-over copy goes.
 */
export async function prunePending(area: PendingArea, now = Date.now()): Promise<void> {
  const all = await area.get(null);
  const pending: { key: string; at: number }[] = [];
  const drop: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PENDING_PREFIX)) {
      let at = 0;
      try {
        at = Number((JSON.parse(String(value)) as PendingRecord).createdAt) || 0;
      } catch {
        /* unreadable: oldest, so dropped first */
      }
      if (now - at > PENDING_MAX_AGE_MS) drop.push(key);
      else pending.push({ key, at });
    } else if (key.startsWith(PUBLISHED_PREFIX)) {
      const at = (value as Partial<Tombstone> | null)?.at;
      if (typeof at !== 'number' || now - at > PENDING_MAX_AGE_MS) drop.push(key);
    }
  }
  pending.sort((a, b) => b.at - a.at);
  drop.push(...pending.slice(PENDING_MAX).map((p) => p.key));
  if (drop.length) await area.remove(drop);
}

/** The pending record for exactly this captureId, or null (malformed ids never reach storage). */
export async function readPending(
  captureId: unknown,
  area: PendingArea = defaultArea(),
): Promise<PendingRecord | null> {
  if (!isCaptureId(captureId)) return null;
  const raw = (await area.get(PENDING_PREFIX + captureId))[PENDING_PREFIX + captureId];
  if (typeof raw !== 'string') return null;
  try {
    const rec = JSON.parse(raw) as PendingRecord;
    return rec?.captureId === captureId ? rec : null;
  } catch {
    return null;
  }
}

const same = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Why an Arkiv record does not belong to this pending record, or null when it does. */
export function entityMismatch(rec: PendingRecord, entity: EntitySummary): string | null {
  if (entity.kind !== rec.kind) return `the record is a ${entity.kind}, not a ${rec.kind}`;
  if (!same(entity.bodySha256, rec.bodySha256)) return 'bodySha256 does not match';
  if (entity.kind === 'capture' && !same(entity.evidenceRef, rec.evidenceRef)) {
    return 'evidenceRef does not match';
  }
  if (entity.kind === 'confirmation' && !same(entity.captureKey, rec.captureKey)) {
    return 'captureKey does not match';
  }
  return null;
}

/**
 * Marks a pending record as published once `readEntity` shows an Arkiv record that
 * matches it. The record is then removed; a repeated call with the same key stays ok.
 */
export async function markPublished(
  captureId: unknown,
  entityKey: unknown,
  readEntity: (key: Hex) => Promise<EntitySummary | { error: string }>,
  area: PendingArea = defaultArea(),
): Promise<{ ok: true } | { error: string }> {
  if (!isCaptureId(captureId)) return { error: 'no pending capture with this id' };
  if (!isEntityKey(entityKey)) return { error: 'entityKey must be 0x + 64 hex' };
  const rec = await readPending(captureId, area);
  if (!rec) {
    const done = (await area.get(PUBLISHED_PREFIX + captureId))[PUBLISHED_PREFIX + captureId] as
      | Partial<Tombstone>
      | undefined;
    return same(done?.entityKey, entityKey)
      ? { ok: true }
      : { error: 'no pending capture with this id' };
  }
  const entity = await readEntity(entityKey);
  if ('error' in entity) return { error: `the Arkiv record could not be read: ${entity.error}` };
  const mismatch = entityMismatch(rec, entity);
  if (mismatch) return { error: `the Arkiv record does not match this capture: ${mismatch}` };
  const tombstone: Tombstone = { entityKey: entityKey.toLowerCase(), at: Date.now() };
  await area.set({ [PUBLISHED_PREFIX + captureId]: tombstone });
  await area.remove(PENDING_PREFIX + captureId);
  return { ok: true };
}
