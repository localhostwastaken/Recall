import type { Page } from '@playwright/test';
import { createWalletClient, defineChain, http, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { normalizeKey } from '../../packages/net/src/config';

/**
 * A stand-in for MetaMask, the only simulated actor in the e2e suite. The page gets a
 * real EIP-1193 `window.ethereum` (also announced through EIP-6963); every request is
 * forwarded to Node, where a viem local account with a real key signs and sends.
 *
 * - `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`,
 *   `wallet_addEthereumChain`, `eth_sendTransaction`, `personal_sign` and
 *   `eth_signTypedData_v4` are handled by the account.
 * - Every other call is proxied to the RPC of the wallet's current chain.
 * - Like MetaMask, `eth_accounts` stays empty until `eth_requestAccounts` ran, and the
 *   wallet emits `accountsChanged` and `chainChanged`.
 * - Setting `window.__rejectNext = true` makes the next request that would open a
 *   MetaMask prompt (connect, add/switch chain, send, sign) fail with `{code: 4001}`.
 *   Reads never open a prompt, so they never consume the flag. To aim at one prompt, set
 *   a method name (`'eth_sendTransaction'`) or `{ method?, skip? }`: only that method
 *   counts, and the first `skip` matching requests go through before one is rejected.
 */
export type MockWalletOptions = {
  /** With or without the 0x prefix. */
  privateKey: string;
  rpcByChainId: Record<number, string>;
  /** Chain the wallet starts on; defaults to the first entry of `rpcByChainId`. */
  chainId?: number;
  /** Called with each transaction the wallet has sent (its chain, hash and recipient), before any receipt. */
  onSent?: (chainId: number, hash: Hex, to: Address | undefined) => void;
};

export type MockWallet = { address: Address; chainId(): number };

type RpcError = { code: number; message: string };
type Reply = { result?: unknown; error?: RpcError; events?: [string, unknown][] };

class WalletRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs in every page before its own scripts. Kept as plain JavaScript in a string so no
 * loader (tsx, babel, esbuild) can inject helpers that do not exist in the page.
 */
const PAGE_SCRIPT = `(() => {
  const listeners = new Map();
  const emit = (event, data) => {
    for (const fn of [...(listeners.get(event) || [])]) {
      try {
        fn(data);
      } catch (e) {
        /* a listener's error must not break the wallet */
      }
    }
  };
  // Requests that would open a MetaMask prompt.
  const PROMPTS = new Set([
    'eth_requestAccounts',
    'wallet_addEthereumChain',
    'wallet_switchEthereumChain',
    'eth_sendTransaction',
    'personal_sign',
    'eth_signTypedData_v4',
  ]);
  const provider = {
    isMetaMask: true,
    isMockWallet: true,
    async request(args) {
      const method = args.method;
      const params = Array.isArray(args.params) ? args.params : args.params === undefined ? [] : [args.params];
      const flag = window.__rejectNext;
      if (flag) {
        const f = flag === true ? {} : typeof flag === 'string' ? { method: flag } : flag;
        if (f.method ? f.method === method : PROMPTS.has(method)) {
          if (f.skip > 0) {
            window.__rejectNext = { method: f.method, skip: f.skip - 1 };
          } else {
            window.__rejectNext = false;
            throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          }
        }
      }
      const reply = await window.__mockWalletRequest(method, params);
      if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
      for (const [event, data] of reply.events || []) setTimeout(() => emit(event, data), 0);
      return reply.result;
    },
    on(event, fn) {
      listeners.set(event, [...(listeners.get(event) || []), fn]);
      return provider;
    },
    removeListener(event, fn) {
      listeners.set(event, (listeners.get(event) || []).filter((l) => l !== fn));
      return provider;
    },
  };
  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true });

  // EIP-6963: announce now and whenever a dapp asks.
  const detail = Object.freeze({
    info: Object.freeze({
      uuid: '7c1a3c5e-6f0e-4a56-9d0b-3b6b0f8d2a11',
      name: 'Mock Wallet',
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIvPg==',
      rdns: 'test.recall.mockwallet',
    }),
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

export async function installMockWallet(page: Page, opts: MockWalletOptions): Promise<MockWallet> {
  const account = privateKeyToAccount(normalizeKey(opts.privateKey));
  const rpc: Record<number, string> = { ...opts.rpcByChainId };
  let chainId = opts.chainId ?? Number(Object.keys(rpc)[0]);
  if (!rpc[chainId]) throw new Error(`mock wallet: no RPC for chain ${chainId}`);
  let connected = false;
  let sending: Promise<unknown> = Promise.resolve();

  const proxy = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(rpc[chainId], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: RpcError };
    if (json.error) throw new WalletRpcError(json.error.code, json.error.message);
    return json.result;
  };

  const client = () =>
    createWalletClient({
      account,
      chain: defineChain({
        id: chainId,
        name: `mock-${chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpc[chainId]] } },
      }),
      transport: http(rpc[chainId]),
    });

  const sameAccount = (from: unknown) => {
    if (typeof from === 'string' && from.toLowerCase() !== account.address.toLowerCase()) {
      throw new WalletRpcError(4100, 'The requested account has not been authorized by the user.');
    }
  };

  const handle = async (method: string, params: unknown[]): Promise<Reply> => {
    switch (method) {
      case 'eth_requestAccounts': {
        const first = !connected;
        connected = true;
        return { result: [account.address], events: first ? [['accountsChanged', [account.address]]] : [] };
      }
      case 'eth_accounts':
        return { result: connected ? [account.address] : [] };
      case 'eth_chainId':
        return { result: toHex(chainId) };
      case 'net_version':
        return { result: String(chainId) };
      case 'wallet_addEthereumChain': {
        const p = params[0] as { chainId: Hex; rpcUrls?: string[] };
        const id = Number(p.chainId);
        if (!rpc[id] && p.rpcUrls?.[0]) rpc[id] = p.rpcUrls[0];
        return { result: null };
      }
      case 'wallet_switchEthereumChain': {
        const id = Number((params[0] as { chainId: Hex }).chainId);
        if (!rpc[id]) throw new WalletRpcError(4902, `Unrecognized chain ID ${id}. Try adding the chain first.`);
        const changed = id !== chainId;
        chainId = id;
        return { result: null, events: changed ? [['chainChanged', toHex(id)]] : [] };
      }
      case 'eth_sendTransaction': {
        const tx = params[0] as { from?: string; to?: Address; data?: Hex; value?: Hex; gas?: Hex };
        sameAccount(tx.from);
        // One at a time, so viem's nonce lookup never races an earlier send.
        const run = sending.then(() =>
          client().sendTransaction({
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            gas: tx.gas ? BigInt(tx.gas) : undefined,
          }),
        );
        sending = run.catch(() => undefined);
        const sentOn = chainId;
        const hash = await run;
        opts.onSent?.(sentOn, hash, tx.to);
        return { result: hash };
      }
      case 'personal_sign': {
        const [message, from] = params as [string, string];
        sameAccount(from);
        const signature = /^0x([0-9a-fA-F]{2})*$/.test(message)
          ? await account.signMessage({ message: { raw: message as Hex } })
          : await account.signMessage({ message });
        return { result: signature };
      }
      case 'eth_signTypedData_v4': {
        const [from, data] = params as [string, string | object];
        sameAccount(from);
        const td = (typeof data === 'string' ? JSON.parse(data) : data) as {
          domain: Record<string, unknown>;
          types: Record<string, { name: string; type: string }[]>;
          primaryType: string;
          message: Record<string, unknown>;
        };
        const { EIP712Domain: _domain, ...types } = td.types;
        const signature = await account.signTypedData({
          domain: td.domain,
          types,
          primaryType: td.primaryType,
          message: td.message,
        });
        return { result: signature };
      }
      default:
        return { result: await proxy(method, params) };
    }
  };

  await page.exposeFunction('__mockWalletRequest', async (method: string, params: unknown[]): Promise<Reply> => {
    try {
      return await handle(method, params ?? []);
    } catch (err) {
      const e = err as { code?: unknown; shortMessage?: string; message?: string };
      return {
        error: {
          code: typeof e.code === 'number' ? e.code : -32603,
          message: e.shortMessage ?? e.message ?? 'mock wallet error',
        },
      };
    }
  });

  await page.addInitScript({ content: PAGE_SCRIPT });

  return { address: account.address, chainId: () => chainId };
}
