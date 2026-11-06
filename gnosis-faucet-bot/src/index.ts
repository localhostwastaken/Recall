import { loadConfig } from "./config.js";
import { History } from "./database.js";
import { makeRpc } from "./rpc.js";
import { runCheck } from "./faucet.js";
import { startScheduler } from "./scheduler.js";
import { log, errorMessage } from "./logger.js";
async function main() {
  const config = loadConfig();
  const [command = "start", value, ...extra] = process.argv.slice(2);
  if (extra.length || !["start", "check", "record", "history"].includes(command) || (command === "record" ? !value || !/^0x[0-9a-fA-F]{64}$/.test(value) : Boolean(value))) throw new Error("Usage: start | check | history | record <transaction-hash>");
  const history = new History(config.databasePath);
  const provider = makeRpc(config);
  const close = () => { provider.destroy(); history.close(); };
  if (command === "record") {
    if (config.dryRun) log("info", "dry_run", { message: "Hash not recorded. Set DRY_RUN=false to save it." });
    else log("info", "claim_recorded", { hash: value, inserted: history.add(value!, config.wallet), message: "User-supplied hash; faucet origin not verified." });
    close(); return;
  }
  if (command === "history") { log("info", "history", { claims: history.all(config.wallet) }); close(); return; }
  if (command === "check") { try { await runCheck(config, provider, history); } finally { close(); } return; }
  log("info", "scheduler_started", { schedule: "hourly at minute 0", dryRun: config.dryRun });
  const stop = startScheduler(() => runCheck(config, provider, history));
  let shuttingDown = false;
  const shutdown = async (signal: string) => { if (shuttingDown) return; shuttingDown = true; log("info", "shutdown", { signal }); await stop(); close(); };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
main().catch(error => { log("error", "fatal", { error: errorMessage(error) }); process.exitCode = 1; });
