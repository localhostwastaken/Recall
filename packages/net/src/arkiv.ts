import { createPublicClient, createWalletClient, ExpirationTime, MAX_LIFETIME } from '@arkiv-network/sdk';
import { localhost, rabdi } from '@arkiv-network/sdk/chains';
import { and, asc, eq, gt } from '@arkiv-network/sdk/query';
import { addr, bytes, defineSchema, i32, key, str, u64 } from '@arkiv-network/sdk/schema';
import type { Account, Address, Hex, Transport } from 'viem';
import { bytesToString, http, stringToBytes } from 'viem';
import { arkivRpcUrl, type NetConfig } from './config';
import { redactKey } from './redact';

const DEFAULT_DAYS = 30;
/**
 * Every Recall entity is created read-only (its attributes can never change, not even by its owner)
 * and with permissionless extension (anyone may extend its expiry: keep-alive). The owner can still
 * delete it or hand it to another owner; the SDK has no flag against that. Ruling R41.
 */
const FLAGS = { readonly: true, permissionlessExtension: true } as const;

export const CaptureSchema = defineSchema('recall.v1.capture', {
  urlHash: key().indexed(),
  bodySha256: key(),
  serverName: str().indexed(),
  witness: addr().indexed(),
  signedAt: u64(),
  httpStatus: i32(),
  batchId: key(),
  evidenceRef: key(),
  canonicalUrl: bytes(),
});

export const ConfirmationSchema = defineSchema('recall.v1.confirmation', {
  captureKey: key().indexed(),
  urlHash: key().indexed(),
  bodySha256: key(),
  witness: addr().indexed(),
  signedAt: u64(),
  evidence: bytes(),
});

export const WitnessSchema = defineSchema('recall.v1.witness', {
  witness: addr().indexed(),
  url: str(),
});

/**
 * A file attached to a capture (ruling R46). Level 1 ("hash-anchored"), kind 'git': the parent
 * capture is a notarized GitHub branch response naming commit `commitSha` and tree `treeSha`;
 * the attachment is that commit's tarball on Swarm (`evidenceRef`), whose recomputed git tree
 * must equal `treeSha`. `urlHash` is the hash of the repository's URL, `sha256` the tarball's.
 * Git ids are 40 lower-case hex digits without 0x, as git prints them.
 */
export const AttachmentSchema = defineSchema('recall.v1.attachment', {
  parentCaptureKey: key().indexed(),
  urlHash: key().indexed(),
  sha256: key().indexed(),
  kind: str().indexed(),
  commitSha: str().indexed(),
  treeSha: str().indexed(),
  proofLevel: i32().indexed(),
  evidenceRef: key(),
  batchId: key(),
  size: u64(),
  contentType: str(),
});

export type AttachmentKind = 'git';

export type AttachmentRow = {
  parentCaptureKey: Hex;
  urlHash: Hex;
  sha256: Hex;
  kind: AttachmentKind;
  commitSha: string;
  treeSha: string;
  proofLevel: 1;
  evidenceRef: Hex;
  batchId: Hex;
  size: bigint;
  contentType: string;
};

/**
 * An attachment as read from Arkiv. Anyone can write one, so every field is an unverified
 * claim (`kind` and `proofLevel` too); consumers recompute and compare with `attachmentMatches`.
 */
export type ListedAttachment = Omit<AttachmentRow, 'kind' | 'proofLevel'> & {
  kind: string;
  proofLevel: number;
  entityKey: Hex;
  owner: Address;
  /** Who created the record; unlike the owner it can never change. */
  creator: Address;
  expiresAtBlock: bigint;
};

export type CaptureRow = {
  urlHash: Hex;
  bodySha256: Hex;
  serverName: string;
  witness: Address;
  signedAt: bigint;
  httpStatus: number;
  batchId: Hex;
  evidenceRef: Hex;
  canonicalUrl: string;
};

export type ConfirmationRow = {
  captureKey: Hex;
  urlHash: Hex;
  bodySha256: Hex;
  witness: Address;
  signedAt: bigint;
  evidence: Uint8Array;
};

function chainFor(cfg: NetConfig) {
  return cfg.arkiv.chain === 'rabdi' ? rabdi({ accessKey: cfg.arkiv.accessKey ?? '' }) : localhost;
}

/** Rewrites an error and its causes so the key is nowhere in them (message, details, URL line, stack). */
function scrub(err: unknown, key: string | undefined): unknown {
  const seen = new Set<unknown>();
  for (let e = err as Record<string, unknown> | undefined; e && typeof e === 'object' && !seen.has(e) && seen.size < 12; e = e.cause as typeof e) {
    seen.add(e);
    for (const field of ['message', 'shortMessage', 'details', 'url', 'stack']) {
      const v = e[field];
      if (typeof v !== 'string') continue;
      try {
        e[field] = redactKey(v, key);
      } catch {
        /* a read-only field: nothing more can be done */
      }
    }
    if (Array.isArray(e.metaMessages)) {
      try {
        e.metaMessages = e.metaMessages.map((m) => (typeof m === 'string' ? redactKey(m, key) : m));
      } catch {
        /* as above */
      }
    }
  }
  return err;
}

/**
 * The reads' transport: an HTTP transport on the effective Arkiv URL (which carries the access
 * key on the Rabdi host, see `arkivRpcUrl`) whose errors are scrubbed. viem puts the full URL in
 * an HTTP error's message ("URL: ..."), and these messages end up in the page and the console.
 */
function readTransport(cfg: NetConfig): Transport {
  const inner = http(arkivRpcUrl(cfg));
  const key = cfg.arkiv.accessKey?.trim();
  return (opts) => {
    const t = inner(opts);
    return {
      ...t,
      request: (async (args: Parameters<typeof t.request>[0]) => {
        try {
          return await t.request(args);
        } catch (err) {
          throw scrub(err, key);
        }
      }) as typeof t.request,
    };
  };
}

export function arkivPublic(cfg: NetConfig) {
  return createPublicClient({ chain: chainFor(cfg), transport: readTransport(cfg) });
}

export function arkivWallet(cfg: NetConfig, transport: Transport, account: Account) {
  return createWalletClient({ chain: chainFor(cfg), transport, account });
}

export type ArkivPublic = ReturnType<typeof arkivPublic>;
export type ArkivWallet = ReturnType<typeof arkivWallet>;

const options = () => ({ expiration: ExpirationTime.fromDays(DEFAULT_DAYS), flags: FLAGS });

export async function writeCapture(
  w: ArkivWallet,
  row: CaptureRow,
): Promise<{ entityKey: Hex; txHash: Hex }> {
  const { entityKey, txHash } = await w.createEntity(CaptureSchema, captureValues(row), options());
  return { entityKey, txHash };
}

export async function writeConfirmation(
  w: ArkivWallet,
  row: ConfirmationRow,
): Promise<{ entityKey: Hex; txHash: Hex }> {
  const { entityKey, txHash } = await w.createEntity(
    ConfirmationSchema,
    {
      captureKey: key(row.captureKey),
      urlHash: key(row.urlHash),
      bodySha256: key(row.bodySha256),
      witness: addr(row.witness),
      signedAt: u64(row.signedAt),
      evidence: row.evidence,
    },
    options(),
  );
  return { entityKey, txHash };
}

export async function writeWitnessProfile(
  w: ArkivWallet,
  p: { witness: Address; url: string },
): Promise<{ entityKey: Hex; txHash: Hex }> {
  const { entityKey, txHash } = await w.createEntity(
    WitnessSchema,
    { witness: addr(p.witness), url: p.url },
    options(),
  );
  return { entityKey, txHash };
}

const GIT_ID = /^[0-9a-f]{40}$/;

function checkAttachment(row: Omit<AttachmentRow, 'parentCaptureKey'>): void {
  if (row.kind !== 'git') throw new Error(`unsupported attachment kind "${String(row.kind)}"`);
  if (row.proofLevel !== 1) throw new Error(`unsupported proof level ${String(row.proofLevel)}`);
  if (!GIT_ID.test(row.commitSha)) throw new Error('commitSha must be 40 lower-case hex digits');
  if (!GIT_ID.test(row.treeSha)) throw new Error('treeSha must be 40 lower-case hex digits');
  if (row.size < 0n) throw new Error('size must not be negative');
}

function attachmentValues(row: AttachmentRow) {
  return {
    parentCaptureKey: key(row.parentCaptureKey),
    urlHash: key(row.urlHash),
    sha256: key(row.sha256),
    kind: str(row.kind),
    commitSha: str(row.commitSha),
    treeSha: str(row.treeSha),
    proofLevel: i32(row.proofLevel),
    evidenceRef: key(row.evidenceRef),
    batchId: key(row.batchId),
    size: u64(row.size),
    contentType: str(row.contentType),
  };
}

function captureValues(row: CaptureRow) {
  return {
    urlHash: key(row.urlHash),
    bodySha256: key(row.bodySha256),
    serverName: row.serverName,
    witness: addr(row.witness),
    signedAt: u64(row.signedAt),
    httpStatus: i32(row.httpStatus),
    batchId: key(row.batchId),
    evidenceRef: key(row.evidenceRef),
    canonicalUrl: stringToBytes(row.canonicalUrl),
  };
}

const asPublic = (p: ArkivPublic | NetConfig): ArkivPublic =>
  typeof (p as ArkivPublic).select === 'function' ? (p as ArkivPublic) : arkivPublic(p as NetConfig);

/** Writes one attachment record. The `cfg` form exists for callers that pass it; it is not needed. */
export async function writeAttachment(w: ArkivWallet, row: AttachmentRow): Promise<{ entityKey: Hex; txHash: Hex }>;
export async function writeAttachment(
  w: ArkivWallet,
  cfg: NetConfig,
  row: AttachmentRow,
): Promise<{ entityKey: Hex; txHash: Hex }>;
export async function writeAttachment(
  w: ArkivWallet,
  a: AttachmentRow | NetConfig,
  b?: AttachmentRow,
): Promise<{ entityKey: Hex; txHash: Hex }> {
  const row = (b ?? a) as AttachmentRow;
  checkAttachment(row);
  const { entityKey, txHash } = await w.createEntity(AttachmentSchema, attachmentValues(row), options());
  return { entityKey, txHash };
}

/**
 * The capture record and its attachment in ONE transaction (one wallet prompt). The capture's
 * key is predicted from the writer's entity nonce and a salt, so the attachment can name it as
 * its parent. Throws if the chain created the capture under another key (another create by the
 * same account got in between); the attachment then names no capture and must be rewritten.
 */
export async function writeCaptureWithAttachment(
  w: ArkivWallet,
  pubOrCfg: ArkivPublic | NetConfig,
  capture: CaptureRow,
  attachment: Omit<AttachmentRow, 'parentCaptureKey'>,
): Promise<{ captureKey: Hex; attachmentKey: Hex; txHash: Hex }> {
  checkAttachment(attachment);
  const owner = w.account?.address;
  if (!owner) throw new Error('the wallet has no account');
  const [predicted] = await asPublic(pubOrCfg).predictEntityKeys({ owner, count: 1 });
  const row: AttachmentRow = { ...attachment, parentCaptureKey: predicted!.key };
  const { expiration, flags } = options();
  const { txHash, createdEntities } = await w.executeBatch({
    creates: [
      { schema: CaptureSchema, values: captureValues(capture), expiration, flags, salt: predicted!.salt },
      { schema: AttachmentSchema, values: attachmentValues(row), expiration, flags },
    ],
  });
  const [captureKey, attachmentKey] = createdEntities;
  if (!captureKey || !attachmentKey || captureKey.toLowerCase() !== predicted!.key.toLowerCase()) {
    throw new Error('the capture was created under another key than predicted; its attachment names no capture');
  }
  return { captureKey, attachmentKey, txHash };
}

/**
 * Every attachment that names `parentCaptureKey`, whoever wrote it (owner-agnostic: the
 * consumer verifies each one against the bytes, see `attachmentMatches`). Keyset-paged with a
 * row budget, like `listByUrl`.
 */
export async function listAttachments(
  pubOrCfg: ArkivPublic | NetConfig,
  parentCaptureKey: Hex,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<{ rows: ListedAttachment[]; truncated: boolean }> {
  const pub = asPublic(pubOrCfg);
  const { entities, truncated } = await collectPages(
    (after, limit) =>
      pub
        .select()
        .from(AttachmentSchema)
        .where(
          after
            ? and(eq('parentCaptureKey', key(parentCaptureKey)), gt('$key', key(after)))
            : eq('parentCaptureKey', key(parentCaptureKey)),
        )
        .orderBy(asc('$key'))
        .limit(limit)
        .fetch(),
    opts.pageSize ?? 100,
    opts.maxRows ?? 500,
  );
  const rows = entities.map(
    (e): ListedAttachment => ({
      entityKey: e.$key,
      owner: e.$owner as Address,
      creator: e.$creator as Address,
      expiresAtBlock: e.$expiresAt,
      parentCaptureKey: e.parentCaptureKey.value,
      urlHash: e.urlHash.value,
      sha256: e.sha256.value,
      kind: e.kind.value,
      commitSha: e.commitSha.value,
      treeSha: e.treeSha.value,
      proofLevel: Number(e.proofLevel.value),
      evidenceRef: e.evidenceRef.value,
      batchId: e.batchId.value,
      size: e.size.value,
      contentType: e.contentType.value,
    }),
  );
  return { rows, truncated };
}

/** What a consumer computed itself: from the verified parent capture and the downloaded bytes. */
export type AttachmentComputed = {
  parentCaptureKey: Hex;
  urlHash: Hex;
  /** sha256 of the downloaded file. */
  sha256: Hex;
  /** From the notarized GitHub response of the parent capture. */
  commitSha: string;
  /** Recomputed from the downloaded tarball; must equal the notarized one first. */
  treeSha: string;
  /** Length of the downloaded file. */
  size: number | bigint;
};

/**
 * The R13-style cross-check for an attachment: the names of the record's fields that differ
 * from what the consumer computed (empty means the record agrees). The record must also be
 * kind 'git' at proof level 1, the only kind this version can verify.
 */
export function attachmentMatches(
  record: Pick<ListedAttachment, 'parentCaptureKey' | 'urlHash' | 'sha256' | 'kind' | 'commitSha' | 'treeSha' | 'proofLevel' | 'size'>,
  computed: AttachmentComputed,
): string[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const differs: string[] = [];
  if (record.kind !== 'git') differs.push('kind');
  if (record.proofLevel !== 1) differs.push('proof level');
  if (!same(record.parentCaptureKey, computed.parentCaptureKey)) differs.push('parent capture');
  if (!same(record.urlHash, computed.urlHash)) differs.push('repository address');
  if (!same(record.sha256, computed.sha256)) differs.push('file hash');
  if (!same(record.commitSha, computed.commitSha)) differs.push('commit');
  if (!same(record.treeSha, computed.treeSha)) differs.push('tree');
  if (record.size !== BigInt(computed.size)) differs.push('size');
  return differs;
}

export type Listed = (({ kind: 'capture' } & CaptureRow) | ({ kind: 'confirmation' } & ConfirmationRow)) & {
  entityKey: Hex;
  owner: Address;
  expiresAtBlock: bigint;
};

export type ListResult = { rows: Listed[]; truncated: boolean };

/**
 * Reads up to `maxRows` entities page by page. Paging is keyset ($key > last seen key), which
 * stays stable while new rows are written. One row past the cap tells us whether more existed.
 */
async function collectPages<E extends { $key: Hex }>(
  fetchPage: (after: Hex | undefined, limit: number) => Promise<{ entities: readonly E[] }>,
  pageSize: number,
  maxRows: number,
): Promise<{ entities: E[]; truncated: boolean }> {
  const seen = new Set<Hex>();
  const all: E[] = [];
  let after: Hex | undefined;
  while (all.length <= maxRows) {
    const limit = Math.min(pageSize, maxRows + 1 - all.length);
    const page = (await fetchPage(after, limit)).entities;
    for (const e of page) {
      if (!seen.has(e.$key)) {
        seen.add(e.$key);
        all.push(e);
      }
    }
    if (page.length < limit) break;
    after = page[page.length - 1]!.$key;
  }
  const truncated = all.length > maxRows;
  return { entities: all.slice(0, maxRows), truncated };
}

export async function listByUrl(
  pub: ArkivPublic,
  urlHash: Hex,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<ListResult> {
  const pageSize = opts.pageSize ?? 100;
  const maxRows = opts.maxRows ?? 2000;

  // Anyone can write rows with our schema tag, so each kind gets its own budget and the
  // caller is told when a budget was exceeded.
  const collect = <E extends { $key: Hex }>(
    fetchPage: (after: Hex | undefined, limit: number) => Promise<{ entities: readonly E[] }>,
  ) => collectPages(fetchPage, pageSize, maxRows);

  const captures = await collect((after, limit) =>
    pub
      .select()
      .from(CaptureSchema)
      .where(
        after
          ? and(eq('urlHash', key(urlHash)), gt('$key', key(after)))
          : eq('urlHash', key(urlHash)),
      )
      .orderBy(asc('$key'))
      .limit(limit)
      .fetch(),
  );
  const confirmations = await collect((after, limit) =>
    pub
      .select()
      .from(ConfirmationSchema)
      .where(
        after
          ? and(eq('urlHash', key(urlHash)), gt('$key', key(after)))
          : eq('urlHash', key(urlHash)),
      )
      .orderBy(asc('$key'))
      .limit(limit)
      .fetch(),
  );
  const truncated = captures.truncated || confirmations.truncated;
  const out: Listed[] = [];
  for (const e of captures.entities) {
    out.push({
      kind: 'capture',
      entityKey: e.$key,
      owner: e.$owner as Address,
      expiresAtBlock: e.$expiresAt,
      urlHash: e.urlHash.value,
      bodySha256: e.bodySha256.value,
      serverName: e.serverName.value,
      witness: e.witness.value as Address,
      signedAt: e.signedAt.value,
      httpStatus: Number(e.httpStatus.value),
      batchId: e.batchId.value,
      evidenceRef: e.evidenceRef.value,
      canonicalUrl: bytesToString(hexToBytesSafe(e.canonicalUrl.value)),
    });
  }
  for (const e of confirmations.entities) {
    out.push({
      kind: 'confirmation',
      entityKey: e.$key,
      owner: e.$owner as Address,
      expiresAtBlock: e.$expiresAt,
      captureKey: e.captureKey.value,
      urlHash: e.urlHash.value,
      bodySha256: e.bodySha256.value,
      witness: e.witness.value as Address,
      signedAt: e.signedAt.value,
      evidence: hexToBytesSafe(e.evidence.value),
    });
  }
  return { rows: out, truncated };
}

/**
 * The URL of the witness's newest profile. Only profiles CREATED by the witness key count: the
 * creator never changes, whereas the owner does. Filtering on the owner would let anyone write a
 * newer profile naming the witness and then hand it to the witness (`changeOwnership`), and so
 * point extensions at their own server. Ruling R41.
 */
export async function latestWitnessUrl(pub: ArkivPublic, witness: Address): Promise<string | null> {
  const page = await pub
    .select()
    .from(WitnessSchema)
    .where(eq('witness', addr(witness)))
    .createdBy(witness)
    .fetch();
  if (page.entities.length === 0) return null;
  const latest = page.entities.reduce((a, b) => (b.$createdAt > a.$createdAt ? b : a));
  return latest.url.value;
}

/**
 * Sets the entity to expire `days` from NOW. The chain only accepts a later expiry
 * (`ExpiryNotExtended` otherwise), so on a record that already has more than `days` left this
 * reverts. The keep-alive uses `extendEntities`, which adds days on top of the current expiry.
 */
export async function extendEntity(w: ArkivWallet, entityKey: Hex, days: number): Promise<Hex> {
  const { txHash } = await w.extendEntity({ entityKey, expiration: ExpirationTime.fromDays(days) });
  return txHash;
}

/** The SDK counts lifetimes in blocks of a nominal 2 s (the chain's real pace comes from `getBlockTiming`). */
export const NOMINAL_BLOCK_SECONDS = 2;
/** The longest an entity may live, counted from the block an extension lands in: about 182 days. */
export const MAX_LIFETIME_BLOCKS: bigint = MAX_LIFETIME;

/** A number of days as whole blocks of the nominal 2 s. */
export function blocksForDays(days: number): bigint {
  if (!(days > 0)) throw new Error('days must be positive');
  return BigInt(Math.round((days * 86_400) / NOMINAL_BLOCK_SECONDS));
}

export type ExtensionPlan = {
  /** The expiry to ask for: the current one plus the days, or the chain maximum when that is less. */
  toBlock: bigint;
  /** True when the maximum, not the days, set `toBlock`. */
  capped: boolean;
  /**
   * False when there is nothing worth sending: the record is already at (or past) `toBlock`, or the
   * maximum would add less than a day (at the maximum the cap moves up a block at a time).
   */
  extends: boolean;
};

/** Below this gain, an extension that hit the chain maximum is not worth a transaction fee. */
const MIN_USEFUL_GAIN_BLOCKS = blocksForDays(1);

/** Where an extension by `days` lands: on top of the current expiry, never past the chain maximum. */
export function planExtension(a: { expiresAtBlock: bigint; currentBlock: bigint; days: number }): ExtensionPlan {
  const wanted = a.expiresAtBlock + blocksForDays(a.days);
  const cap = a.currentBlock + MAX_LIFETIME_BLOCKS;
  const toBlock = wanted > cap ? cap : wanted;
  const capped = wanted > cap;
  const gain = toBlock - a.expiresAtBlock;
  return { toBlock, capped, extends: capped ? gain >= MIN_USEFUL_GAIN_BLOCKS : gain > 0n };
}

export type ArkivExpiry = { entityKey: Hex; expiresAtBlock: bigint; currentBlock: bigint; blockSeconds: number };

/** Reads the live expiry block of each entity, with the chain's block and its real block time. */
export async function readArkivExpiry(pub: ArkivPublic, entityKeys: Hex[]): Promise<ArkivExpiry[]> {
  const [timing, entities] = await Promise.all([pub.getBlockTiming(), Promise.all(entityKeys.map((k) => pub.getEntity(k)))]);
  return entities.map((e, i) => ({
    entityKey: entityKeys[i]!,
    expiresAtBlock: e.$expiresAt,
    currentBlock: timing.currentBlock,
    blockSeconds: timing.blockDuration,
  }));
}

/**
 * Keep-alive for Arkiv records: each entity gets `days` on top of its own current expiry (capped
 * at the chain maximum), all in ONE transaction, so there is one wallet prompt for any number of
 * records. A record already at the maximum is skipped; with nothing to send, `txHash` is null.
 * Anyone may do this to a record created with `permissionlessExtension`.
 */
export async function extendEntities(
  w: ArkivWallet,
  pub: ArkivPublic,
  entityKeys: Hex[],
  days: number,
): Promise<{ txHash: Hex | null; plans: (ExtensionPlan & { entityKey: Hex })[] }> {
  const unique = [...new Set(entityKeys.map((k) => k.toLowerCase() as Hex))];
  const current = await readArkivExpiry(pub, unique);
  const plans = current.map((c) => ({ entityKey: c.entityKey, ...planExtension({ ...c, days }) }));
  const todo = plans.filter((p) => p.extends);
  if (todo.length === 0) return { txHash: null, plans };
  const { txHash } = await w.executeBatch({
    extensions: todo.map((p) => ({ entityKey: p.entityKey, expiration: ExpirationTime.atBlock(p.toBlock) })),
  });
  return { txHash, plans };
}

function hexToBytesSafe(v: Hex | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) return v;
  const h = v.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
