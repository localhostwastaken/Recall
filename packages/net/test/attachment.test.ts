import { randomUUID } from 'node:crypto';
import { createWalletClient, http, keccak256, parseEther, stringToBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { str } from '@arkiv-network/sdk/schema';
import { DEV_PRIVATE_KEY } from '../../../e2e/fixtures/keys';
import {
  ATTACHMENT_MAX_DOWNLOAD_BYTES,
  AttachmentSchema,
  LOCAL,
  arkivPublic,
  arkivWallet,
  attachmentMatches,
  blocksForDays,
  extendEntities,
  listAttachments,
  listByUrl,
  readArkivExpiry,
  writeAttachment,
  writeCaptureWithAttachment,
  type ArkivWallet,
  type AttachmentRow,
} from '../src/index';

const transport = http(LOCAL.arkiv.rpcUrl);
const h32 = (b: string) => ('0x' + b.repeat(32)) as Hex;

function row(parentCaptureKey: Hex, over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    parentCaptureKey,
    urlHash: keccak256(stringToBytes('https://github.com/permissionlesstech/bitchat')),
    sha256: h32('ab'),
    kind: 'git',
    commitSha: '04995f68e470a18d1fc99f86fa326c2a87bab4f2',
    treeSha: '74f38d254ea1a6a87caec1016b29dc4ca296b5ff',
    proofLevel: 1,
    evidenceRef: h32('ef'),
    batchId: h32('cd'),
    size: 15_350_000n,
    contentType: 'application/gzip',
    ...over,
  };
}

describe('attachmentMatches (R13-style cross-check)', () => {
  const r = row(h32('11'));
  const computed = {
    parentCaptureKey: r.parentCaptureKey,
    urlHash: r.urlHash,
    sha256: r.sha256,
    commitSha: r.commitSha,
    treeSha: r.treeSha,
    size: Number(r.size),
  };

  it('is empty when every field agrees (hex case ignored)', () => {
    expect(attachmentMatches(r, computed)).toEqual([]);
    expect(attachmentMatches({ ...r, sha256: r.sha256.toUpperCase().replace('0X', '0x') as Hex }, computed)).toEqual([]);
  });

  it('names each field that differs', () => {
    expect(attachmentMatches({ ...r, treeSha: 'f'.repeat(40) }, computed)).toEqual(['tree']);
    expect(attachmentMatches({ ...r, commitSha: 'f'.repeat(40), sha256: h32('00') }, computed)).toEqual(['file hash', 'commit']);
    expect(attachmentMatches({ ...r, parentCaptureKey: h32('22') }, computed)).toEqual(['parent capture']);
    expect(attachmentMatches({ ...r, urlHash: h32('33') }, computed)).toEqual(['repository address']);
    expect(attachmentMatches({ ...r, size: 1n }, computed)).toEqual(['size']);
    expect(attachmentMatches({ ...r, kind: 'pdf' }, computed)).toEqual(['kind']);
    expect(attachmentMatches({ ...r, proofLevel: 2 }, computed)).toEqual(['proof level']);
  });
});

describe('writeAttachment input checks', () => {
  const never = {} as ArkivWallet; // the checks throw before the wallet is used
  const bad: [string, Partial<AttachmentRow>][] = [
    ['a short commit id', { commitSha: 'abc' }],
    ['a 0x-prefixed tree id', { treeSha: '0x' + 'a'.repeat(38) }],
    ['an upper-case tree id', { treeSha: 'A'.repeat(40) }],
    ['another kind', { kind: 'pdf' as 'git' }],
    ['another proof level', { proofLevel: 2 as 1 }],
    ['a negative size', { size: -1n }],
  ];
  for (const [what, over] of bad) {
    it(`refuses ${what}`, async () => {
      await expect(writeAttachment(never, row(h32('11'), over))).rejects.toThrow();
    });
  }

  it('downloads of attachments may be larger than evidence files', () => {
    expect(ATTACHMENT_MAX_DOWNLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('attachments on the local Arkiv node', () => {
  const pub = arkivPublic(LOCAL);

  async function funded() {
    const acct = privateKeyToAccount(generatePrivateKey());
    const bank = createWalletClient({ account: privateKeyToAccount(DEV_PRIVATE_KEY), chain: pub.chain, transport });
    await pub.waitForTransactionReceipt({ hash: await bank.sendTransaction({ to: acct.address, value: parseEther('1') }) });
    return acct;
  }

  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    let v = await read();
    for (let i = 0; i < 40 && !ok(v); i++) {
      await new Promise((r) => setTimeout(r, 250));
      v = await read();
    }
    return v;
  }

  it('writeAttachment then listAttachments returns every field, for any writer; records are read-only and anyone may extend them', async () => {
    const alice = await funded();
    const bob = await funded();
    const stranger = await funded();
    const parent = keccak256(stringToBytes(`parent-${randomUUID()}`));
    const a = await writeAttachment(arkivWallet(LOCAL, transport, alice), row(parent));
    const b = await writeAttachment(arkivWallet(LOCAL, transport, bob), row(parent, { treeSha: 'b'.repeat(40), size: 7n }));
    await writeAttachment(arkivWallet(LOCAL, transport, bob), row(keccak256(stringToBytes(`other-${randomUUID()}`))));

    const { rows, truncated } = await eventually(() => listAttachments(pub, parent), (r) => r.rows.length >= 2);
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.entityKey).sort()).toEqual([a.entityKey, b.entityKey].sort());
    const ra = rows.find((r) => r.entityKey === a.entityKey)!;
    expect(ra).toMatchObject({ ...row(parent), owner: alice.address, creator: alice.address });
    expect(ra.expiresAtBlock > 0n).toBe(true);
    const rb = rows.find((r) => r.entityKey === b.entityKey)!;
    expect(rb.creator).toBe(bob.address);
    expect(rb.size).toBe(7n);

    // read-only: not even the owner can change a field
    await expect(
      arkivWallet(LOCAL, transport, alice).patchEntity(AttachmentSchema, a.entityKey, { set: { treeSha: str('c'.repeat(40)) } }),
    ).rejects.toThrow();
    // permissionless extension
    const before = await readArkivExpiry(pub, [a.entityKey]);
    const out = await extendEntities(arkivWallet(LOCAL, transport, stranger), pub, [a.entityKey], 7);
    expect(out.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const after = await readArkivExpiry(pub, [a.entityKey]);
    expect(after[0]!.expiresAtBlock).toBe(before[0]!.expiresAtBlock + blocksForDays(7));
  });

  it('writeCaptureWithAttachment writes both in one transaction, the attachment naming the capture', async () => {
    const alice = await funded();
    const urlHash = keccak256(stringToBytes(`https://api.github.recall.test/repos/o/r/branches/main?run=${randomUUID()}`));
    const { parentCaptureKey: _unused, ...att } = row(h32('00'));
    const out = await writeCaptureWithAttachment(arkivWallet(LOCAL, transport, alice), LOCAL, {
      urlHash,
      bodySha256: h32('ab'),
      serverName: 'api.github.recall.test',
      witness: alice.address,
      signedAt: 1n,
      httpStatus: 200,
      batchId: h32('cd'),
      evidenceRef: h32('ef'),
      canonicalUrl: 'https://api.github.recall.test/repos/o/r/branches/main',
    }, att);
    const caps = await eventually(() => listByUrl(pub, urlHash), (r) => r.rows.length > 0);
    expect(caps.rows.map((r) => r.entityKey)).toEqual([out.captureKey]);
    const { rows } = await eventually(() => listAttachments(LOCAL, out.captureKey), (r) => r.rows.length > 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...att, entityKey: out.attachmentKey, parentCaptureKey: out.captureKey });
  });

  it('listAttachments stops at maxRows and says so', async () => {
    const alice = await funded();
    const parent = keccak256(stringToBytes(`parent-${randomUUID()}`));
    const w = arkivWallet(LOCAL, transport, alice);
    for (let i = 0; i < 3; i++) await writeAttachment(w, row(parent, { size: BigInt(i) }));
    await eventually(() => listAttachments(pub, parent), (r) => r.rows.length >= 3);
    const capped = await listAttachments(pub, parent, { maxRows: 2, pageSize: 1 });
    expect(capped.rows).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    const exact = await listAttachments(pub, parent, { maxRows: 3, pageSize: 2 });
    expect(exact.rows).toHaveLength(3);
    expect(exact.truncated).toBe(false);
  });
});
