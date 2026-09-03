import { afterEach, describe, expect, it, vi } from "vitest";

import { getEnv, resetEnvForTests } from "./env";

function configureRecoveryEnvironment(input: {
  intervalMs?: string;
  batchSize?: string;
}) {
  vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost:5432/test");
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("RUN_RECOVERY_INTERVAL_MS", input.intervalMs);
  vi.stubEnv("RUN_RECOVERY_BATCH_SIZE", input.batchSize);
  resetEnvForTests();
  return getEnv();
}

describe("Run recovery environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvForTests();
  });

  it("uses bounded defaults", () => {
    const environment = configureRecoveryEnvironment({});

    expect(environment.RUN_RECOVERY_INTERVAL_MS).toBe(5_000);
    expect(environment.RUN_RECOVERY_BATCH_SIZE).toBe(100);
  });

  it("accepts explicit integer recovery controls", () => {
    const environment = configureRecoveryEnvironment({
      intervalMs: "1250",
      batchSize: "17",
    });

    expect(environment.RUN_RECOVERY_INTERVAL_MS).toBe(1_250);
    expect(environment.RUN_RECOVERY_BATCH_SIZE).toBe(17);
  });

  it.each([
    { intervalMs: "999", batchSize: "1" },
    { intervalMs: "1000.5", batchSize: "1" },
    { intervalMs: "1000", batchSize: "0" },
    { intervalMs: "1000", batchSize: "1001" },
  ])("rejects an invalid recovery configuration %#", (input) => {
    expect(() => configureRecoveryEnvironment(input)).toThrow();
  });
});
