import { closePool } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { runRunReaper } from "@/lib/runs/reaper";

import { loadProjectEnvFile } from "./project-env";

loadProjectEnvFile();
const environment = getEnv();
const shutdown = new AbortController();

function requestShutdown(): void {
  shutdown.abort();
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  await runRunReaper(
    {
      intervalMs: environment.RUN_RECOVERY_INTERVAL_MS,
      batchSize: environment.RUN_RECOVERY_BATCH_SIZE,
    },
    shutdown.signal,
  );
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
  await closePool();
}
