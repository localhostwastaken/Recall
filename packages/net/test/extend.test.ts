import { http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureArkivGas } from '../../../e2e/fixtures/fund';
import { NET_TEST_KEY_A, NET_TEST_KEY_B } from '../../../e2e/fixtures/keys';
import {
  LOCAL,
  MAX_LIFETIME_BLOCKS,
  arkivPublic,
  arkivWallet,
  blocksForDays,
  extendEntities,
  planExtension,
  readArkivExpiry,
  writeWitnessProfile,
} from '../src/index';

// Arkiv counts lifetimes in blocks. `extendEntity(fromDays(n))` means "expire n days from now" and
// the chain REVERTS (ExpiryNotExtended) when that is not later than the current expiry, so a
// keep-alive that adds n days on top of the current expiry needs its own target block.

describe('planExtension', () => {
  const currentBlock = 1_000n;

  it('adds the days on top of the current expiry', () => {
    const p = planExtension({ expiresAtBlock: 500_000n, currentBlock, days: 7 });
    expect(p).toEqual({ toBlock: 500_000n + blocksForDays(7), capped: false, extends: true });
    expect(blocksForDays(7)).toBe(302_400n); // 7 d at the SDK's nominal 2 s block
  });

  it('never goes past the chain maximum (about 182 days from now)', () => {
    const near = currentBlock + MAX_LIFETIME_BLOCKS - blocksForDays(3);
    const p = planExtension({ expiresAtBlock: near, currentBlock, days: 30 });
    expect(p).toEqual({ toBlock: currentBlock + MAX_LIFETIME_BLOCKS, capped: true, extends: true });
  });

  it('has nothing to do for a record that is already at the maximum', () => {
    const atMax = currentBlock + MAX_LIFETIME_BLOCKS;
    expect(planExtension({ expiresAtBlock: atMax, currentBlock, days: 7 })).toEqual({ toBlock: atMax, capped: true, extends: false });
    // Or beyond what a new maximum would be (the chain's block moved on since).
    expect(planExtension({ expiresAtBlock: atMax + 5n, currentBlock, days: 7 }).extends).toBe(false);
  });

  it('skips an extension that the maximum would shrink to under a day', () => {
    const atMax = currentBlock + MAX_LIFETIME_BLOCKS;
    const barely = planExtension({ expiresAtBlock: atMax - 100n, currentBlock, days: 7 });
    expect(barely).toEqual({ toBlock: atMax, capped: true, extends: false });
    const aDay = planExtension({ expiresAtBlock: atMax - blocksForDays(1), currentBlock, days: 7 });
    expect(aDay.extends).toBe(true);
  });

  it('is about 182 days', () => {
    expect(Number(MAX_LIFETIME_BLOCKS) * 2 / 86_400).toBeGreaterThan(182);
    expect(Number(MAX_LIFETIME_BLOCKS) * 2 / 86_400).toBeLessThan(183);
  });
});

describe('extendEntities on the local Arkiv chain', () => {
  const account = privateKeyToAccount(NET_TEST_KEY_A);
  const pub = arkivPublic(LOCAL);
  const w = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), account);

  // Accounts #10 and #11 are not prefunded: gas comes from the dev key, with a fresh nonce each time.
  beforeAll(async () => {
    await ensureArkivGas(account.address);
    await ensureArkivGas(privateKeyToAccount(NET_TEST_KEY_B).address);
  });

  async function made(): Promise<`0x${string}`> {
    const { entityKey } = await writeWitnessProfile(w, { witness: account.address, url: `https://keepalive.test/${Math.random()}` });
    for (let i = 0; i < 40; i++) {
      try {
        await pub.getEntity(entityKey);
        return entityKey;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error('entity did not show up');
  }
  const expiry = async (k: `0x${string}`) => (await readArkivExpiry(pub, [k]))[0]!.expiresAtBlock;

  it('extends several entities in one transaction, each by the days on top of its own expiry', async () => {
    const [a, b] = [await made(), await made()];
    const [a0, b0] = [await expiry(a), await expiry(b)];
    const out = await extendEntities(w, pub, [a, b], 7);
    expect(out.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await expiry(a)).toBe(a0 + blocksForDays(7));
    expect(await expiry(b)).toBe(b0 + blocksForDays(7));
    expect(out.plans.map((p) => p.entityKey)).toEqual([a, b]);
  });

  it('a second wallet can extend (permissionless) and a repeat adds again, not "7 days from now"', async () => {
    const a = await made();
    const a0 = await expiry(a);
    const other = arkivWallet(LOCAL, http(LOCAL.arkiv.rpcUrl), privateKeyToAccount(NET_TEST_KEY_B));
    await extendEntities(other, pub, [a], 7);
    await extendEntities(w, pub, [a], 7);
    expect(await expiry(a)).toBe(a0 + 2n * blocksForDays(7));
  });

  it('caps at the chain maximum, then sends nothing when already there', async () => {
    const a = await made();
    const first = await extendEntities(w, pub, [a], 400);
    expect(first.plans[0]!.capped).toBe(true);
    const timing = await pub.getBlockTiming();
    const at = await expiry(a);
    // At most the maximum counted from the block it landed in (a block or two after our read).
    expect(at - timing.currentBlock).toBeLessThanOrEqual(MAX_LIFETIME_BLOCKS);
    expect(at - timing.currentBlock).toBeGreaterThan(MAX_LIFETIME_BLOCKS - 200n);
    const again = await extendEntities(w, pub, [a], 7);
    expect(again.txHash).toBeNull();
    expect(again.plans[0]!.extends).toBe(false);
    expect(await expiry(a)).toBe(at);
  });
});
