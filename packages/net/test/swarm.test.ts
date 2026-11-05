import { randomBytes } from 'node:crypto';
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { beforeAll, describe, expect, it } from 'vitest';
import { BEE_COMPOSE_FAUCET_KEY } from '../../../e2e/fixtures/keys';
import {
  LOCAL, Stamper, batchTtlSeconds, buyBatch, costFor, downloadBytes, topUp, uploadStamped, waitBatchUsable,
} from '../src/index';


const transport = http(LOCAL.gnosis.rpcUrl);
const pub = createPublicClient({ chain: gnosis, transport });
const payer = createWalletClient({ account: privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY), chain: gnosis, transport });

const stampKey = generatePrivateKey();
let batchId: Hex;

describe('local swarm postage', () => {
  beforeAll(async () => {
    const owner = privateKeyToAccount(stampKey).address;
    ({ batchId } = await buyBatch(payer, { owner, depth: 17, days: 1 }));
    await waitBatchUsable(LOCAL.swarm.uploadUrl, batchId, 120_000);
  }, 180_000);

  it('stamped upload on node A downloads byte-identical from node B', async () => {
    const up = new Uint8Array(randomBytes(70_000));
    const stamper = Stamper.fromBlank(stampKey, batchId, 17);
    const ref = await uploadStamped(up, { uploadUrl: LOCAL.swarm.uploadUrl, stamper });
    const down = await downloadBytes(ref, LOCAL.swarm.downloadUrls);
    expect(down.from).toBe(LOCAL.swarm.downloadUrls[0]);
    expect(Buffer.from(down.bytes).equals(Buffer.from(up))).toBe(true);
  }, 120_000);

  it('stamp signed by non-owner key is rejected', async () => {
    const stamper = Stamper.fromBlank(generatePrivateKey(), batchId, 17);
    await expect(
      uploadStamped(new Uint8Array(randomBytes(5000)), { uploadUrl: LOCAL.swarm.uploadUrl, stamper }),
    ).rejects.toThrow();
  }, 60_000);

  it('topUp increases TTL', async () => {
    const before = await batchTtlSeconds(pub, batchId);
    expect(before).not.toBeNull();
    await topUp(payer, batchId, 0.5);
    const after = await batchTtlSeconds(pub, batchId);
    expect(after! > before!).toBe(true);
  }, 60_000);

  it('costFor scales with depth', async () => {
    expect(await costFor(pub, 18, 1)).toBe((await costFor(pub, 17, 1)) * 2n);
  });
});
