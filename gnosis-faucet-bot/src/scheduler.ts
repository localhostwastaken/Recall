import cron from "node-cron";
import { log, errorMessage } from "./logger.js";
export function startScheduler(job: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let stopping = false;
  const run = () => {
    if (running || stopping) { log("warn", "check_skipped", { reason: stopping ? "shutting_down" : "previous_check_running" }); return; }
    running = job().catch(error => log("error", "check_failed", { error: errorMessage(error) })).finally(() => { running = undefined; });
  };
  const task = cron.schedule("0 * * * *", run);
  run();
  return async () => { stopping = true; task.stop(); await running; };
}
