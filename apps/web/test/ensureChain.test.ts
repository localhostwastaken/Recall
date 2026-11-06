import { describe, expect, it, vi } from 'vitest';

// wallet.ts reads window.ethereum when it loads; give it a window first.
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {};
});
import { ensureChain, isUnknownChain } from '../src/wallet';

type Call = { method: string; params?: unknown };

function fakeWallet(known: Set<number>, start: number) {
  let chain = start;
  const calls: Call[] = [];
  const request = vi.fn(async ({ method, params }: Call) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x' + chain.toString(16);
    if (method === 'wallet_switchEthereumChain') {
      const id = Number((params as [{ chainId: string }])[0].chainId);
      if (!known.has(id)) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
      chain = id;
      return null;
    }
    if (method === 'wallet_addEthereumChain') {
      known.add(Number((params as [{ chainId: string }])[0].chainId));
      return null;
    }
    return null;
  });
  (globalThis as unknown as { window: unknown }).window = {
    ethereum: { request, on: () => undefined },
    location: new URL('https://localhostwastaken.github.io/Recall/app/'),
  };
  return { calls, chain: () => chain };
}

describe('ensureChain', () => {
  it('switches without adding when the wallet already knows the chain (no "Update network" prompt)', async () => {
    const w = fakeWallet(new Set([100, 7794095]), 100);
    await ensureChain(7794095);
    expect(w.calls.map((c) => c.method)).not.toContain('wallet_addEthereumChain');
    expect(w.chain()).toBe(7794095);
  });

  it('adds, then switches, only when the wallet answers 4902', async () => {
    const w = fakeWallet(new Set([100]), 100);
    await ensureChain(7794095);
    expect(w.calls.map((c) => c.method)).toContain('wallet_addEthereumChain');
    expect(w.chain()).toBe(7794095);
  });

  it('does nothing when already on the chain', async () => {
    const w = fakeWallet(new Set([100]), 100);
    await ensureChain(100);
    expect(w.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('recognises nested 4902 errors and nothing else', () => {
    expect(isUnknownChain({ code: 4902 })).toBe(true);
    expect(isUnknownChain({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true);
    expect(isUnknownChain({ code: 4001 })).toBe(false);
  });
});
