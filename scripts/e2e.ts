import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";

import {
  E2E_BACKGROUND_CONVERSATION_ID,
  E2E_BACKGROUND_CONVERSATION_TITLE,
  E2E_CONTROL_CONVERSATION_ID,
  E2E_CONTROL_CONVERSATION_TITLE,
  E2E_DEMO_USER_ID,
} from "../e2e/fixtures/ids";
import { loadProjectEnvFile } from "./project-env";

const projectRoot = path.resolve(import.meta.dirname, "..");
const localDatabaseHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseInspectionDurationMs(value: string | undefined): number {
  const rawValue = value ?? "0";
  if (!/^(?:0|[1-9][0-9]*)$/u.test(rawValue)) {
    throw new Error("CUSTENT_E2E_INSPECT_MS must be an integer from 0 to 600000");
  }
  const durationMs = Number(rawValue);
  if (!Number.isSafeInteger(durationMs) || durationMs > 600_000) {
    throw new Error("CUSTENT_E2E_INSPECT_MS must be an integer from 0 to 600000");
  }
  return durationMs;
}

export async function waitForInspectionDuration(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (durationMs === 0) {
    return;
  }
  try {
    await delay(durationMs, undefined, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

interface CleanupTask {
  label: string;
  run: () => Promise<void>;
}

export async function collectCleanupFailures(
  tasks: readonly CleanupTask[],
): Promise<Error[]> {
  const results = await Promise.allSettled(
    tasks.map(async ({ run }) => run()),
  );
  const failures: Error[] = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push(
        new Error(`Failed to ${tasks[index].label}`, { cause: result.reason }),
      );
    }
  });
  return failures;
}

export interface NextServerLifecycle {
  dispose(): void;
  getUnexpectedFailure(): Error | null;
  markIntentionalStop(): void;
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

interface ShutdownSignalTarget {
  exitCode: NodeJS.Process["exitCode"];
  on(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownSignalHandlers {
  dispose(): void;
  getInterruptionReason(): Error | null;
}

export function installShutdownSignalHandlers(
  shutdown: AbortController,
  target: ShutdownSignalTarget = process,
): ShutdownSignalHandlers {
  let interruptionReason: Error | null = null;
  const requestShutdown = (signal: ShutdownSignal): void => {
    if (interruptionReason !== null) {
      return;
    }
    const reason = new Error(`E2E interrupted by ${signal}`);
    interruptionReason = reason;
    target.exitCode = signal === "SIGINT" ? 130 : 143;
    shutdown.abort(reason);
  };
  const requestSigint = (): void => {
    requestShutdown("SIGINT");
  };
  const requestSigterm = (): void => {
    requestShutdown("SIGTERM");
  };

  // Keep both listeners installed for the whole cleanup. A terminal interrupt
  // can reach this process directly and then again through pnpm or another
  // wrapper. A once-listener would let the duplicate signal kill the process
  // halfway through its asynchronous finally block.
  target.on("SIGINT", requestSigint);
  target.on("SIGTERM", requestSigterm);

  return {
    dispose(): void {
      target.removeListener("SIGINT", requestSigint);
      target.removeListener("SIGTERM", requestSigterm);
    },
    getInterruptionReason(): Error | null {
      return interruptionReason;
    },
  };
}

export function observeNextServer(
  child: ChildProcess,
  shutdown: AbortController,
): NextServerLifecycle {
  let intentionalStop = false;
  let unexpectedFailure: Error | null = null;

  const reportUnexpectedFailure = (error: Error): void => {
    if (
      intentionalStop ||
      unexpectedFailure !== null ||
      shutdown.signal.aborted
    ) {
      return;
    }
    unexpectedFailure = error;
    shutdown.abort(error);
  };
  const handleError = (error: Error): void => {
    reportUnexpectedFailure(
      new Error("Next E2E server process failed", { cause: error }),
    );
  };
  const handleExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    reportUnexpectedFailure(
      new Error(
        `Next E2E server exited unexpectedly with ${
          code === null ? `signal ${signal}` : `code ${code}`
        }`,
      ),
    );
  };

  child.on("error", handleError);
  child.once("exit", handleExit);

  return {
    dispose(): void {
      child.removeListener("error", handleError);
      child.removeListener("exit", handleExit);
    },
    getUnexpectedFailure(): Error | null {
      return unexpectedFailure;
    },
    markIntentionalStop(): void {
      intentionalStop = true;
    },
  };
}

function executable(name: string): string {
  return path.join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

function requiredLocalDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (value === undefined || value.length === 0) {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for E2E");
  }
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !localDatabaseHosts.has(parsed.hostname)
  ) {
    throw new Error("E2E requires a PostgreSQL server on the local machine");
  }
  if (parsed.searchParams.has("options")) {
    throw new Error("E2E database URL must not define PostgreSQL options");
  }
  return value;
}

function databaseUrlForDatabase(
  baseUrl: string,
  databaseName: string,
): string {
  if (!/^custent_e2e_[0-9a-f]{32}$/u.test(databaseName)) {
    throw new Error("Refusing an invalid E2E database name");
  }
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function waitForProcess(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${label} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`,
        ),
      );
    });
  });
}

async function runCommand(
  label: string,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  console.log(`\n[e2e] ${label}`);
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: environment,
    signal,
    stdio: "inherit",
  });
  await waitForProcess(child, label);
}

async function runIsolatedNextBuild(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  const generatedTypeConfigPaths = [
    path.join(projectRoot, "tsconfig.json"),
    path.join(projectRoot, "next-env.d.ts"),
  ];
  const snapshots = await Promise.all(
    generatedTypeConfigPaths.map(async (filePath) => ({
      contents: await readFile(filePath),
      filePath,
    })),
  );
  const failures: unknown[] = [];

  try {
    await runCommand(
      "build the isolated production application",
      executable("next"),
      ["build"],
      environment,
      signal,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    const restoreResults = await Promise.allSettled(
      snapshots.map(({ contents, filePath }) => writeFile(filePath, contents)),
    );
    restoreResults.forEach((result, index) => {
      if (result.status === "rejected") {
        failures.push(
          new Error(
            `Failed to restore ${path.basename(snapshots[index].filePath)} after the isolated Next build`,
            { cause: result.reason },
          ),
        );
      }
    });
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "The isolated Next build failed while restoring generated type config",
    );
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  const timeout = new AbortController();
  try {
    return await Promise.race([
      once(child, "exit").then(() => true),
      delay(timeoutMs, undefined, { signal: timeout.signal }).then(
        () => false,
      ),
    ]);
  } finally {
    timeout.abort();
  }
}

export async function stopChild(
  child: ChildProcess | null,
  lifecycle: NextServerLifecycle | null,
): Promise<void> {
  if (
    child === null ||
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  lifecycle?.markIntentionalStop();
  if (!child.kill("SIGTERM")) {
    if (await waitForChildExit(child, 250)) {
      return;
    }
    throw new Error("Failed to send SIGTERM to the Next E2E server");
  }
  if (await waitForChildExit(child, 5_000)) {
    return;
  }
  if (!child.kill("SIGKILL")) {
    throw new Error("Failed to send SIGKILL to the Next E2E server");
  }
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error("Next E2E server did not exit after SIGKILL");
  }
}

async function listenOnEphemeralPort(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Local E2E server did not expose a TCP port");
  }
  return address.port;
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  const port = await listenOnEphemeralPort(server);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}

async function waitForNextServer(
  url: string,
  child: ChildProcess,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Next E2E server exited before becoming ready");
    }
    try {
      const response = await fetch(url, { redirect: "manual", signal });
      if (response.status === 200) {
        signal.throwIfAborted();
        return;
      }
    } catch {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      // The isolated server has not started listening yet.
    }
    await delay(150, undefined, { signal });
  }
  throw new Error("Next E2E server did not become ready within 30 seconds");
}

async function seedDatabase(
  databaseUrl: string,
  databaseName: string,
): Promise<void> {
  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const currentDatabase = await database.query<{ current_database: string }>(
      "SELECT current_database()",
    );
    if (currentDatabase.rows[0]?.current_database !== databaseName) {
      throw new Error("E2E connection did not select its isolated database");
    }
    await database.query(
      `
        INSERT INTO conversations (
          id,
          user_id,
          title,
          created_at,
          updated_at
        )
        VALUES
          ($1, $2, $3, now() - interval '1 minute', now()),
          ($4, $2, $5, now() - interval '2 minutes', now() - interval '1 second')
      `,
      [
        E2E_BACKGROUND_CONVERSATION_ID,
        E2E_DEMO_USER_ID,
        E2E_BACKGROUND_CONVERSATION_TITLE,
        E2E_CONTROL_CONVERSATION_ID,
        E2E_CONTROL_CONVERSATION_TITLE,
      ],
    );
  } finally {
    await database.end();
  }
}

async function assertProviderFreeRun(databaseUrl: string): Promise<void> {
  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await database.query<{
      run_count: string;
      completed_count: string;
      cancelled_count: string;
      failed_count: string;
      reconciliation_required_count: string;
      outstanding_count: string;
      model_started_count: string;
      retry_count: string;
      retryable_fixture_failure_count: string;
      simulated_model_reconciliation_count: string;
    }>(`
      SELECT
        COUNT(*)::text AS run_count,
        COUNT(*) FILTER (WHERE status = 'completed')::text AS completed_count,
        COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled_count,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed_count,
        COUNT(*) FILTER (WHERE status = 'reconciliation_required')::text
          AS reconciliation_required_count,
        COUNT(*) FILTER (WHERE status IN ('waiting', 'queued', 'running'))::text
          AS outstanding_count,
        COUNT(*) FILTER (WHERE model_started_at IS NOT NULL)::text
          AS model_started_count,
        COUNT(*) FILTER (WHERE retry_of_run_id IS NOT NULL)::text
          AS retry_count,
        COUNT(*) FILTER (
          WHERE
            status = 'failed'
            AND failure_code = 'E2E_RETRYABLE_FAILURE'
        )::text AS retryable_fixture_failure_count,
        COUNT(*) FILTER (
          WHERE
            status = 'reconciliation_required'
            AND model_started_at IS NOT NULL
            AND failure_code = 'RUN_REQUIRES_RECONCILIATION'
        )::text AS simulated_model_reconciliation_count
      FROM runs
    `);
    const row = result.rows[0];
    if (
      row === undefined ||
      row.run_count !== "16" ||
      row.completed_count !== "12" ||
      row.cancelled_count !== "2" ||
      row.failed_count !== "1" ||
      row.reconciliation_required_count !== "1" ||
      row.outstanding_count !== "0" ||
      row.model_started_count !== "1" ||
      row.retry_count !== "2" ||
      row.retryable_fixture_failure_count !== "1" ||
      row.simulated_model_reconciliation_count !== "1"
    ) {
      throw new Error(
        `Unexpected E2E Run invariant: ${JSON.stringify(row ?? null)}`,
      );
    }
  } finally {
    await database.end();
  }
}

function assertProviderTripwireUntouched(
  providerRequests: readonly string[],
): void {
  if (providerRequests.length !== 0) {
    throw new Error(
      `E2E attempted ${providerRequests.length} provider request(s): ${providerRequests.join(
        ", ",
      )}`,
    );
  }
}

async function main(): Promise<void> {
  loadProjectEnvFile(projectRoot);
  const inspectionDurationMs = parseInspectionDurationMs(
    process.env.CUSTENT_E2E_INSPECT_MS,
  );
  const baseDatabaseUrl = requiredLocalDatabaseUrl();
  const identity = randomUUID().replaceAll("-", "");
  const databaseName = `custent_e2e_${identity}`;
  const databaseUrl = databaseUrlForDatabase(baseDatabaseUrl, databaseName);
  const distDir = `.next-e2e-${identity}`;
  const distDirPath = path.join(projectRoot, distDir);
  const shutdown = new AbortController();
  const shutdownSignals = installShutdownSignalHandlers(shutdown);

  let runtimeDirectory: string | null = null;
  let adminDatabase: Pool | null = null;
  let databaseCreated = false;
  let nextServer: ChildProcess | null = null;
  let nextServerLifecycle: NextServerLifecycle | null = null;
  const providerRequests: string[] = [];
  let providerTripwire: Server | null = null;
  let providerTripwireListening = false;
  const failures: unknown[] = [];

  try {
    try {
      shutdown.signal.throwIfAborted();
      const createdRuntimeDirectory = await mkdtemp(
        path.join(tmpdir(), "custent-e2e-runtime-"),
      );
      runtimeDirectory = createdRuntimeDirectory;
      const artifactDirectory = path.join(
        createdRuntimeDirectory,
        "artifacts",
      );
      const attachmentDirectory = path.join(
        createdRuntimeDirectory,
        "attachments",
      );
      await Promise.all([
        mkdir(artifactDirectory, { recursive: true }),
        mkdir(attachmentDirectory, { recursive: true }),
      ]);
      shutdown.signal.throwIfAborted();

      const database = new Pool({
        connectionString: baseDatabaseUrl,
        max: 1,
      });
      adminDatabase = database;
      const tripwire = createServer((request, response) => {
        providerRequests.push(
          `${request.method ?? "UNKNOWN"} ${request.url ?? "/"}`,
        );
        request.resume();
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: "Provider access is forbidden during E2E tests",
          }),
        );
      });
      providerTripwire = tripwire;

      await database.query(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      shutdown.signal.throwIfAborted();
      const tripwirePort = await listenOnEphemeralPort(tripwire);
      providerTripwireListening = true;
      shutdown.signal.throwIfAborted();
      const applicationEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_DATABASE_URL: databaseUrl,
        DEMO_USER_ID: E2E_DEMO_USER_ID,
        OPENAI_API_KEY: "e2e-provider-disabled",
        OPENAI_PROVIDER: "openai",
        OPENAI_BASE_URL: `http://127.0.0.1:${tripwirePort}/v1`,
        OPENAI_MODEL: "e2e-provider-disabled",
        OPENAI_REASONING_MODE_ENABLED: "false",
        OPENAI_CODE_INTERPRETER_ENABLED: "false",
        ARTIFACT_DIR: artifactDirectory,
        INPUT_ATTACHMENT_DIR: attachmentDirectory,
        CUSTENT_E2E_DIST_DIR: distDir,
      };

      await runCommand(
        "apply migrations to the isolated schema",
        executable("tsx"),
        ["scripts/migrate.ts"],
        applicationEnvironment,
        shutdown.signal,
      );
      shutdown.signal.throwIfAborted();
      await seedDatabase(databaseUrl, databaseName);
      shutdown.signal.throwIfAborted();
      await runIsolatedNextBuild(applicationEnvironment, shutdown.signal);
      shutdown.signal.throwIfAborted();

      const nextPort = await freeLocalPort();
      shutdown.signal.throwIfAborted();
      const baseURL = `http://127.0.0.1:${nextPort}`;
      console.log(`\n[e2e] start isolated Next server on ${baseURL}`);
      const spawnedNextServer = spawn(
        executable("next"),
        ["start", "-H", "127.0.0.1", "-p", String(nextPort)],
        {
          cwd: projectRoot,
          env: applicationEnvironment,
          signal: shutdown.signal,
          stdio: "inherit",
        },
      );
      nextServer = spawnedNextServer;
      nextServerLifecycle = observeNextServer(spawnedNextServer, shutdown);
      await waitForNextServer(
        baseURL,
        spawnedNextServer,
        shutdown.signal,
      );
      shutdown.signal.throwIfAborted();

      await runCommand(
        "run Chromium workspace regression",
        executable("playwright"),
        ["test", "--config=playwright.config.ts"],
        {
          ...applicationEnvironment,
          CUSTENT_E2E_BASE_URL: baseURL,
        },
        shutdown.signal,
      );
      shutdown.signal.throwIfAborted();
      await assertProviderFreeRun(databaseUrl);
      shutdown.signal.throwIfAborted();
      if (inspectionDurationMs > 0) {
        console.log(
          `\n[e2e] keep isolated server available for ${inspectionDurationMs}ms at ${baseURL}`,
        );
      }
      await waitForInspectionDuration(
        inspectionDurationMs,
        shutdown.signal,
      );
      shutdown.signal.throwIfAborted();
    } catch (error) {
      failures.push(error);
      if (
        shutdown.signal.aborted &&
        error !== shutdown.signal.reason &&
        !failures.includes(shutdown.signal.reason)
      ) {
        failures.push(shutdown.signal.reason);
      }
    } finally {
      try {
        await stopChild(nextServer, nextServerLifecycle);
      } catch (error) {
        failures.push(error);
      } finally {
        nextServerLifecycle?.dispose();
      }
      if (providerTripwireListening && providerTripwire !== null) {
        const tripwire = providerTripwire;
        try {
          await new Promise<void>((resolve, reject) => {
            tripwire.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
          });
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        assertProviderTripwireUntouched(providerRequests);
        console.log("\n[e2e] provider tripwire remained untouched");
      } catch (error) {
        failures.push(error);
      }
      if (databaseCreated && adminDatabase !== null) {
        try {
          if (!/^custent_e2e_[0-9a-f]{32}$/u.test(databaseName)) {
            throw new Error("Refusing to clean an invalid E2E database name");
          }
          await adminDatabase.query(
            `DROP DATABASE "${databaseName}" WITH (FORCE)`,
          );
        } catch (error) {
          failures.push(error);
        }
      }

      const cleanupTasks: CleanupTask[] = [
        {
          label: "remove the isolated Next build directory",
          run: async () =>
            rm(distDirPath, { force: true, recursive: true }),
        },
      ];
      if (adminDatabase !== null) {
        const database = adminDatabase;
        cleanupTasks.push({
          label: "close the E2E admin database pool",
          run: async () => database.end(),
        });
      }
      if (runtimeDirectory !== null) {
        const directory = runtimeDirectory;
        cleanupTasks.push({
          label: "remove the E2E runtime directory",
          run: async () =>
            rm(directory, { force: true, recursive: true }),
        });
      }
      failures.push(...(await collectCleanupFailures(cleanupTasks)));

      const unexpectedNextFailure =
        nextServerLifecycle?.getUnexpectedFailure();
      if (
        unexpectedNextFailure !== null &&
        unexpectedNextFailure !== undefined &&
        !failures.includes(unexpectedNextFailure)
      ) {
        failures.push(unexpectedNextFailure);
      }
      if (
        shutdown.signal.aborted &&
        !failures.includes(shutdown.signal.reason)
      ) {
        failures.push(shutdown.signal.reason);
      }
    }
  } finally {
    shutdownSignals.dispose();
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "E2E regression failed");
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  path.resolve(entrypoint) === path.resolve(import.meta.filename)
) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exitCode ??= 1;
  }
}
