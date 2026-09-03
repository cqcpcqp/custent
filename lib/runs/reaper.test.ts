import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recoverAbandonedRuns: vi.fn(),
}));

vi.mock("./repository", () => ({
  recoverAbandonedRuns: mocks.recoverAbandonedRuns,
}));

import {
  MAX_RUN_RECOVERY_BATCH_SIZE,
  MIN_RUN_RECOVERY_INTERVAL_MS,
  runRunReaper,
} from "./reaper";

describe("run Run reaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one recovery batch immediately and stops without waiting after abort", async () => {
    const shutdown = new AbortController();
    const database = {} as Pool;
    mocks.recoverAbandonedRuns.mockImplementationOnce(async () => {
      shutdown.abort();
      return 3;
    });

    await expect(
      runRunReaper(
        {
          intervalMs: 5_000,
          batchSize: 23,
          database,
          logger: { error: vi.fn() },
        },
        shutdown.signal,
      ),
    ).resolves.toBeUndefined();

    expect(mocks.recoverAbandonedRuns).toHaveBeenCalledOnce();
    expect(mocks.recoverAbandonedRuns).toHaveBeenCalledWith(
      { maxRuns: 23 },
      database,
    );
  });

  it("interrupts an idle recovery interval promptly", async () => {
    const shutdown = new AbortController();
    mocks.recoverAbandonedRuns.mockResolvedValue(0);
    const running = runRunReaper(
      {
        intervalMs: 60_000,
        batchSize: 10,
        database: {} as Pool,
        logger: { error: vi.fn() },
      },
      shutdown.signal,
    );
    await vi.waitFor(() => {
      expect(mocks.recoverAbandonedRuns).toHaveBeenCalledOnce();
    });

    shutdown.abort();

    await expect(running).resolves.toBeUndefined();
    expect(mocks.recoverAbandonedRuns).toHaveBeenCalledOnce();
  });

  it("logs a safe error shape and continues with the next interval", async () => {
    vi.useFakeTimers();
    const shutdown = new AbortController();
    const logger = { error: vi.fn() };
    mocks.recoverAbandonedRuns
      .mockRejectedValueOnce(new Error("database credentials must stay private"))
      .mockImplementationOnce(async () => {
        shutdown.abort();
        return 0;
      });

    const running = runRunReaper(
      {
        intervalMs: MIN_RUN_RECOVERY_INTERVAL_MS,
        batchSize: 10,
        database: {} as Pool,
        logger,
      },
      shutdown.signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MIN_RUN_RECOVERY_INTERVAL_MS);
    await running;

    expect(mocks.recoverAbandonedRuns).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith({
      event: "run_recovery_failed",
      errorName: "Error",
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      "database credentials",
    );
  });

  it("rejects invalid intervals and batch sizes before touching the database", async () => {
    const signal = new AbortController().signal;
    const base = {
      database: {} as Pool,
      logger: { error: vi.fn() },
    };

    await expect(
      runRunReaper(
        {
          ...base,
          intervalMs: MIN_RUN_RECOVERY_INTERVAL_MS - 1,
          batchSize: 1,
        },
        signal,
      ),
    ).rejects.toThrow("intervalMs must be a safe integer");
    await expect(
      runRunReaper(
        {
          ...base,
          intervalMs: MIN_RUN_RECOVERY_INTERVAL_MS,
          batchSize: MAX_RUN_RECOVERY_BATCH_SIZE + 1,
        },
        signal,
      ),
    ).rejects.toThrow("batchSize must be a safe integer");

    expect(mocks.recoverAbandonedRuns).not.toHaveBeenCalled();
  });
});
