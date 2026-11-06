import { createPublicClient, createWalletClient, erc20Abi, http, parseEther, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { LOCAL, XBZZ, arkivPublic } from '../../packages/net/src/index';
import { BEE_COMPOSE_FAUCET_KEY, DEV_PRIVATE_KEY } from './keys';

// Funding for specs that run next to other specs on the SAME devnet. The faucet and DEV keys
// are used by other agents' tests at the same time, so every funding transaction here takes a
// fresh pending nonce and retries when it loses a race for it.

const NONCE_RACE = /nonce too low|nonce has already been used|replacement transaction underpriced|already known|nonce.*(too low|lower than)/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `send(nonce)` with the account's current pending nonce, retrying when another sender wins that nonce. */
export async function withFreshNonce<T>(rpcUrl: string, from: Address, send: (nonce: number) => Promise<T>): Promise<T> {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  let last: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    const nonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
    try {
      return await send(nonce);
    } catch (e) {
      last = e;
      const text = `${(e as Error).message ?? ''} ${(e as { details?: string }).details ?? ''}`;
      if (!NONCE_RACE.test(text)) throw e;
      await sleep(100 + Math.random() * 300);
    }
  }
  throw new Error(`could not get a free nonce for ${from}: ${(last as Error)?.message}`);
}

const gnosisChain: Chain = { ...gnosis, rpcUrls: { default: { http: [LOCAL.gnosis.rpcUrl] } } };

/** Gives `to` at least `min` of the chain's native coin (xDAI on the fork, ETH on Arkiv), only when it holds less. */
async function ensureNative(rpcUrl: string, chain: Chain, fromKey: Hex, to: Address, min: bigint): Promise<void> {
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const have = await pub.getBalance({ address: to });
  if (have >= min) return;
  const account = privateKeyToAccount(fromKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const hash = await withFreshNonce(rpcUrl, account.address, (nonce) =>
    wallet.sendTransaction({ to, value: min - have, nonce }),
  );
  await pub.waitForTransactionReceipt({ hash });
}

/** xDAI for gas on the Gnosis fork (anvil prefunds its default accounts, so this normally sends nothing). */
export const ensureXdai = (to: Address, min = parseEther('1')) =>
  ensureNative(LOCAL.gnosis.rpcUrl, gnosisChain, BEE_COMPOSE_FAUCET_KEY, to, min);

/** Gas on the local Arkiv chain (the reth dev chain prefunds the standard accounts, so this normally sends nothing). */
export const ensureArkivGas = (to: Address, min = parseEther('1')) =>
  ensureNative(LOCAL.arkiv.rpcUrl, arkivPublic(LOCAL).chain, DEV_PRIVATE_KEY, to, min);

/** Gives `to` at least `min` xBZZ (16 decimals) from the bee-compose faucet, only when it holds less. */
export async function ensureXbzz(to: Address, min: bigint): Promise<void> {
  const pub = createPublicClient({ transport: http(LOCAL.gnosis.rpcUrl) });
  const have = await pub.readContract({ address: XBZZ, abi: erc20Abi, functionName: 'balanceOf', args: [to] });
  if (have >= min) return;
  const account = privateKeyToAccount(BEE_COMPOSE_FAUCET_KEY);
  const wallet = createWalletClient({ account, chain: gnosisChain, transport: http(LOCAL.gnosis.rpcUrl) });
  const hash = await withFreshNonce(LOCAL.gnosis.rpcUrl, account.address, (nonce) =>
    wallet.writeContract({ address: XBZZ, abi: erc20Abi, functionName: 'transfer', args: [to, min - have], nonce }),
  );
  await pub.waitForTransactionReceipt({ hash });
}

/** Makes a test wallet ready: xDAI and Arkiv gas (usually already there) and `xbzz` of storage money. */
export async function fundWallet(address: Address, xbzz: bigint): Promise<void> {
  await ensureXdai(address);
  await ensureArkivGas(address);
  await ensureXbzz(address, xbzz);
}
