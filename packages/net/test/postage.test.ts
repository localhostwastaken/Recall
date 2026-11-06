import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  parseAbi,
  parseUnits,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { afterEach, describe, expect, it } from 'vitest';
import { fundWallet } from '../../../e2e/fixtures/fund';
import { OTHER_WALLET_KEY } from '../../../e2e/fixtures/keys';
import { BatchNotFoundError, LOCAL, POSTAGE_STAMP, XBZZ, batchTtlSeconds, buyBatch, isContractRevert, readBatch, topUp, topUpCost } from '../src/index';

// batchTtlSeconds against a throwaway JSON-RPC server (no devnet needed): only a contract
// revert may mean "expired"; a rate limit, a timeout or a node fault must be an error, so a
// caller can tell a dead batch from a node that did not answer.

const BATCH: Hex = `0x${'ab'.repeat(32)}`;
const OWNER: Address = '0x1111111111111111111111111111111111111111';
const SEL = {
  batchOwner: toFunctionSelector('batchOwner(bytes32)'),
  remainingBalance: toFunctionSelector('remainingBalance(bytes32)'),
  lastPrice: toFunctionSelector('lastPrice()'),
};

type Reply =
  | { kind: 'result'; value: Hex }
  | { kind: 'rpc-error'; code: number; message: string; data?: unknown }
  | { kind: 'http'; status: number; body?: string }
  | { kind: 'hang' };

const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
const ok = (n: bigint): Reply => ({ kind: 'result', value: word(n) });
// What a Gnosis node returns for `require(false, "batch does not exist or expired")`.
const REVERT_DATA: Hex = `0x08c379a0${encodeAbiParameters([{ type: 'string' }], ['batch does not exist or expired']).slice(2)}`;

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

type Script = { owner?: Address; ownerReply?: Reply; remaining: Reply; price?: bigint; calls?: string[] };

async function clientFor(script: Script): Promise<PublicClient> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const rpc = JSON.parse(raw) as { id: number; method: string; params: [{ data: Hex }] };
      const selector = rpc.params?.[0]?.data?.slice(0, 10);
      const name = (Object.keys(SEL) as (keyof typeof SEL)[]).find((k) => SEL[k] === selector);
      script.calls?.push(name ?? rpc.method);
      const reply: Reply =
        name === 'batchOwner'
          ? (script.ownerReply ?? { kind: 'result', value: encodeAbiParameters([{ type: 'address' }], [script.owner ?? OWNER]) })
          : name === 'lastPrice'
            ? ok(script.price ?? 24000n)
            : name === 'remainingBalance'
              ? script.remaining
              : { kind: 'rpc-error', code: -32601, message: `unexpected ${rpc.method}` };
      if (reply.kind === 'hang') return; // never answers
      if (reply.kind === 'http') {
        res.writeHead(reply.status, { 'content-type': 'text/plain' }).end(reply.body ?? 'Too Many Requests');
        return;
      }
      const body =
        reply.kind === 'result'
          ? { jsonrpc: '2.0', id: rpc.id, result: reply.value }
          : { jsonrpc: '2.0', id: rpc.id, error: { code: reply.code, message: reply.message, data: reply.data } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // No retries and a short timeout, so a rate limit or a silent node fails at once.
  return createPublicClient({ chain: gnosis, transport: http(url, { retryCount: 0, timeout: 400 }) }) as PublicClient;
}

describe('batchTtlSeconds', () => {
  it('is remaining balance / price blocks at 5 s each', async () => {
    const pub = await clientFor({ remaining: ok(24000n * 17280n * 3n), price: 24000n });
    expect(await batchTtlSeconds(pub, BATCH)).toBe(17280n * 3n * 5n);
  });

  it('an unknown batch (zero owner) is null and the balance is never read', async () => {
    const calls: string[] = [];
    const pub = await clientFor({ owner: zeroAddress, remaining: ok(1n), calls });
    expect(await batchTtlSeconds(pub, BATCH)).toBeNull();
    expect(calls).not.toContain('remainingBalance');
  });

  it('an exhausted balance is null', async () => {
    const pub = await clientFor({ remaining: ok(0n) });
    expect(await batchTtlSeconds(pub, BATCH)).toBeNull();
  });

  it('a contract revert means expired: null', async () => {
    const pub = await clientFor({
      remaining: { kind: 'rpc-error', code: 3, message: 'execution reverted: batch does not exist or expired', data: REVERT_DATA },
    });
    expect(await batchTtlSeconds(pub, BATCH)).toBeNull();
  });

  it('a custom-error revert (4 bytes of data, no reason) means expired: null', async () => {
    const pub = await clientFor({
      remaining: { kind: 'rpc-error', code: 3, message: 'execution reverted', data: '0x4ee9bc0f' },
    });
    expect(await batchTtlSeconds(pub, BATCH)).toBeNull();
  });

  it('a node that says "execution reverted" without data is still a revert', async () => {
    const pub = await clientFor({ remaining: { kind: 'rpc-error', code: -32603, message: 'execution reverted' } });
    expect(await batchTtlSeconds(pub, BATCH)).toBeNull();
  });

  it('an HTTP 429 is an error, never "expired"', async () => {
    const pub = await clientFor({ remaining: { kind: 'http', status: 429 } });
    await expect(batchTtlSeconds(pub, BATCH)).rejects.toThrow();
  });

  it('a timeout is an error, never "expired"', async () => {
    const pub = await clientFor({ remaining: { kind: 'hang' } });
    await expect(batchTtlSeconds(pub, BATCH)).rejects.toThrow(/time/i);
  });

  it('a -32603 internal error with plain-string data is an error, never "expired"', async () => {
    const pub = await clientFor({
      remaining: { kind: 'rpc-error', code: -32603, message: 'Internal error', data: 'upstream connect error or disconnect/reset before headers' },
    });
    await expect(batchTtlSeconds(pub, BATCH)).rejects.toThrow();
  });

  it('a -32603 internal error with no data is an error, never "expired"', async () => {
    const pub = await clientFor({ remaining: { kind: 'rpc-error', code: -32603, message: 'Internal error' } });
    await expect(batchTtlSeconds(pub, BATCH)).rejects.toThrow();
  });

  it('a rate limit on the owner read is an error too', async () => {
    const pub = await clientFor({ ownerReply: { kind: 'http', status: 429 }, remaining: ok(1n) });
    await expect(batchTtlSeconds(pub, BATCH)).rejects.toThrow();
  });
});

describe('isContractRevert', () => {
  const abi = parseAbi(['function remainingBalance(bytes32) view returns (uint256)']);
  const call = async (reply: Reply) => {
    const pub = await clientFor({ remaining: reply });
    return pub
      .readContract({ address: POSTAGE_STAMP, abi, functionName: 'remainingBalance', args: [BATCH] })
      .then(() => null, (e: unknown) => e);
  };

  it('is true for revert data and false for transport and node trouble', async () => {
    expect(isContractRevert(await call({ kind: 'rpc-error', code: 3, message: 'execution reverted', data: REVERT_DATA }))).toBe(true);
    expect(isContractRevert(await call({ kind: 'rpc-error', code: 3, message: 'execution reverted', data: '0x4ee9bc0f' }))).toBe(true);
    expect(isContractRevert(await call({ kind: 'rpc-error', code: -32603, message: 'Internal error', data: 'boom' }))).toBe(false);
    expect(isContractRevert(await call({ kind: 'rpc-error', code: -32603, message: 'Internal error', data: '0x12' }))).toBe(false);
    expect(isContractRevert(await call({ kind: 'http', status: 429 }))).toBe(false);
    expect(isContractRevert(await call({ kind: 'hang' }))).toBe(false);
    expect(isContractRevert(new Error('revert'))).toBe(false);
    expect(isContractRevert(undefined)).toBe(false);
  });
});

describe('batchTtlSeconds on the local Gnosis fork', () => {
  it('a real contract revert is recognised, and an unknown batch reads as expired', async () => {
    const pub = createPublicClient({ chain: gnosis, transport: http('http://localhost:9545', { retryCount: 0 }) }) as PublicClient;
    const unknown: Hex = `0x${'7e'.repeat(32)}`;
    const err = await pub
      .readContract({
        address: POSTAGE_STAMP,
        abi: parseAbi(['function remainingBalance(bytes32) view returns (uint256)']),
        functionName: 'remainingBalance',
        args: [unknown],
      })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isContractRevert(err)).toBe(true);
    expect(await batchTtlSeconds(pub, unknown)).toBeNull();
  });
});

describe('topUp on the local Gnosis fork', () => {
  const account = privateKeyToAccount(OTHER_WALLET_KEY);
  const chain = { ...gnosis, rpcUrls: { default: { http: [LOCAL.gnosis.rpcUrl] } } };
  const pub = createPublicClient({ chain, transport: http(LOCAL.gnosis.rpcUrl) }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport: http(LOCAL.gnosis.rpcUrl) });
  const nonce = () => pub.getTransactionCount({ address: account.address });

  it('prices the top-up by the batch depth, and approves only when the allowance is short', async () => {
    await fundWallet(account.address, parseUnits('1', 16));
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const { batchId } = await buyBatch(wallet, { owner, depth: 17, days: 1 });

    // The batch is read from the contract: its owner, its depth.
    const info = await readBatch(pub, batchId);
    expect(info).toMatchObject({ owner, depth: 17, bucketDepth: 16, immutable: true });

    const cost = await topUpCost(pub, batchId, 1);
    expect(cost.depth).toBe(17);
    expect(cost.total).toBe(cost.perChunk * 2n ** 17n);

    // buyBatch spent its whole approval, so this top-up has to approve first: two transactions.
    const t0 = (await batchTtlSeconds(pub, batchId))!;
    const n0 = await nonce();
    const approvals: Hex[] = [];
    await topUp(wallet, batchId, 1, { onApproved: (h) => approvals.push(h) });
    expect(await nonce()).toBe(n0 + 2);
    expect(approvals).toHaveLength(1);
    const t1 = (await batchTtlSeconds(pub, batchId))!;
    expect(t1 - t0).toBeGreaterThan(86_000n);

    // With enough allowance already in place, only the top-up itself is sent.
    const big = parseUnits('0.5', 16);
    await pub.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: XBZZ, abi: erc20Abi, functionName: 'approve', args: [POSTAGE_STAMP, big] }),
    });
    const n1 = await nonce();
    await topUp(wallet, batchId, 1, { onApproved: (h) => approvals.push(h) });
    expect(await nonce()).toBe(n1 + 1);
    expect(approvals).toHaveLength(1);
    const t2 = (await batchTtlSeconds(pub, batchId))!;
    expect(t2 - t1).toBeGreaterThan(86_000n);
  });
});

describe('readBatch and topUpCost for a batch id that names nothing', () => {
  const pub = createPublicClient({ chain: gnosis, transport: http(LOCAL.gnosis.rpcUrl, { retryCount: 0 }) }) as PublicClient;
  const unknown: Hex = `0x${'5a'.repeat(32)}`;

  it('readBatch is null and topUpCost refuses to price it', async () => {
    expect(await readBatch(pub, unknown)).toBeNull();
    await expect(topUpCost(pub, unknown, 7)).rejects.toBeInstanceOf(BatchNotFoundError);
  });

  it('an RPC error is thrown, never read as "no such batch"', async () => {
    // This server only knows the three calls batchTtlSeconds makes, so `batches` gets a JSON-RPC error.
    const odd = await clientFor({ remaining: ok(1n) });
    await expect(readBatch(odd, unknown)).rejects.toThrow();
  });
});
