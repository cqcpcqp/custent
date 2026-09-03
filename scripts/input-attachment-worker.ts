import { setTimeout as delay } from "node:timers/promises";

import { closePool } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { sweepInputAttachments } from "@/lib/input-attachments";

import { loadProjectEnvFile } from "./project-env";

loadProjectEnvFile();
const environment = getEnv();
const stop = new AbortController();

process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

try {
  while (!stop.signal.aborted) {
    try {
      await sweepInputAttachments({
        storageDirectory: environment.INPUT_ATTACHMENT_DIR,
        batchSize: environment.INPUT_ATTACHMENT_SWEEP_BATCH_SIZE,
        retryDelayMs: environment.INPUT_ATTACHMENT_DELETE_RETRY_MS,
        orphanMinAgeMs: environment.INPUT_ATTACHMENT_ORPHAN_MIN_AGE_MS,
        temporaryFileStaleAgeMs:
          environment.INPUT_ATTACHMENT_TEMP_STALE_AGE_MS,
      });
    } catch (error) {
      console.error(error);
    }

    try {
      await delay(environment.INPUT_ATTACHMENT_SWEEP_INTERVAL_MS, undefined, {
        signal: stop.signal,
      });
    } catch (error) {
      if (!stop.signal.aborted) {
        throw error;
      }
    }
  }
} finally {
  await closePool();
}
