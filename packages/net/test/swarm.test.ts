import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, createWalletClient, erc20Abi, http, parseAbi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { beforeAll, describe, expect, it } from 'vitest';
import { BEE_COMPOSE_FAUCET_KEY } from '../../../e2e/fixtures/keys';
import {
  LOCAL, POSTAGE_STAMP, XBZZ, Stamper, batchTtlSeconds, buyBatch, costFor, downloadBytes, topUp, uploadStamped, waitBatchUsable,
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

  it('costFor matches an independent lastPrice read', async () => {
    const lastPrice = await pub.readContract({
      address: POSTAGE_STAMP, abi: parseAbi(['function lastPrice() view returns (uint64)']), functionName: 'lastPrice',
    });
    expect(await costFor(pub, 17, 1)).toBe((BigInt(lastPrice) * 17280n + 1n) * 131072n);
  });

  it('buyBatch spends about one day of depth-17 storage', async () => {
    const bal = () =>
      pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [payer.account!.address] });
    const expected = await costFor(pub, 17, 1);
    const before = await bal();
    await buyBatch(payer, { owner: privateKeyToAccount(generatePrivateKey()).address, depth: 17, days: 1 });
    const spent = before - (await bal());
    expect(spent).toBe(expected);
    expect(spent < 10n ** 15n).toBe(true);
  }, 60_000);

  it('downloadBytes rejects a gateway that returns different bytes', async () => {
    const up = new Uint8Array(randomBytes(9000));
    const stamper = Stamper.fromBlank(stampKey, batchId, 17);
    const ref = await uploadStamped(up, { uploadUrl: LOCAL.swarm.uploadUrl, stamper });
    const server = createServer((_req, res) => res.end(Buffer.from('not the data you asked for')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const fake = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(downloadBytes(ref, [fake])).rejects.toThrow(/mismatch/);
      const ok = await downloadBytes(ref, [fake, LOCAL.swarm.downloadUrls[0]]);
      expect(ok.from).toBe(LOCAL.swarm.downloadUrls[0]);
      expect(Buffer.from(ok.bytes).equals(Buffer.from(up))).toBe(true);
      await expect(downloadBytes('0x1234', [fake])).rejects.toThrow(/invalid/);
    } finally {
      server.close();
    }
  }, 120_000);
});
