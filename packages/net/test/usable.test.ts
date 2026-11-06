import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  parseAbi,
  toHex,
  type Hex,
  type PublicClient,
} from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { waitBatchUsable } from '../src/index';

// waitBatchUsable against throwaway servers (no devnet needed). A local Bee shares its chain
// view (/chainstate + /batches as {batches:[...]}); the public gateway answers /chainstate with
// 404 and /batches with a bare 1.8 MB array, so there the chain decides: the batch is usable 12
// Gnosis blocks after the block the postage contract recorded for it.

const BATCH: Hex = `0x${'cd'.repeat(32)}`;
const OWNER = '0x1111111111111111111111111111111111111111';
const abi = parseAbi([
  'function batches(bytes32) view returns (address owner, uint8 depth, uint8 bucketDepth, bool immutableFlag, uint256 normalisedBalance, uint256 lastUpdatedBlockNumber)',
]);

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

type Route = { status: number; body?: unknown };
/** A stand-in Bee node. `routes` may change between polls; every request path is recorded. */
async function bee(routes: Record<string, () => Route>): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    const r = routes[path]?.() ?? { status: 404, body: 'Not Found' };
    res.writeHead(r.status, { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

/** A Gnosis client whose head block is `head()` and whose postage contract recorded `start` for BATCH. */
function gnosis(head: () => bigint, start: bigint | null): PublicClient {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === 'eth_chainId') return toHex(100);
        if (method === 'eth_blockNumber') return toHex(head());
        if (method === 'eth_call') {
          const { data } = (params as [{ data: Hex }])[0];
          const { args } = decodeFunctionData({ abi, data });
          const known = start !== null && (args[0] as Hex).toLowerCase() === BATCH;
          return encodeAbiParameters(
            [
              { type: 'address' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' },
            ],
            known ? [OWNER, 17, 16, true, 1000n, start] : ['0x0000000000000000000000000000000000000000', 0, 0, false, 0n, 0n],
          );
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  }) as PublicClient;
}

const fast = { pollMs: 20 };

describe('waitBatchUsable', () => {
  it('a local Bee: resolves once /chainstate is 12 blocks past the start /batches lists', async () => {
    let block = 100;
    const node = await bee({
      '/chainstate': () => ({ status: 200, body: { block: block++ } }),
      '/batches': () => ({ status: 200, body: { batches: [{ batchID: BATCH.slice(2), start: 95 }] } }),
    });
    await waitBatchUsable(node.url, BATCH, 5_000, fast);
    expect(block).toBeGreaterThanOrEqual(108); // the poll that saw 107 = 95 + 12 resolved
  });

  it('accepts /batches as a bare array (the public gateway shape)', async () => {
    const node = await bee({
      '/chainstate': () => ({ status: 200, body: { block: 200 } }),
      '/batches': () => ({ status: 200, body: [{ batchID: `0x${BATCH.slice(2).toUpperCase()}`, start: 150 }] }),
    });
    await expect(waitBatchUsable(node.url, BATCH, 2_000, fast)).resolves.toBeUndefined();
  });

  it('/chainstate 404: the chain decides, and the big /batches list is never downloaded', async () => {
    let head = 1_000n;
    const node = await bee({ '/batches': () => ({ status: 200, body: [] }) });
    const chain = gnosis(() => head++, 1_000n);
    await waitBatchUsable(node.url, BATCH, 5_000, { ...fast, chain });
    expect(head).toBeGreaterThanOrEqual(1_013n); // resolved on the read that returned 1012
    expect(node.hits.filter((p) => p === '/batches')).toEqual([]);
    expect(node.hits.filter((p) => p === '/chainstate').length).toBeGreaterThan(0);
  });

  it('/chainstate 404: a batch fewer than 12 blocks old is not usable yet (times out)', async () => {
    const node = await bee({});
    const chain = gnosis(() => 1_011n, 1_000n);
    await expect(waitBatchUsable(node.url, BATCH, 300, { ...fast, chain })).rejects.toThrow(/not usable/);
  });

  it('/chainstate 404: a batch the contract does not know is never usable', async () => {
    const node = await bee({});
    const chain = gnosis(() => 5_000n, null);
    await expect(waitBatchUsable(node.url, BATCH, 300, { ...fast, chain })).rejects.toThrow(/not usable/);
  });

  it('/chainstate 404 and no chain to ask: times out as before, still without /batches', async () => {
    const node = await bee({ '/batches': () => ({ status: 200, body: [] }) });
    await expect(waitBatchUsable(node.url, BATCH, 200, fast)).rejects.toThrow(/not usable/);
    expect(node.hits).not.toContain('/batches');
  });

  it('an RPC error on the chain path is retried, not fatal', async () => {
    let calls = 0;
    const node = await bee({});
    const flaky = gnosis(() => {
      if (calls++ < 2) throw new Error('429 Too Many Requests');
      return 2_000n;
    }, 1_000n);
    await expect(waitBatchUsable(node.url, BATCH, 5_000, { ...fast, chain: flaky })).resolves.toBeUndefined();
  });
});
