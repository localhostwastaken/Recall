import { randomUUID } from 'node:crypto';
import { createWalletClient, http, keccak256, parseEther, stringToBytes, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { DEV_PRIVATE_KEY } from '../../../e2e/fixtures/keys';
import {
  LOCAL,
  arkivPublic,
  arkivWallet,
  listAllAttachments,
  listAllCaptures,
  writeAttachment,
  writeCapture,
  type CaptureRow,
} from '../src/index';

// Devnet round-trip for the public library's reads (needs the local Arkiv node). The devnet
// keeps state between runs, so the test looks for its own rows among everything listed.

const transport = http(LOCAL.arkiv.rpcUrl);
const h32 = (b: string) => ('0x' + b.repeat(32)) as Hex;

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 40 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 250));
    v = await read();
  }
  return v;
}

describe('listAllCaptures / listAllAttachments (devnet)', () => {
  it('lists every capture and attachment, keyset-paged, with a row budget', async () => {
    const dev = privateKeyToAccount(DEV_PRIVATE_KEY);
    const writer = privateKeyToAccount(generatePrivateKey());
    const pub = arkivPublic(LOCAL);
    const bank = createWalletClient({ account: dev, chain: pub.chain, transport });
    await pub.waitForTransactionReceipt({ hash: await bank.sendTransaction({ to: writer.address, value: parseEther('1') }) });
    const w = arkivWallet(LOCAL, transport, writer);

    const run = randomUUID();
    const shared = keccak256(stringToBytes(`https://notice.recall.test/a?run=${run}`));
    const other = keccak256(stringToBytes(`https://notice.recall.test/b?run=${run}`));
    const row = (urlHash: Hex, n: number): CaptureRow => ({
      urlHash,
      bodySha256: h32('ab'),
      serverName: 'notice.recall.test',
      witness: writer.address,
      signedAt: 1_700_000_000n + BigInt(n),
      httpStatus: 200,
      batchId: h32('cd'),
      evidenceRef: h32(n.toString(16).padStart(2, '0')),
      canonicalUrl: `https://notice.recall.test/${n}?run=${run}`,
    });
    const written = [row(shared, 1), row(shared, 2), row(other, 3)];
    const keys: Hex[] = [];
    for (const r of written) keys.push((await writeCapture(w, r)).entityKey);
    const { entityKey: attachmentKey } = await writeAttachment(w, {
      parentCaptureKey: keys[2]!,
      urlHash: other,
      sha256: h32('ab'),
      kind: 'git',
      commitSha: '04995f68e470a18d1fc99f86fa326c2a87bab4f2',
      treeSha: '74f38d254ea1a6a87caec1016b29dc4ca296b5ff',
      proofLevel: 1,
      evidenceRef: h32('ef'),
      batchId: h32('cd'),
      size: 10n,
      contentType: 'application/gzip',
    });

    const mine = (rows: { entityKey: Hex }[]) => rows.filter((r) => keys.includes(r.entityKey));
    const all = await eventually(
      () => listAllCaptures(pub, { pageSize: 2, maxRows: 100_000 }),
      (r) => mine(r.rows).length === 3,
    );
    expect(all.truncated).toBe(false);
    const found = mine(all.rows).sort((a, b) => (a.signedAt < b.signedAt ? -1 : 1));
    expect(found.map((r) => r.urlHash)).toEqual([shared, shared, other]);
    expect(found.map((r) => r.evidenceRef)).toEqual(written.map((r) => r.evidenceRef));
    expect(found.map((r) => r.canonicalUrl)).toEqual(written.map((r) => r.canonicalUrl));
    for (const r of found) {
      expect(r.expiresAtBlock > 0n).toBe(true);
      expect(r.creator.toLowerCase()).toBe(writer.address.toLowerCase());
    }

    const capped = await listAllCaptures(pub, { pageSize: 2, maxRows: 2 });
    expect(capped.rows).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    const atts = await eventually(
      () => listAllAttachments(pub, { maxRows: 100_000 }),
      (r) => r.rows.some((a) => a.entityKey === attachmentKey),
    );
    const att = atts.rows.find((a) => a.entityKey === attachmentKey)!;
    expect(att.kind).toBe('git');
    expect(att.parentCaptureKey).toBe(keys[2]);
  });
});
