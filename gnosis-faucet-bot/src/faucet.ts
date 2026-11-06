import type { JsonRpcProvider } from "ethers";
import type { Config } from "./config.js";
import { History } from "./database.js";
import { balance, inspectTransaction } from "./rpc.js";
import { log, errorMessage } from "./logger.js";
export const FAUCET_URL = "https://faucet.gnosischain.com/?chain=gnosis";
export async function runCheck(config: Config, provider: JsonRpcProvider, history: History) {
  log("warn", "manual_intervention_required", { eligibility: "unknown", cooldown: "unknown", automatedClaim: "not_available", faucetUrl: FAUCET_URL, message: "Check eligibility and complete any required verification in the official faucet. No claim is submitted." });
  const before = await balance(provider, config.wallet);
  log("info", "balance", { wallet: config.wallet, xdai: before, chainId: 100, dryRun: config.dryRun });
  for (const { hash } of history.pending(config.wallet)) {
    try {
      const result = await inspectTransaction(provider, config.wallet, hash);
      if (!config.dryRun) history.update(hash, result.status, result.detail);
      log("info", "receipt_check", { hash, ...result, persisted: !config.dryRun });
    } catch (error) { log("error", "receipt_check_failed", { hash, error: errorMessage(error) }); }
  }
  const after = await balance(provider, config.wallet);
  log("info", "balance_after", { wallet: config.wallet, xdai: after });
}
