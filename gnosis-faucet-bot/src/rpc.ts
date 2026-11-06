import { JsonRpcProvider, formatEther, getAddress } from "ethers";
import type { Config } from "./config.js";
export async function retry<T>(operation: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await operation(); } catch (error) { last = error; if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** i)); }
  }
  throw last;
}
export function makeRpc(config: Config) { return new JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: false, batchMaxCount: 1 }); }
export async function checkNetwork(provider: JsonRpcProvider) {
  const chain = BigInt(await retry(() => provider.send("eth_chainId", [])));
  if (chain !== 100n) throw new Error(`Wrong RPC network: expected chain 100, received ${chain}`);
}
export async function balance(provider: JsonRpcProvider, wallet: string) {
  await checkNetwork(provider);
  return formatEther(BigInt(await retry(() => provider.send("eth_getBalance", [wallet, "latest"]))));
}
export async function inspectTransaction(provider: JsonRpcProvider, wallet: string, hash: string) {
  await checkNetwork(provider);
  const [tx, receipt] = await Promise.all([retry(() => provider.getTransaction(hash)), retry(() => provider.getTransactionReceipt(hash))]);
  if (!receipt) return { status: "pending", detail: "Receipt unavailable; transaction may be pending or unknown." };
  if (!tx) return { status: "unverified", detail: "Receipt available but transaction data unavailable." };
  if (receipt.status !== 1) return { status: "failed", detail: "Transaction reverted." };
  if (!tx.to || getAddress(tx.to) !== getAddress(wallet) || tx.value <= 0n) return { status: "unverified", detail: "Receipt succeeded, but not a direct positive native transfer to the wallet; internal transfers are not checked." };
  return { status: "confirmed_transfer", detail: `Successful direct transfer of ${formatEther(tx.value)} xDAI to the wallet. Faucet origin is not verified.` };
}
