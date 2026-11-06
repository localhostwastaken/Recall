import { stringToHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { listAllAttachments, listAllCaptures, type ArkivPublic } from '../src/index';

// listAllCaptures / listAllAttachments without a node: a stubbed `select().from().where()
// .orderBy().limit().fetch()` chain that serves rows in `$key` order after the key named in the
// filter, as the node does. Proves the keyset paging, the row budget and the field decoding.

const k = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const CREATOR = '0x2222222222222222222222222222222222222222' as Address;
const WITNESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;

function capture(n: number) {
  return {
    $key: k(n),
    $owner: OWNER,
    $creator: CREATOR,
    $expiresAt: 1000n + BigInt(n),
    urlHash: { value: k(100 + (n % 2)) },
    bodySha256: { value: k(200 + n) },
    serverName: { value: `site${n}.example` },
    witness: { value: WITNESS },
    signedAt: { value: 1_700_000_000n + BigInt(n) },
    httpStatus: { value: 200 },
    batchId: { value: k(300) },
    evidenceRef: { value: k(400 + n) },
    canonicalUrl: { value: stringToHex(`https://site${n}.example/path`) },
  };
}

function attachment(n: number) {
  return {
    $key: k(n),
    $owner: OWNER,
    $creator: CREATOR,
    $expiresAt: 5000n,
    parentCaptureKey: { value: k(1) },
    urlHash: { value: k(100) },
    sha256: { value: k(500) },
    kind: { value: 'git' },
    commitSha: { value: 'a'.repeat(40) },
    treeSha: { value: 'b'.repeat(40) },
    proofLevel: { value: 1 },
    evidenceRef: { value: k(600) },
    batchId: { value: k(700) },
    size: { value: 42n },
    contentType: { value: 'application/gzip' },
  };
}

/** A fake public client over `entities` (any order); records every page request. */
function stub(entities: { $key: Hex }[]) {
  const calls: { after: Hex | undefined; limit: number }[] = [];
  const sorted = [...entities].sort((a, b) => (BigInt(a.$key) < BigInt(b.$key) ? -1 : 1));
  const pub = {
    select: () => ({
      from: () => {
        let after: Hex | undefined;
        let limit = Infinity;
        const builder = {
          where(filter: unknown) {
            // The only filter listAll* sends is `$key > after`.
            after = /0x[0-9a-f]{64}/i.exec(JSON.stringify(filter, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))?.[0] as Hex;
            return builder;
          },
          orderBy() {
            return builder;
          },
          limit(n: number) {
            limit = n;
            return builder;
          },
          async fetch() {
            calls.push({ after, limit });
            const rest = after ? sorted.filter((e) => BigInt(e.$key) > BigInt(after!)) : sorted;
            return { entities: rest.slice(0, limit) };
          },
        };
        return builder;
      },
    }),
  } as unknown as ArkivPublic;
  return { pub, calls };
}

describe('listAllCaptures (stubbed node)', () => {
  it('pages through every row with keyset paging and decodes the fields', async () => {
    const { pub, calls } = stub([capture(3), capture(1), capture(2)]);
    const { rows, truncated } = await listAllCaptures(pub, { pageSize: 2 });
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.entityKey)).toEqual([k(1), k(2), k(3)]);
    expect(calls.map((c) => c.after)).toEqual([undefined, k(2)]);
    const r = rows[0]!;
    expect(r).toEqual({
      entityKey: k(1),
      owner: OWNER,
      creator: CREATOR,
      expiresAtBlock: 1001n,
      urlHash: k(101),
      bodySha256: k(201),
      serverName: 'site1.example',
      witness: WITNESS,
      signedAt: 1_700_000_001n,
      httpStatus: 200,
      batchId: k(300),
      evidenceRef: k(401),
      canonicalUrl: 'https://site1.example/path',
    });
  });

  it('stops at maxRows and says the list was truncated', async () => {
    const { pub } = stub([1, 2, 3, 4, 5].map(capture));
    const { rows, truncated } = await listAllCaptures(pub, { pageSize: 2, maxRows: 2 });
    expect(rows.map((r) => r.entityKey)).toEqual([k(1), k(2)]);
    expect(truncated).toBe(true);
  });

  it('is not truncated when the rows exactly fill the budget', async () => {
    const { pub } = stub([1, 2, 3].map(capture));
    const { rows, truncated } = await listAllCaptures(pub, { pageSize: 100, maxRows: 3 });
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(false);
  });

  it('defaults to pages of 100 and a budget of 1,000 rows', async () => {
    const { pub, calls } = stub(Array.from({ length: 1005 }, (_, i) => capture(i + 1)));
    const { rows, truncated } = await listAllCaptures(pub);
    expect(rows).toHaveLength(1000);
    expect(truncated).toBe(true);
    expect(Math.max(...calls.map((c) => c.limit))).toBe(100);
  });
});

describe('listAllAttachments (stubbed node)', () => {
  it('pages and decodes attachments', async () => {
    const { pub } = stub([attachment(9), attachment(8), attachment(7)]);
    const { rows, truncated } = await listAllAttachments(pub, { pageSize: 2 });
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.entityKey)).toEqual([k(7), k(8), k(9)]);
    expect(rows[0]).toMatchObject({ kind: 'git', proofLevel: 1, parentCaptureKey: k(1), size: 42n, creator: CREATOR, expiresAtBlock: 5000n });
  });
});
