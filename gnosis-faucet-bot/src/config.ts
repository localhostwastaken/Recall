import "dotenv/config";
import { getAddress } from "ethers";
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const rpcUrl = env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com";
  if (!["http:", "https:"].includes(new URL(rpcUrl).protocol)) throw new Error("RPC must use HTTP(S)");
  if (Number(env.GNOSIS_CHAIN_ID || "100") !== 100) throw new Error("Only Gnosis mainnet chain ID 100 is supported");
  const dryRun = env.DRY_RUN ?? "true";
  if (dryRun !== "true" && dryRun !== "false") throw new Error("DRY_RUN must be true or false");
  return { rpcUrl, chainId: 100, wallet: getAddress(env.WALLET_ADDRESS || "0xd46480d1Ec02B8ce92aE383914026efD5F73f835"), dryRun: dryRun === "true", databasePath: env.DATABASE_PATH || "./claims.sqlite" };
}
export type Config = ReturnType<typeof loadConfig>;
