import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadProjectEnvFile } from "./project-env";

const testEnvironmentKeys = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "RUN_WORKER_POLL_MS",
] as const;

const originalEnvironment = new Map(
  testEnvironmentKeys.map((key) => [key, process.env[key]]),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const key of testEnvironmentKeys) {
    const originalValue = originalEnvironment.get(key);
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("loadProjectEnvFile", () => {
  it("loads the project-root .env without starting either worker or a network client", async () => {
    for (const key of testEnvironmentKeys) {
      delete process.env[key];
    }
    const workingDirectory = await mkdtemp(
      path.join(tmpdir(), "custent-project-env-"),
    );
    temporaryDirectories.push(workingDirectory);
    await writeFile(
      path.join(workingDirectory, ".env"),
      [
        "DATABASE_URL=postgres://example.invalid/custent",
        "OPENAI_API_KEY=test-provider-key",
        "RUN_WORKER_POLL_MS=375",
        "",
      ].join("\n"),
      "utf8",
    );

    loadProjectEnvFile(workingDirectory);

    expect(process.env.DATABASE_URL).toBe(
      "postgres://example.invalid/custent",
    );
    expect(process.env.OPENAI_API_KEY).toBe("test-provider-key");
    expect(process.env.RUN_WORKER_POLL_MS).toBe("375");
  });

  it("does nothing when the working directory has no .env", async () => {
    for (const key of testEnvironmentKeys) {
      delete process.env[key];
    }
    const workingDirectory = await mkdtemp(
      path.join(tmpdir(), "custent-project-env-empty-"),
    );
    temporaryDirectories.push(workingDirectory);

    loadProjectEnvFile(workingDirectory);

    for (const key of testEnvironmentKeys) {
      expect(process.env[key]).toBeUndefined();
    }
  });
});
