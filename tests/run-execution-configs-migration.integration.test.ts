import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

import type {
  CapturedRunExecutionConfig,
  ChatRequest,
} from "@/lib/contracts";
import {
  enqueueChatRun,
  regenerateAgentRun,
  retryAgentRun,
} from "@/lib/runs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration027Filename = "027_run_execution_configs.sql";
const migration028Filename = "028_reasoning_mode_capability.sql";

type MigrationContext = {
  assertion027: string;
  assertion028: string;
  client: PoolClient;
  migration027: string;
  migration028: string;
  schemaName: string;
};

type RootRunFixture = {
  assistantMessageId: string;
  conversationId: string;
  inputMessageId: string;
  runId: string;
  userId: string;
};

type RootRunStatus = "queued" | "completed" | "failed" | "cancelled";

type CapturedConfig = {
  snapshotVersion: number;
  executionProfileId: "standard_research" | "pro_research";
  profileLabel: string;
  provider: "openai" | "sharesub";
  baseUrl: string;
  model: string;
  reasoningMode: "standard" | "pro";
  reasoningEffort:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  reasoningSummary: "auto";
  webSearchEnabled: boolean;
  codeInterpreterEnabled: boolean;
  listResearchEnabled: boolean;
  saveResearchResultsEnabled: boolean;
  createCsvEnabled: boolean;
  createPdfEnabled: boolean;
  createCsvFileEnabled: boolean;
  createPdfFileEnabled: boolean;
  maxAgentTurns: number;
  billingPolicyVersion: number;
  reservationCredits: number;
  creditsPer1kInputTokens: number;
  creditsPer1kOutputTokens: number;
  creditsPerWebSearch: number;
};

type CapturedConfigAfter028 = CapturedConfig & {
  reasoningModeEnabled: boolean;
};

const standardConfig: CapturedConfig = {
  snapshotVersion: 1,
  executionProfileId: "standard_research",
  profileLabel: "标准研究",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.6",
  reasoningMode: "standard",
  reasoningEffort: "medium",
  reasoningSummary: "auto",
  webSearchEnabled: true,
  codeInterpreterEnabled: false,
  listResearchEnabled: true,
  saveResearchResultsEnabled: true,
  createCsvEnabled: true,
  createPdfEnabled: true,
  createCsvFileEnabled: true,
  createPdfFileEnabled: true,
  maxAgentTurns: 8,
  billingPolicyVersion: 1,
  reservationCredits: 100,
  creditsPer1kInputTokens: 1,
  creditsPer1kOutputTokens: 5,
  creditsPerWebSearch: 10,
};

function applicationConfigBefore028(config: CapturedConfig): object {
  return {
    provenance: "captured",
    snapshotVersion: config.snapshotVersion,
    executionProfileId: config.executionProfileId,
    profileLabel: config.profileLabel,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    reasoningMode: config.reasoningMode,
    reasoningEffort: config.reasoningEffort,
    reasoningSummary: config.reasoningSummary,
    tools: {
      webSearch: config.webSearchEnabled,
      codeInterpreter: config.codeInterpreterEnabled,
      listResearch: config.listResearchEnabled,
      saveResearchResults: config.saveResearchResultsEnabled,
      createCsv: config.createCsvEnabled,
      createPdf: config.createPdfEnabled,
      createCsvFile: config.createCsvFileEnabled,
      createPdfFile: config.createPdfFileEnabled,
    },
    maxAgentTurns: config.maxAgentTurns,
    billing: {
      policyVersion: config.billingPolicyVersion,
      reservationCredits: config.reservationCredits,
      creditsPer1kInputTokens: config.creditsPer1kInputTokens,
      creditsPer1kOutputTokens: config.creditsPer1kOutputTokens,
      creditsPerWebSearch: config.creditsPerWebSearch,
    },
  };
}

function applicationConfigAfter028(
  config: CapturedConfigAfter028,
): CapturedRunExecutionConfig {
  return {
    provenance: "captured",
    snapshotVersion: config.snapshotVersion === 1 ? 1 : 2,
    executionProfileId: config.executionProfileId,
    profileLabel: config.profileLabel,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    reasoningMode: config.reasoningMode,
    reasoningModeEnabled: config.reasoningModeEnabled,
    reasoningEffort: config.reasoningEffort,
    reasoningSummary: config.reasoningSummary,
    tools: {
      webSearch: true,
      codeInterpreter: false,
      listResearch: true,
      saveResearchResults: true,
      createCsv: true,
      createPdf: true,
      createCsvFile: true,
      createPdfFile: true,
    },
    maxAgentTurns: config.maxAgentTurns,
    billing: {
      policyVersion: 1,
      reservationCredits: config.reservationCredits,
      creditsPer1kInputTokens: config.creditsPer1kInputTokens,
      creditsPer1kOutputTokens: config.creditsPer1kOutputTokens,
      creditsPerWebSearch: config.creditsPerWebSearch,
    },
  };
}

function chatFingerprintBefore028(
  request: ChatRequest,
  config: CapturedConfig,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "custent.chat-request.v3",
        request.kind,
        request.conversationId,
        request.parentRunId,
        request.kind === "edit" ? request.sourceMessageId : null,
        request.message,
        request.attachmentIds,
        request.executionProfileId,
        applicationConfigBefore028(config),
      ]),
      "utf8",
    )
    .digest("hex");
}

function attemptFingerprintBefore028(
  kind: "retry" | "regenerate",
  sourceRunId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        kind === "retry"
          ? "custent.run-retry.v2"
          : "custent.run-regenerate.v2",
        sourceRunId,
        applicationConfigBefore028(standardConfig),
      ]),
      "utf8",
    )
    .digest("hex");
}

async function withSchemaBefore027(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_027_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const earlierMigrations = (await readdir(migrationsDirectory))
      .filter(
        (filename) =>
          /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
          filename < migration027Filename,
      )
      .sort();
    for (const filename of earlierMigrations) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      assertion027: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/027_run_execution_configs.sql",
        ),
        "utf8",
      ),
      assertion028: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/028_reasoning_mode_capability.sql",
        ),
        "utf8",
      ),
      client,
      migration027: await readFile(
        path.join(migrationsDirectory, migration027Filename),
        "utf8",
      ),
      migration028: await readFile(
        path.join(migrationsDirectory, migration028Filename),
        "utf8",
      ),
      schemaName,
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release();
    await database.end();
  }
}

async function inCommittedTransaction<T>(
  client: PoolClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await operation();
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertRootRun(
  client: PoolClient,
  status: RootRunStatus,
): Promise<RootRunFixture> {
  const fixture: RootRunFixture = {
    assistantMessageId: randomUUID(),
    conversationId: randomUUID(),
    inputMessageId: randomUUID(),
    runId: randomUUID(),
    userId: randomUUID(),
  };

  await client.query(
    `
      INSERT INTO users (id, name, available_credits)
      VALUES ($1, '027 migration integration user', 1000)
    `,
    [fixture.userId],
  );
  await client.query(
    `
      INSERT INTO conversations (id, user_id, title)
      VALUES ($1, $2, '027 execution configuration fixture')
    `,
    [fixture.conversationId, fixture.userId],
  );
  await client.query(
    `
      INSERT INTO messages (id, conversation_id, role, content, citations)
      VALUES ($1, $2, 'user', 'execution configuration fixture input', '[]')
    `,
    [fixture.inputMessageId, fixture.conversationId],
  );
  if (status === "completed") {
    await client.query(
      `
        INSERT INTO messages (id, conversation_id, role, content, citations)
        VALUES ($1, $2, 'assistant', 'completed fixture answer', '[]')
      `,
      [fixture.assistantMessageId, fixture.conversationId],
    );
  }

  if (status === "completed") {
    await client.query(
      `
        INSERT INTO runs (
          id,
          request_id,
          user_id,
          conversation_id,
          status,
          reservation_credits,
          charged_credits,
          input_tokens,
          output_tokens,
          web_searches,
          input_message_id,
          assistant_message_id,
          completed_at,
          finished_at,
          conversation_turn,
          attempt_index
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          'completed',
          100,
          7,
          100,
          50,
          0,
          $5,
          $6,
          now(),
          now(),
          1,
          1
        )
      `,
      [
        fixture.runId,
        randomUUID(),
        fixture.userId,
        fixture.conversationId,
        fixture.inputMessageId,
        fixture.assistantMessageId,
      ],
    );
  } else if (status === "queued") {
    await client.query(
      `
        INSERT INTO runs (
          id,
          request_id,
          user_id,
          conversation_id,
          status,
          reservation_credits,
          input_message_id,
          assistant_message_id,
          conversation_turn,
          attempt_index
        )
        VALUES ($1, $2, $3, $4, 'queued', 100, $5, $6, 1, 1)
      `,
      [
        fixture.runId,
        randomUUID(),
        fixture.userId,
        fixture.conversationId,
        fixture.inputMessageId,
        fixture.assistantMessageId,
      ],
    );
  } else {
    await client.query(
      `
        INSERT INTO runs (
          id,
          request_id,
          user_id,
          conversation_id,
          status,
          reservation_credits,
          input_message_id,
          assistant_message_id,
          failure_code,
          failure_message,
          finished_at,
          conversation_turn,
          attempt_index
        )
        VALUES ($1, $2, $3, $4, $5, 100, $6, $7, $8, $9, now(), 1, 1)
      `,
      [
        fixture.runId,
        randomUUID(),
        fixture.userId,
        fixture.conversationId,
        status,
        fixture.inputMessageId,
        fixture.assistantMessageId,
        status === "failed" ? "PROVIDER_ERROR" : "RUN_CANCELLED",
        status === "failed" ? "Provider failed" : "Run was cancelled",
      ],
    );
  }

  await client.query(
    `
      UPDATE messages
      SET run_id = $2
      WHERE id = $1
    `,
    [fixture.inputMessageId, fixture.runId],
  );
  if (status === "completed") {
    await client.query(
      `
        UPDATE messages
        SET run_id = $2
        WHERE id = $1
      `,
      [fixture.assistantMessageId, fixture.runId],
    );
  }
  await client.query(
    `
      UPDATE conversations
      SET selected_run_id = $2
      WHERE id = $1
    `,
    [fixture.conversationId, fixture.runId],
  );
  return fixture;
}

async function insertCapturedConfig(
  client: PoolClient,
  runId: string,
  overrides: Partial<CapturedConfig> = {},
): Promise<CapturedConfig> {
  const config = { ...standardConfig, ...overrides };
  await client.query(
    `
      INSERT INTO run_execution_configs (
        run_id,
        provenance,
        snapshot_version,
        execution_profile_id,
        profile_label,
        provider,
        base_url,
        model,
        reasoning_mode,
        reasoning_effort,
        reasoning_summary,
        web_search_enabled,
        code_interpreter_enabled,
        list_research_enabled,
        save_research_results_enabled,
        create_csv_enabled,
        create_pdf_enabled,
        create_csv_file_enabled,
        create_pdf_file_enabled,
        max_agent_turns,
        billing_policy_version,
        reservation_credits,
        credits_per_1k_input_tokens,
        credits_per_1k_output_tokens,
        credits_per_web_search
      )
      VALUES (
        $1,
        'captured',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21,
        $22,
        $23,
        $24
      )
    `,
    [
      runId,
      config.snapshotVersion,
      config.executionProfileId,
      config.profileLabel,
      config.provider,
      config.baseUrl,
      config.model,
      config.reasoningMode,
      config.reasoningEffort,
      config.reasoningSummary,
      config.webSearchEnabled,
      config.codeInterpreterEnabled,
      config.listResearchEnabled,
      config.saveResearchResultsEnabled,
      config.createCsvEnabled,
      config.createPdfEnabled,
      config.createCsvFileEnabled,
      config.createPdfFileEnabled,
      config.maxAgentTurns,
      config.billingPolicyVersion,
      config.reservationCredits,
      config.creditsPer1kInputTokens,
      config.creditsPer1kOutputTokens,
      config.creditsPerWebSearch,
    ],
  );
  return config;
}

async function insertCapturedConfigAfter028(
  client: PoolClient,
  runId: string,
  overrides: Partial<CapturedConfigAfter028> = {},
): Promise<CapturedConfigAfter028> {
  const config: CapturedConfigAfter028 = {
    ...standardConfig,
    snapshotVersion: 2,
    reasoningModeEnabled: false,
    ...overrides,
  };
  await client.query(
    `
      INSERT INTO run_execution_configs (
        run_id,
        provenance,
        snapshot_version,
        execution_profile_id,
        profile_label,
        provider,
        base_url,
        model,
        reasoning_mode,
        reasoning_mode_enabled,
        reasoning_effort,
        reasoning_summary,
        web_search_enabled,
        code_interpreter_enabled,
        list_research_enabled,
        save_research_results_enabled,
        create_csv_enabled,
        create_pdf_enabled,
        create_csv_file_enabled,
        create_pdf_file_enabled,
        max_agent_turns,
        billing_policy_version,
        reservation_credits,
        credits_per_1k_input_tokens,
        credits_per_1k_output_tokens,
        credits_per_web_search
      )
      VALUES (
        $1,
        'captured',
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21,
        $22,
        $23,
        $24,
        $25
      )
    `,
    [
      runId,
      config.snapshotVersion,
      config.executionProfileId,
      config.profileLabel,
      config.provider,
      config.baseUrl,
      config.model,
      config.reasoningMode,
      config.reasoningModeEnabled,
      config.reasoningEffort,
      config.reasoningSummary,
      config.webSearchEnabled,
      config.codeInterpreterEnabled,
      config.listResearchEnabled,
      config.saveResearchResultsEnabled,
      config.createCsvEnabled,
      config.createPdfEnabled,
      config.createCsvFileEnabled,
      config.createPdfFileEnabled,
      config.maxAgentTurns,
      config.billingPolicyVersion,
      config.reservationCredits,
      config.creditsPer1kInputTokens,
      config.creditsPer1kOutputTokens,
      config.creditsPerWebSearch,
    ],
  );
  return config;
}

async function insertAttempt(
  client: PoolClient,
  source: RootRunFixture,
  kind: "retry" | "regenerate",
  configOverrides: Partial<CapturedConfigAfter028> = {},
): Promise<string> {
  const runId = randomUUID();
  const retryOfRunId = kind === "retry" ? source.runId : null;
  const regenerateOfRunId = kind === "regenerate" ? source.runId : null;
  await client.query(
    `
      INSERT INTO runs (
        id,
        request_id,
        user_id,
        conversation_id,
        status,
        reservation_credits,
        input_message_id,
        assistant_message_id,
        conversation_turn,
        attempt_index,
        predecessor_run_id,
        retry_of_run_id,
        regenerate_of_run_id
      )
      VALUES ($1, $2, $3, $4, 'queued', 100, $5, $6, 1, 2, NULL, $7, $8)
    `,
    [
      runId,
      randomUUID(),
      source.userId,
      source.conversationId,
      source.inputMessageId,
      randomUUID(),
      retryOfRunId,
      regenerateOfRunId,
    ],
  );
  if (configOverrides.reasoningModeEnabled === undefined) {
    await insertCapturedConfig(client, runId, configOverrides);
  } else {
    await insertCapturedConfigAfter028(client, runId, configOverrides);
  }
  await client.query(
    `
      UPDATE conversations
      SET selected_run_id = $2
      WHERE id = $1
    `,
    [source.conversationId, runId],
  );
  return runId;
}

async function insertLegacyTerminalAttempt(
  client: PoolClient,
  source: RootRunFixture,
  kind: "retry" | "regenerate",
): Promise<string> {
  const runId = randomUUID();
  const retryOfRunId = kind === "retry" ? source.runId : null;
  const regenerateOfRunId = kind === "regenerate" ? source.runId : null;
  await client.query(
    `
      INSERT INTO runs (
        id,
        request_id,
        user_id,
        conversation_id,
        status,
        reservation_credits,
        input_message_id,
        assistant_message_id,
        failure_code,
        failure_message,
        finished_at,
        conversation_turn,
        attempt_index,
        predecessor_run_id,
        retry_of_run_id,
        regenerate_of_run_id
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'failed',
        100,
        $5,
        $6,
        'PROVIDER_ERROR',
        'Historical terminal attempt failed',
        now(),
        1,
        2,
        NULL,
        $7,
        $8
      )
    `,
    [
      runId,
      randomUUID(),
      source.userId,
      source.conversationId,
      source.inputMessageId,
      randomUUID(),
      retryOfRunId,
      regenerateOfRunId,
    ],
  );
  await client.query(
    `
      UPDATE conversations
      SET selected_run_id = $2
      WHERE id = $1
    `,
    [source.conversationId, runId],
  );
  return runId;
}

describe.runIf(databaseUrl !== undefined)(
  "027 Run execution configurations migration",
  () => {
    it("fails closed without leaving schema changes when a legacy Run is outstanding", async () => {
      await withSchemaBefore027(async ({ client, migration027 }) => {
        const outstanding = await inCommittedTransaction(client, () =>
          insertRootRun(client, "queued"),
        );

        await expect(client.query(migration027)).rejects.toMatchObject({
          code: "23514",
        });
        await expect(
          client.query(
            "SELECT to_regclass(format('%I.run_execution_configs', current_schema())) AS name",
          ),
        ).resolves.toMatchObject({ rows: [{ name: null }] });

        await client.query("DELETE FROM conversations WHERE id = $1", [
          outstanding.conversationId,
        ]);
        await client.query("DELETE FROM users WHERE id = $1", [
          outstanding.userId,
        ]);
        await expect(client.query(migration027)).resolves.toBeDefined();
      });
    });

    it("backfills only terminal history as unknown and installs a repeatable exact assertion", async () => {
      await withSchemaBefore027(
        async ({ assertion027, client, migration027 }) => {
          const completed = await inCommittedTransaction(client, () =>
            insertRootRun(client, "completed"),
          );
          const failed = await inCommittedTransaction(client, () =>
            insertRootRun(client, "failed"),
          );

          await client.query(migration027);
          const backfill = await client.query<{
            run_id: string;
            provenance: string;
            model: string | null;
            reservation_credits: number | null;
          }>(
            `
              SELECT run_id, provenance, model, reservation_credits
              FROM run_execution_configs
              WHERE run_id = ANY($1::uuid[])
              ORDER BY run_id
            `,
            [[completed.runId, failed.runId]],
          );
          expect(backfill.rows).toEqual(
            [completed.runId, failed.runId]
              .sort()
              .map((runId) => ({
                run_id: runId,
                provenance: "legacy_unknown",
                model: null,
                reservation_credits: null,
              })),
          );

          await expect(client.query(assertion027)).resolves.toBeDefined();
          await expect(client.query(assertion027)).resolves.toBeDefined();
          const indexes = await client.query<{ indexname: string }>(
            `
              SELECT indexname
              FROM pg_indexes
              WHERE
                schemaname = current_schema()
                AND tablename = 'run_execution_configs'
              ORDER BY indexname
            `,
          );
          expect(indexes.rows.map((row) => row.indexname)).toEqual([
            "run_execution_configs_pkey",
          ]);
        },
      );
    });

    it("preserves pre-027 terminal retry and regenerate attempts as legacy unknown", async () => {
      await withSchemaBefore027(
        async ({ assertion027, client, migration027 }) => {
          const retrySource = await inCommittedTransaction(client, () =>
            insertRootRun(client, "failed"),
          );
          const retryAttemptId = await inCommittedTransaction(client, () =>
            insertLegacyTerminalAttempt(client, retrySource, "retry"),
          );
          const regenerateSource = await inCommittedTransaction(client, () =>
            insertRootRun(client, "completed"),
          );
          const regenerateAttemptId = await inCommittedTransaction(client, () =>
            insertLegacyTerminalAttempt(
              client,
              regenerateSource,
              "regenerate",
            ),
          );

          await expect(client.query(migration027)).resolves.toBeDefined();
          const configs = await client.query<{
            provenance: string;
            run_id: string;
          }>(
            `
              SELECT run_id, provenance
              FROM run_execution_configs
              WHERE run_id = ANY($1::uuid[])
              ORDER BY run_id
            `,
            [
              [
                retrySource.runId,
                retryAttemptId,
                regenerateSource.runId,
                regenerateAttemptId,
              ],
            ],
          );
          expect(configs.rows).toEqual(
            [
              retrySource.runId,
              retryAttemptId,
              regenerateSource.runId,
              regenerateAttemptId,
            ]
              .sort()
              .map((runId) => ({
                provenance: "legacy_unknown",
                run_id: runId,
              })),
          );
          await expect(client.query(assertion027)).resolves.toBeDefined();
        },
      );
    });

    it("enforces captured shape, exact 1:1 ownership, immutability, cascade, and attempt source equality", async () => {
      await withSchemaBefore027(
        async ({ assertion027, client, migration027 }) => {
          const legacyFailed = await inCommittedTransaction(client, () =>
            insertRootRun(client, "failed"),
          );
          await client.query(migration027);

          await expect(
            inCommittedTransaction(client, async () => {
              await insertRootRun(client, "queued");
            }),
          ).rejects.toMatchObject({ code: "23514" });

          await expect(
            inCommittedTransaction(client, async () => {
              const run = await insertRootRun(client, "queued");
              await client.query(
                `
                  INSERT INTO run_execution_configs (run_id, provenance)
                  VALUES ($1, 'legacy_unknown')
                `,
                [run.runId],
              );
            }),
          ).rejects.toMatchObject({ code: "23514" });

          for (const overrides of [
            { snapshotVersion: 2 },
            { executionProfileId: "unsupported_profile" },
            { profileLabel: " padded " },
            { provider: "unknown_provider" },
            { baseUrl: "not-a-provider-url" },
            { model: "" },
            { reasoningMode: "unsupported_mode" },
            { reasoningEffort: "extreme" },
            { reasoningSummary: "detailed" },
            { webSearchEnabled: false },
            { codeInterpreterEnabled: true },
            { listResearchEnabled: false },
            { saveResearchResultsEnabled: false },
            { createCsvEnabled: false },
            { createPdfEnabled: false },
            { createCsvFileEnabled: false },
            { createPdfFileEnabled: false },
            { maxAgentTurns: 33 },
            { billingPolicyVersion: 2 },
            { reservationCredits: 0 },
            { creditsPer1kInputTokens: -1 },
            { creditsPer1kOutputTokens: -1 },
            { creditsPerWebSearch: -1 },
          ] as Array<Partial<CapturedConfig> & Record<string, unknown>>) {
            await expect(
              inCommittedTransaction(client, async () => {
                const run = await insertRootRun(client, "queued");
                await insertCapturedConfig(
                  client,
                  run.runId,
                  overrides as Partial<CapturedConfig>,
                );
              }),
            ).rejects.toMatchObject({
              code: "23514",
              constraint: "run_execution_configs_shape_check",
            });
          }

          for (const requiredField of Object.keys(
            standardConfig,
          ) as Array<keyof CapturedConfig>) {
            await expect(
              inCommittedTransaction(client, async () => {
                const run = await insertRootRun(client, "queued");
                await insertCapturedConfig(client, run.runId, {
                  [requiredField]: null,
                } as unknown as Partial<CapturedConfig>);
              }),
            ).rejects.toMatchObject({
              code: "23514",
              constraint: "run_execution_configs_shape_check",
            });
          }

          await expect(
            inCommittedTransaction(client, async () => {
              const run = await insertRootRun(client, "queued");
              await insertCapturedConfig(client, run.runId, {
                reservationCredits: 101,
              });
            }),
          ).rejects.toMatchObject({ code: "23514" });

          const immutable = await inCommittedTransaction(client, async () => {
            const run = await insertRootRun(client, "failed");
            await insertCapturedConfig(client, run.runId);
            return run;
          });
          await expect(
            client.query(
              "UPDATE run_execution_configs SET model = model WHERE run_id = $1",
              [immutable.runId],
            ),
          ).rejects.toMatchObject({ code: "23514" });
          await expect(
            client.query(
              "DELETE FROM run_execution_configs WHERE run_id = $1",
              [immutable.runId],
            ),
          ).rejects.toMatchObject({ code: "23514" });

          const cascaded = await inCommittedTransaction(client, async () => {
            const run = await insertRootRun(client, "failed");
            await insertCapturedConfig(client, run.runId);
            return run;
          });
          await expect(
            client.query("DELETE FROM conversations WHERE id = $1", [
              cascaded.conversationId,
            ]),
          ).resolves.toBeDefined();
          const cascadeCount = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM run_execution_configs WHERE run_id = $1",
            [cascaded.runId],
          );
          expect(cascadeCount.rows[0].count).toBe("0");

          const retrySource = await inCommittedTransaction(client, async () => {
            const run = await insertRootRun(client, "failed");
            await insertCapturedConfig(client, run.runId);
            return run;
          });
          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(client, retrySource, "retry"),
            ),
          ).resolves.toBeTypeOf("string");

          const mismatchedRetrySource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "failed");
              await insertCapturedConfig(client, run.runId);
              return run;
            },
          );
          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(client, mismatchedRetrySource, "retry", {
                model: "different-model",
              }),
            ),
          ).rejects.toMatchObject({ code: "23514" });

          const regenerateSource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "completed");
              await insertCapturedConfig(client, run.runId);
              return run;
            },
          );
          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(client, regenerateSource, "regenerate"),
            ),
          ).resolves.toBeTypeOf("string");

          const mismatchedRegenerateSource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "completed");
              await insertCapturedConfig(client, run.runId);
              return run;
            },
          );
          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(
                client,
                mismatchedRegenerateSource,
                "regenerate",
                { creditsPerWebSearch: 11 },
              ),
            ),
          ).rejects.toMatchObject({ code: "23514" });

          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(client, legacyFailed, "retry"),
            ),
          ).rejects.toMatchObject({ code: "23514" });

          await expect(client.query(assertion027)).resolves.toBeDefined();
          await expect(client.query(assertion027)).resolves.toBeDefined();
        },
      );
    });
  },
);

describe.runIf(databaseUrl !== undefined)(
  "028 reasoning.mode capability migration",
  () => {
    it("preserves v1 and legacy semantics while enforcing v2 capability compatibility", async () => {
      await withSchemaBefore027(
        async ({
          assertion027,
          assertion028,
          client,
          migration027,
          migration028,
        }) => {
          const legacy = await inCommittedTransaction(client, () =>
            insertRootRun(client, "completed"),
          );
          await client.query(migration027);
          await expect(client.query(assertion027)).resolves.toBeDefined();

          const capturedV1 = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "queued");
              await insertCapturedConfig(client, run.runId);
              return run;
            },
          );

          await expect(client.query(migration028)).resolves.toBeDefined();
          const migrated = await client.query<{
            provenance: string;
            reasoning_mode_enabled: boolean | null;
            run_id: string;
            snapshot_version: number | null;
          }>(
            `
              SELECT
                run_id,
                provenance,
                snapshot_version,
                reasoning_mode_enabled
              FROM run_execution_configs
              WHERE run_id = ANY($1::uuid[])
              ORDER BY run_id
            `,
            [[legacy.runId, capturedV1.runId]],
          );
          expect(migrated.rows).toEqual(
            [
              {
                run_id: legacy.runId,
                provenance: "legacy_unknown",
                snapshot_version: null,
                reasoning_mode_enabled: null,
              },
              {
                run_id: capturedV1.runId,
                provenance: "captured",
                snapshot_version: 1,
                reasoning_mode_enabled: true,
              },
            ].sort((left, right) => left.run_id.localeCompare(right.run_id)),
          );

          await expect(
            inCommittedTransaction(client, async () => {
              const run = await insertRootRun(client, "queued");
              await insertCapturedConfigAfter028(client, run.runId, {
                snapshotVersion: 1,
                reasoningModeEnabled: false,
              });
            }),
          ).rejects.toMatchObject({
            code: "23514",
            constraint: "run_execution_configs_shape_check",
          });

          const capturedAfter028: Array<{
            run: RootRunFixture;
            snapshotVersion: 1 | 2;
            reasoningModeEnabled: boolean;
          }> = [];
          for (const fixture of [
            { snapshotVersion: 1 as const, reasoningModeEnabled: true },
            { snapshotVersion: 2 as const, reasoningModeEnabled: false },
            { snapshotVersion: 2 as const, reasoningModeEnabled: true },
          ]) {
            const run = await inCommittedTransaction(client, async () => {
              const created = await insertRootRun(client, "queued");
              await insertCapturedConfigAfter028(
                client,
                created.runId,
                fixture,
              );
              return created;
            });
            capturedAfter028.push({ run, ...fixture });
          }
          const insertedCapabilities = await client.query<{
            reasoning_mode_enabled: boolean;
            run_id: string;
            snapshot_version: number;
          }>(
            `
              SELECT run_id, snapshot_version, reasoning_mode_enabled
              FROM run_execution_configs
              WHERE run_id = ANY($1::uuid[])
              ORDER BY run_id
            `,
            [capturedAfter028.map(({ run }) => run.runId)],
          );
          expect(insertedCapabilities.rows).toEqual(
            capturedAfter028
              .map(({ run, snapshotVersion, reasoningModeEnabled }) => ({
                run_id: run.runId,
                snapshot_version: snapshotVersion,
                reasoning_mode_enabled: reasoningModeEnabled,
              }))
              .sort((left, right) => left.run_id.localeCompare(right.run_id)),
          );

          const matchingRetrySource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "failed");
              await insertCapturedConfigAfter028(client, run.runId, {
                reasoningModeEnabled: true,
              });
              return run;
            },
          );
          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(client, matchingRetrySource, "retry", {
                reasoningModeEnabled: true,
              }),
            ),
          ).resolves.toBeTypeOf("string");

          const mismatchedRetrySource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "failed");
              await insertCapturedConfigAfter028(client, run.runId, {
                reasoningModeEnabled: true,
              });
              return run;
            },
          );
          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(client, mismatchedRetrySource, "retry", {
                reasoningModeEnabled: false,
              }),
            ),
          ).rejects.toMatchObject({ code: "23514" });

          const mismatchedRegenerateSource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "completed");
              await insertCapturedConfigAfter028(client, run.runId, {
                reasoningModeEnabled: false,
              });
              return run;
            },
          );
          await expect(
            inCommittedTransaction(client, () =>
              insertAttempt(
                client,
                mismatchedRegenerateSource,
                "regenerate",
                { reasoningModeEnabled: true },
              ),
            ),
          ).rejects.toMatchObject({ code: "23514" });

          await expect(client.query(assertion028)).resolves.toBeDefined();
          await expect(client.query(assertion028)).resolves.toBeDefined();
        },
      );
    });

    it("keeps pre-028 chat, retry, and regenerate request IDs strictly idempotent", async () => {
      await withSchemaBefore027(
        async ({ client, migration027, migration028, schemaName }) => {
          await client.query(migration027);

          const chatRun = await inCommittedTransaction(client, async () => {
            const run = await insertRootRun(client, "queued");
            await insertCapturedConfig(client, run.runId);
            return run;
          });
          const chatRequestId = await client.query<{ request_id: string }>(
            "SELECT request_id FROM runs WHERE id = $1",
            [chatRun.runId],
          );
          const chatRequest: ChatRequest = {
            kind: "append",
            conversationId: chatRun.conversationId,
            parentRunId: null,
            message: "execution configuration fixture input",
            attachmentIds: [],
            requestId: chatRequestId.rows[0].request_id,
            executionProfileId: "standard_research",
          };
          const historicalChatFingerprint = chatFingerprintBefore028(
            chatRequest,
            standardConfig,
          );
          await client.query(
            "UPDATE runs SET request_fingerprint = $2 WHERE id = $1",
            [chatRun.runId, historicalChatFingerprint],
          );

          const retrySource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "failed");
              await insertCapturedConfig(client, run.runId);
              return run;
            },
          );
          const retryRunId = await inCommittedTransaction(client, () =>
            insertAttempt(client, retrySource, "retry"),
          );
          const retryRequest = await client.query<{ request_id: string }>(
            "SELECT request_id FROM runs WHERE id = $1",
            [retryRunId],
          );
          await client.query(
            "UPDATE runs SET request_fingerprint = $2 WHERE id = $1",
            [
              retryRunId,
              attemptFingerprintBefore028("retry", retrySource.runId),
            ],
          );

          const regenerateSource = await inCommittedTransaction(
            client,
            async () => {
              const run = await insertRootRun(client, "completed");
              await insertCapturedConfig(client, run.runId);
              return run;
            },
          );
          const regenerateRunId = await inCommittedTransaction(client, () =>
            insertAttempt(client, regenerateSource, "regenerate"),
          );
          const regenerateRequest = await client.query<{
            request_id: string;
          }>("SELECT request_id FROM runs WHERE id = $1", [regenerateRunId]);
          await client.query(
            "UPDATE runs SET request_fingerprint = $2 WHERE id = $1",
            [
              regenerateRunId,
              attemptFingerprintBefore028(
                "regenerate",
                regenerateSource.runId,
              ),
            ],
          );

          await client.query(migration028);
          const persistedFingerprints = await client.query<{
            id: string;
            request_fingerprint: string;
          }>(
            `
              SELECT id, request_fingerprint
              FROM runs
              WHERE id = ANY($1::uuid[])
              ORDER BY id
            `,
            [[chatRun.runId, retryRunId, regenerateRunId]],
          );
          expect(persistedFingerprints.rows).toEqual(
            [
              {
                id: chatRun.runId,
                request_fingerprint: historicalChatFingerprint,
              },
              {
                id: retryRunId,
                request_fingerprint: attemptFingerprintBefore028(
                  "retry",
                  retrySource.runId,
                ),
              },
              {
                id: regenerateRunId,
                request_fingerprint: attemptFingerprintBefore028(
                  "regenerate",
                  regenerateSource.runId,
                ),
              },
            ].sort((left, right) => left.id.localeCompare(right.id)),
          );
          if (databaseUrl === undefined) {
            throw new TypeError("TEST_DATABASE_URL is required");
          }
          const postMigrationUrl = new URL(databaseUrl);
          postMigrationUrl.searchParams.set(
            "options",
            `-c search_path=${schemaName},public`,
          );
          const postMigrationDatabase = new Pool({
            connectionString: postMigrationUrl.toString(),
            max: 1,
          });
          try {
            const currentChatExecutionConfig = applicationConfigAfter028({
              ...standardConfig,
              snapshotVersion: 2,
              provider: "sharesub",
              baseUrl: "https://share.underelay.com/v1",
              model: "post-028-model",
              reasoningModeEnabled: false,
              creditsPer1kInputTokens: 3,
              creditsPer1kOutputTokens: 9,
              creditsPerWebSearch: 15,
            });
            await expect(
              enqueueChatRun(
                {
                  userId: chatRun.userId,
                  request: chatRequest,
                  executionConfig: currentChatExecutionConfig,
                  maxAttachmentCount: 5,
                  maxAttachmentTotalBytes: 20 * 1024 * 1024,
                },
                postMigrationDatabase,
              ),
            ).resolves.toMatchObject({ run: { id: chatRun.runId } });

            for (const mismatchedRequest of [
              { ...chatRequest, message: "different logical request" },
              { ...chatRequest, conversationId: randomUUID() },
              { ...chatRequest, parentRunId: randomUUID() },
              { ...chatRequest, attachmentIds: [randomUUID()] },
            ] satisfies ChatRequest[]) {
              await expect(
                enqueueChatRun(
                  {
                    userId: chatRun.userId,
                    request: mismatchedRequest,
                    executionConfig: currentChatExecutionConfig,
                    maxAttachmentCount: 5,
                    maxAttachmentTotalBytes: 20 * 1024 * 1024,
                  },
                  postMigrationDatabase,
                ),
              ).rejects.toMatchObject({
                code: "RUN_ALREADY_EXISTS",
                status: 409,
              });
            }

            const currentProExecutionConfig = {
              ...currentChatExecutionConfig,
              executionProfileId: "pro_research" as const,
              profileLabel: "Pro 深度研究",
              reasoningMode: "pro" as const,
              reasoningEffort: "high" as const,
              maxAgentTurns: 16,
            };
            await expect(
              enqueueChatRun(
                {
                  userId: chatRun.userId,
                  request: {
                    ...chatRequest,
                    executionProfileId: "pro_research",
                  },
                  executionConfig: currentProExecutionConfig,
                  maxAttachmentCount: 5,
                  maxAttachmentTotalBytes: 20 * 1024 * 1024,
                },
                postMigrationDatabase,
              ),
            ).rejects.toMatchObject({
              code: "RUN_ALREADY_EXISTS",
              status: 409,
            });

            await expect(
              retryAgentRun(
                {
                  userId: retrySource.userId,
                  sourceRunId: retrySource.runId,
                  requestId: retryRequest.rows[0].request_id,
                },
                postMigrationDatabase,
              ),
            ).resolves.toMatchObject({ run: { id: retryRunId } });
            await expect(
              regenerateAgentRun(
                {
                  userId: regenerateSource.userId,
                  sourceRunId: regenerateSource.runId,
                  requestId: regenerateRequest.rows[0].request_id,
                },
                postMigrationDatabase,
              ),
            ).resolves.toMatchObject({ run: { id: regenerateRunId } });
            await expect(
              retryAgentRun(
                {
                  userId: retrySource.userId,
                  sourceRunId: randomUUID(),
                  requestId: retryRequest.rows[0].request_id,
                },
                postMigrationDatabase,
              ),
            ).rejects.toMatchObject({
              code: "RUN_ALREADY_EXISTS",
              status: 409,
            });
            await expect(
              regenerateAgentRun(
                {
                  userId: regenerateSource.userId,
                  sourceRunId: randomUUID(),
                  requestId: regenerateRequest.rows[0].request_id,
                },
                postMigrationDatabase,
              ),
            ).rejects.toMatchObject({
              code: "RUN_ALREADY_EXISTS",
              status: 409,
            });
          } finally {
            await postMigrationDatabase.end();
          }
        },
      );
    });
  },
);
