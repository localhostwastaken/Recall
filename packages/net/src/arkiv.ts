import { createPublicClient, createWalletClient, ExpirationTime } from '@arkiv-network/sdk';
import { localhost, rabdi } from '@arkiv-network/sdk/chains';
import { and, asc, eq, gt } from '@arkiv-network/sdk/query';
import { addr, bytes, defineSchema, i32, key, str, u64 } from '@arkiv-network/sdk/schema';
import type { Account, Address, Hex, Transport } from 'viem';
import { bytesToString, http, stringToBytes } from 'viem';
import type { NetConfig } from './config';

const DEFAULT_DAYS = 30;
const FLAGS = { permissionlessExtension: true } as const;

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

export function arkivPublic(cfg: NetConfig) {
  return createPublicClient({ chain: chainFor(cfg), transport: http(cfg.arkiv.rpcUrl) });
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
  const { entityKey, txHash } = await w.createEntity(
    CaptureSchema,
    {
      urlHash: key(row.urlHash),
      bodySha256: key(row.bodySha256),
      serverName: row.serverName,
      witness: addr(row.witness),
      signedAt: u64(row.signedAt),
      httpStatus: i32(row.httpStatus),
      batchId: key(row.batchId),
      evidenceRef: key(row.evidenceRef),
      canonicalUrl: stringToBytes(row.canonicalUrl),
    },
    options(),
  );
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

export type Listed = (({ kind: 'capture' } & CaptureRow) | ({ kind: 'confirmation' } & ConfirmationRow)) & {
  entityKey: Hex;
  owner: Address;
  expiresAtBlock: bigint;
};

export type ListResult = { rows: Listed[]; truncated: boolean };

export async function listByUrl(
  pub: ArkivPublic,
  urlHash: Hex,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<ListResult> {
  const pageSize = opts.pageSize ?? 100;
  const maxRows = opts.maxRows ?? 2000;

  // Anyone can write rows with our schema tag, so each kind gets its own budget and the
  // caller is told when a budget was exceeded. Paging is keyset ($key > last seen key),
  // which stays stable while new rows are written. One row past the cap tells us whether
  // more existed.
  async function collect<E extends { $key: Hex }>(
    fetchPage: (after: Hex | undefined, limit: number) => Promise<{ entities: readonly E[] }>,
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

export async function latestWitnessUrl(pub: ArkivPublic, witness: Address): Promise<string | null> {
  const page = await pub
    .select()
    .from(WitnessSchema)
    .where(eq('witness', addr(witness)))
    .ownedBy(witness)
    .fetch();
  if (page.entities.length === 0) return null;
  const latest = page.entities.reduce((a, b) => (b.$createdAt > a.$createdAt ? b : a));
  return latest.url.value;
}

export async function extendEntity(w: ArkivWallet, entityKey: Hex, days: number): Promise<Hex> {
  const { txHash } = await w.extendEntity({ entityKey, expiration: ExpirationTime.fromDays(days) });
  return txHash;
}

function hexToBytesSafe(v: Hex | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) return v;
  const h = v.slice(2);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
