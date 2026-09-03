import type { Pool } from "pg";

import { getPool } from "@/lib/db";

import { recoverAbandonedRuns } from "./repository";

export const MIN_RUN_RECOVERY_INTERVAL_MS = 1_000;
export const MAX_RUN_RECOVERY_BATCH_SIZE = 1_000;

export type RunReaperOptions = {
  intervalMs: number;
  batchSize: number;
  database?: Pool;
  logger?: Pick<Console, "error">;
};

type SafeRunReaperErrorEvent = Readonly<{
  event: "run_recovery_failed";
  errorName:
    | "AbortError"
    | "Error"
    | "RangeError"
    | "TypeError"
    | "UnknownError";
}>;

function safeErrorName(error: unknown): SafeRunReaperErrorEvent["errorName"] {
  if (error instanceof TypeError) {
    return "TypeError";
  }
  if (error instanceof RangeError) {
    return "RangeError";
  }
  if (error instanceof Error) {
    return error.name === "AbortError" ? "AbortError" : "Error";
  }
  return "UnknownError";
}

function validateOptions(options: RunReaperOptions): void {
  if (
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < MIN_RUN_RECOVERY_INTERVAL_MS
  ) {
    throw new TypeError(
      `intervalMs must be a safe integer of at least ${MIN_RUN_RECOVERY_INTERVAL_MS}`,
    );
  }
  if (
    !Number.isSafeInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > MAX_RUN_RECOVERY_BATCH_SIZE
  ) {
    throw new TypeError(
      `batchSize must be a safe integer from 1 to ${MAX_RUN_RECOVERY_BATCH_SIZE}`,
    );
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export async function runRunReaper(
  options: RunReaperOptions,
  signal: AbortSignal,
): Promise<void> {
  validateOptions(options);
  const database = options.database ?? getPool();
  const logger = options.logger ?? console;

  while (!signal.aborted) {
    try {
      await recoverAbandonedRuns(
        { maxRuns: options.batchSize },
        database,
      );
    } catch (error) {
      logger.error({
        event: "run_recovery_failed",
        errorName: safeErrorName(error),
      } satisfies SafeRunReaperErrorEvent);
    }

    if (!signal.aborted) {
      await delay(options.intervalMs, signal);
    }
  }
}
