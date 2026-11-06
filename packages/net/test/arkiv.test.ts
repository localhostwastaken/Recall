import { randomUUID } from 'node:crypto';
import { http, keccak256, stringToBytes, parseEther, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createWalletClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { DEV_PRIVATE_KEY } from '../../../e2e/fixtures/keys';
import { key, u64 } from '@arkiv-network/sdk/schema';
import {
  CaptureSchema,
  ConfirmationSchema,
  LOCAL,
  WitnessSchema,
  arkivPublic,
  arkivWallet,
  blocksForDays,
  extendEntities,
  extendEntity,
  latestWitnessUrl,
  listByUrl,
  readArkivExpiry,
  writeCapture,
  writeConfirmation,
  writeWitnessProfile,
  type CaptureRow,
} from '../src/index';

const transport = http(LOCAL.arkiv.rpcUrl);

// The node indexes a block shortly after the transaction receipt, so reads poll.
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 40 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 250));
    v = await read();
  }
  return v;
}

describe('arkiv local round-trip', () => {
  it('writeCapture then listByUrl returns the row with permissionless extension', async () => {
    const dev = privateKeyToAccount(DEV_PRIVATE_KEY);
    const witness = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());

    // fund both wallets from the prefunded dev account
    const bank = createWalletClient({ account: dev, chain: arkivPublic(LOCAL).chain, transport });
    const pub = arkivPublic(LOCAL);
    for (const to of [witness.address, other.address]) {
      const hash = await bank.sendTransaction({ to, value: parseEther('1') });
      await pub.waitForTransactionReceipt({ hash });
    }

    // the devnet keeps state between runs, so make the hashed URL unique per run
    const urlHash = keccak256(stringToBytes(`https://notice.recall.test/notice?run=${randomUUID()}`));
    const row: CaptureRow = {
      urlHash,
      bodySha256: ('0x' + 'ab'.repeat(32)) as Hex,
      serverName: 'notice.recall.test',
      witness: witness.address,
      signedAt: 1_700_000_000n,
      httpStatus: 200,
      batchId: ('0x' + 'cd'.repeat(32)) as Hex,
      evidenceRef: ('0x' + 'ef'.repeat(32)) as Hex,
      canonicalUrl: 'https://notice.recall.test/' + 'a'.repeat(150 - 'https://notice.recall.test/'.length),
    };
    expect(row.canonicalUrl.length).toBe(150);

    const w = arkivWallet(LOCAL, transport, witness);
    const { entityKey } = await writeCapture(w, row);

    const { rows } = await eventually(() => listByUrl(pub, urlHash), (r) => r.rows.length > 0);
    expect(rows.length).toBe(1);
    const first = rows[0]!;
    if (first.kind !== 'capture') throw new Error('expected a capture row');
    expect(first.entityKey).toBe(entityKey);
    expect(first.kind).toBe('capture');
    expect(first.canonicalUrl).toBe(row.canonicalUrl);
    expect(first.owner.toLowerCase()).toBe(witness.address.toLowerCase());
    expect(first.expiresAtBlock > 0n).toBe(true);

    // a different wallet can extend the entity (permissionlessExtension)
    const w2 = arkivWallet(LOCAL, transport, other);
    const tx = await extendEntity(w2, entityKey, 60);
    expect(tx).toMatch(/^0x[0-9a-f]{64}$/);
    const after = await eventually(
      () => listByUrl(pub, urlHash),
      (r) => r.rows[0]!.expiresAtBlock > first.expiresAtBlock,
    );
    expect(after.rows[0]!.expiresAtBlock > first.expiresAtBlock).toBe(true);
  });
});

describe('arkiv confirmation and witness profile', () => {
  it('round-trips a confirmation and the latest witness url', async () => {
    const dev = privateKeyToAccount(DEV_PRIVATE_KEY);
    const witness = privateKeyToAccount(generatePrivateKey());
    const pub = arkivPublic(LOCAL);
    const bank = createWalletClient({ account: dev, chain: pub.chain, transport });
    await pub.waitForTransactionReceipt({
      hash: await bank.sendTransaction({ to: witness.address, value: parseEther('1') }),
    });
    const w = arkivWallet(LOCAL, transport, witness);

    const urlHash = keccak256(stringToBytes(`https://confirm.recall.test/x?run=${randomUUID()}`));
    const evidence = new Uint8Array([1, 2, 3, 4]);
    await writeConfirmation(w, {
      captureKey: ('0x' + '11'.repeat(32)) as Hex,
      urlHash,
      bodySha256: ('0x' + '22'.repeat(32)) as Hex,
      witness: witness.address,
      signedAt: 5n,
      evidence,
    });
    const { rows } = await eventually(() => listByUrl(pub, urlHash), (r) => r.rows.length > 0);
    expect(rows).toHaveLength(1);
    const c = rows[0]!;
    if (c.kind !== 'confirmation') throw new Error('expected a confirmation row');
    expect(Array.from(c.evidence)).toEqual([1, 2, 3, 4]);

    expect(await latestWitnessUrl(pub, witness.address)).toBeNull();
    await writeWitnessProfile(w, { witness: witness.address, url: 'https://one.example' });
    await writeWitnessProfile(w, { witness: witness.address, url: 'https://two.example' });
    expect(
      await eventually(
        () => latestWitnessUrl(pub, witness.address),
        (u) => u === 'https://two.example',
      ),
    ).toBe('https://two.example');
  });
});

describe('listByUrl paging', () => {
  async function seed(captures: number, confirmations: number) {
    const dev = privateKeyToAccount(DEV_PRIVATE_KEY);
    const acct = privateKeyToAccount(generatePrivateKey());
    const pub = arkivPublic(LOCAL);
    const bank = createWalletClient({ account: dev, chain: pub.chain, transport });
    await pub.waitForTransactionReceipt({
      hash: await bank.sendTransaction({ to: acct.address, value: parseEther('1') }),
    });
    const w = arkivWallet(LOCAL, transport, acct);
    const urlHash = keccak256(stringToBytes(`https://page.recall.test/x?run=${randomUUID()}`));
    for (let i = 0; i < captures; i++) {
      await writeCapture(w, {
        urlHash,
        bodySha256: ('0x' + '01'.repeat(32)) as Hex,
        serverName: 'page.recall.test',
        witness: acct.address,
        signedAt: BigInt(i),
        httpStatus: 200,
        batchId: ('0x' + '02'.repeat(32)) as Hex,
        evidenceRef: ('0x' + '03'.repeat(32)) as Hex,
        canonicalUrl: 'https://page.recall.test/x',
      });
    }
    for (let i = 0; i < confirmations; i++) {
      await writeConfirmation(w, {
        captureKey: ('0x' + '04'.repeat(32)) as Hex,
        urlHash,
        bodySha256: ('0x' + '01'.repeat(32)) as Hex,
        witness: acct.address,
        signedAt: BigInt(i),
        evidence: new Uint8Array([i]),
      });
    }
    const total = captures + confirmations;
    await eventually(
      () => listByUrl(pub, urlHash),
      (r) => r.rows.length >= total,
    );
    return { pub, urlHash };
  }

  it('listByUrl paginates beyond one page', async () => {
    const { pub, urlHash } = await seed(3, 2);
    const { rows, truncated } = await listByUrl(pub, urlHash, { pageSize: 2 });
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.entityKey)).size).toBe(5);
    expect(truncated).toBe(false);
  });

  it('listByUrl stops at maxRows', async () => {
    const { pub, urlHash } = await seed(3, 0);
    const { rows, truncated } = await listByUrl(pub, urlHash, { pageSize: 2, maxRows: 2 });
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('separate budgets: confirmations are returned even when captures hit the cap', async () => {
    const { pub, urlHash } = await seed(3, 2);
    const { rows, truncated } = await listByUrl(pub, urlHash, { pageSize: 2, maxRows: 2 });
    expect(rows.filter((r) => r.kind === 'capture')).toHaveLength(2);
    expect(rows.filter((r) => r.kind === 'confirmation')).toHaveLength(2);
    expect(truncated).toBe(true);
  });

  it('no spurious truncation at exact cap', async () => {
    const { pub, urlHash } = await seed(2, 0);
    const { rows, truncated } = await listByUrl(pub, urlHash, { pageSize: 2, maxRows: 2 });
    expect(rows).toHaveLength(2);
    expect(truncated).toBe(false);
  });
});

describe('records are read-only, and witness discovery trusts only the creator (R41)', () => {
  const pub = arkivPublic(LOCAL);

  async function funded(): Promise<ReturnType<typeof privateKeyToAccount>> {
    const acct = privateKeyToAccount(generatePrivateKey());
    const bank = createWalletClient({ account: privateKeyToAccount(DEV_PRIVATE_KEY), chain: pub.chain, transport });
    await pub.waitForTransactionReceipt({ hash: await bank.sendTransaction({ to: acct.address, value: parseEther('1') }) });
    return acct;
  }

  async function shown(entityKey: Hex): Promise<void> {
    for (let i = 0; i < 40; i++) {
      try {
        await pub.getEntity(entityKey);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error('entity did not show up');
  }

  it('the owner cannot patch a capture, a confirmation or a witness profile; a stranger can still extend them', async () => {
    const owner = await funded();
    const stranger = await funded();
    const w = arkivWallet(LOCAL, transport, owner);
    const urlHash = keccak256(stringToBytes(`https://readonly.recall.test/x?run=${randomUUID()}`));
    const capture = await writeCapture(w, {
      urlHash,
      bodySha256: ('0x' + 'ab'.repeat(32)) as Hex,
      serverName: 'readonly.recall.test',
      witness: owner.address,
      signedAt: 1n,
      httpStatus: 200,
      batchId: ('0x' + 'cd'.repeat(32)) as Hex,
      evidenceRef: ('0x' + 'ef'.repeat(32)) as Hex,
      canonicalUrl: 'https://readonly.recall.test/x',
    });
    const confirmation = await writeConfirmation(w, {
      captureKey: capture.entityKey,
      urlHash,
      bodySha256: ('0x' + 'ab'.repeat(32)) as Hex,
      witness: owner.address,
      signedAt: 2n,
      evidence: new Uint8Array([1]),
    });
    const profile = await writeWitnessProfile(w, { witness: owner.address, url: 'https://honest.example' });
    for (const k of [capture.entityKey, confirmation.entityKey, profile.entityKey]) await shown(k);

    await expect(
      w.patchEntity(CaptureSchema, capture.entityKey, { set: { bodySha256: key(('0x' + '00'.repeat(32)) as Hex) } }),
    ).rejects.toThrow();
    await expect(w.patchEntity(ConfirmationSchema, confirmation.entityKey, { set: { signedAt: u64(9n) } })).rejects.toThrow();
    await expect(w.patchEntity(WitnessSchema, profile.entityKey, { set: { url: 'https://evil.example' } })).rejects.toThrow();

    const keys = [capture.entityKey, confirmation.entityKey, profile.entityKey];
    const before = await readArkivExpiry(pub, keys);
    const out = await extendEntities(arkivWallet(LOCAL, transport, stranger), pub, keys, 7);
    expect(out.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const after = await readArkivExpiry(pub, keys);
    after.forEach((a, i) => expect(a.expiresAtBlock).toBe(before[i]!.expiresAtBlock + blocksForDays(7)));
    expect((await pub.getEntity(profile.entityKey, WitnessSchema)).url.value).toBe('https://honest.example');
  });

  it('a profile created by someone else and then handed to the witness is ignored', async () => {
    const witness = await funded();
    const attacker = await funded();
    await writeWitnessProfile(arkivWallet(LOCAL, transport, witness), { witness: witness.address, url: 'https://honest.example' });
    expect(
      await eventually(() => latestWitnessUrl(pub, witness.address), (u) => u === 'https://honest.example'),
    ).toBe('https://honest.example');

    // Newer than the honest profile, names the witness, and is then owned by the witness.
    const aw = arkivWallet(LOCAL, transport, attacker);
    const evil = await writeWitnessProfile(aw, { witness: witness.address, url: 'https://evil.example' });
    await shown(evil.entityKey);
    await aw.changeOwnership({ entityKey: evil.entityKey, newOwner: witness.address });
    const owned = await eventually(
      () => pub.getEntity(evil.entityKey),
      (e) => e.$owner.toLowerCase() === witness.address.toLowerCase(),
    );
    expect(owned.$owner.toLowerCase()).toBe(witness.address.toLowerCase());

    expect(await latestWitnessUrl(pub, witness.address)).toBe('https://honest.example');
  });
});
