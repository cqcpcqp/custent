import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

const environmentFile = path.resolve(process.cwd(), ".env");
if (existsSync(environmentFile)) {
  loadEnvFile(environmentFile);
}

const [chatRuntime, database, environment, runs] = await Promise.all([
  import("@/lib/chat/runtime"),
  import("@/lib/db/pool"),
  import("@/lib/env"),
  import("@/lib/runs"),
]);
const env = environment.getEnv();
const shutdown = new AbortController();
const worker = new runs.AgentRunWorker({
  runtimeFactory: chatRuntime.getChatAgentRuntimeFactory(),
  concurrency: env.RUN_WORKER_CONCURRENCY,
  pollIntervalMs: env.RUN_WORKER_POLL_MS,
  leaseDurationMs: env.RUN_LEASE_MS,
});

function requestShutdown(): void {
  shutdown.abort();
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  await worker.run(shutdown.signal);
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
  await database.closePool();
}
