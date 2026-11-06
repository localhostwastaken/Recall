import { localhost, rabdi } from '@arkiv-network/sdk/chains';
import { useSyncExternalStore } from 'react';
import { createWalletClient, custom, hexToNumber, numberToHex, type Address, type Chain, type WalletClient } from 'viem';
import { gnosis } from 'viem/chains';
import { getNetConfig } from './net';

/** Arkiv local devnet, Arkiv Rabdi testnet, Gnosis (also the local Gnosis fork). */
export type ChainId = 1337 | 7794095 | 100;

export const CHAIN_NAMES: Record<ChainId, string> = {
  1337: 'Arkiv local',
  7794095: 'Arkiv Rabdi',
  100: 'Gnosis',
};

/** Minimal EIP-1193 provider. */
export type Eip1193 = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (data: unknown) => void): unknown;
  removeListener?(event: string, listener: (data: unknown) => void): unknown;
};

export class WalletError extends Error {
  constructor(
    readonly kind: 'no-wallet' | 'no-account',
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
  }
}

export function getProvider(): Eip1193 | null {
  return (window as unknown as { ethereum?: Eip1193 }).ethereum ?? null;
}

function requireProvider(): Eip1193 {
  const p = getProvider();
  if (!p) throw new WalletError('no-wallet', 'MetaMask not found. Install it, then reload this page.');
  return p;
}

/** The chain table, built from the app's NetConfig so local and live differ only there. */
export function chainFor(id: ChainId): Chain {
  const cfg = getNetConfig();
  switch (id) {
    case 100:
      return { ...gnosis, rpcUrls: { default: { http: [cfg.gnosis.rpcUrl] } } };
    case 1337:
      return cfg.arkiv.chain === 'local'
        ? { ...localhost, rpcUrls: { default: { http: [cfg.arkiv.rpcUrl] } } }
        : localhost;
    case 7794095:
      // The SDK's chain carries the access key in its RPC URLs.
      return rabdi({ accessKey: cfg.arkiv.accessKey ?? '' });
  }
}

function knownChain(id: number): Chain | null {
  return id === 100 || id === 1337 || id === 7794095 ? chainFor(id) : null;
}

/** True when a wallet call failed because the person rejected it (EIP-1193 code 4001). */
export function isUserRejection(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; i++) {
    if (e.code === 4001 || (e as { name?: unknown }).name === 'UserRejectedRequestError') return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** A viem wallet client for `address` on a known chain, over the injected provider. */
export function walletFor(address: Address, id: ChainId): WalletClient {
  return createWalletClient({ account: address, chain: chainFor(id), transport: custom(requireProvider()) });
}

/**
 * Asks the wallet for an account (this is the MetaMask connect prompt). The client is
 * bound to the wallet's current chain; call `ensureChain` and then `walletFor` to act
 * on a specific one.
 */
export async function connectWallet(): Promise<{ address: Address; walletClient: WalletClient }> {
  const provider = requireProvider();
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  const address = accounts[0];
  if (!address) throw new WalletError('no-account', 'MetaMask returned no account.');
  const chain = knownChain(hexToNumber((await provider.request({ method: 'eth_chainId' })) as `0x${string}`));
  const walletClient = createWalletClient({ account: address, chain: chain ?? undefined, transport: custom(provider) });
  void refreshWallet();
  return { address, walletClient };
}

/** Adds the chain to the wallet, then switches to it. Does nothing when already there. */
export async function ensureChain(id: ChainId): Promise<void> {
  const provider = requireProvider();
  const current = hexToNumber((await provider.request({ method: 'eth_chainId' })) as `0x${string}`);
  if (current === id) return;
  const chain = chainFor(id);
  const explorer = chain.blockExplorers?.default.url;
  await provider.request({
    method: 'wallet_addEthereumChain',
    params: [
      {
        chainId: numberToHex(id),
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http,
        ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
      },
    ],
  });
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: numberToHex(id) }] });
  void refreshWallet();
}

// ---- Live wallet state for the header chip (no prompts: only eth_accounts and eth_chainId) ----

export type WalletState = { hasProvider: boolean; address: Address | null; chainId: number | null };

// Wallets inject before page scripts run, so the provider is already there on first render.
let state: WalletState = { hasProvider: getProvider() !== null, address: null, chainId: null };
const subscribers = new Set<() => void>();
let wired: Eip1193 | null = null;

function publish(next: WalletState) {
  if (next.hasProvider === state.hasProvider && next.address === state.address && next.chainId === state.chainId) return;
  state = next;
  subscribers.forEach((fn) => fn());
}

/** Re-reads the wallet's current account and chain without prompting. */
export async function refreshWallet(): Promise<void> {
  const provider = getProvider();
  if (!provider) return publish({ hasProvider: false, address: null, chainId: null });
  if (wired !== provider) {
    wired = provider;
    provider.on?.('accountsChanged', () => void refreshWallet());
    provider.on?.('chainChanged', () => void refreshWallet());
  }
  try {
    const [accounts, chain] = await Promise.all([
      provider.request({ method: 'eth_accounts' }) as Promise<Address[]>,
      provider.request({ method: 'eth_chainId' }) as Promise<`0x${string}`>,
    ]);
    publish({ hasProvider: true, address: accounts[0] ?? null, chainId: hexToNumber(chain) });
  } catch {
    publish({ hasProvider: true, address: null, chainId: null });
  }
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  void refreshWallet();
  return () => {
    subscribers.delete(fn);
  };
}

const snapshot = () => state;

/** The wallet's account and chain, kept current through accountsChanged and chainChanged. */
export function useWallet(): WalletState {
  return useSyncExternalStore(subscribe, snapshot);
}
