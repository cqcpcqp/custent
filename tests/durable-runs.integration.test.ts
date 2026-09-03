import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentInputItem } from "@openai/agents";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { AgentRuntimeEvent } from "@/lib/agent";
import type {
  CapturedRunExecutionConfig,
  RunWorkerCapability,
} from "@/lib/contracts";
import {
  createCsvArtifact,
  createGenericCsvArtifact,
} from "@/lib/artifacts";
import {
  getCreditBalance,
  markRunReconciliationRequired,
} from "@/lib/credits";
import { saveResearchSnapshot } from "@/lib/research";

const authState = vi.hoisted(() => ({
  userId: "00000000-0000-4000-8000-000000000001",
}));
const environmentState = vi.hoisted(() => ({
  inputAttachmentDirectory: "",
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: () => authState.userId,
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    RUN_EVENT_POLL_MS: 5,
    CREDITS_PER_1K_INPUT_TOKENS: 1,
    CREDITS_PER_1K_OUTPUT_TOKENS: 5,
    CREDITS_PER_WEB_SEARCH: 10,
    INPUT_ATTACHMENT_DIR: environmentState.inputAttachmentDirectory,
  }),
}));

import { GET as getRunEvents } from "@/app/api/runs/[runId]/events/route";
import {
  closePool,
  finalizeSuccessfulChatRun,
} from "@/lib/db";
import {
  createInputAttachment,
  resolveStoredInputAttachmentPath,
  storeInputAttachment,
} from "@/lib/input-attachments";
import {
  AgentRunWorker,
  RunLeaseLostError,
  appendRunEvent,
  cancelAgentRun,
  claimNextRun as claimNextRunWithCapability,
  completeClaimedRun,
  enqueueChatRun,
  failClaimedRun,
  getAgentRun,
  markRunModelStarted,
  readRunEventBatch,
  recoverAbandonedRuns,
  regenerateAgentRun,
  renewRunLease,
  retryAgentRun,
} from "@/lib/runs";
import {
  readRunSessionSnapshot,
  writeRunSessionSnapshot,
} from "@/lib/runs/session-snapshots";
import { summarizeRunExecutionConfig } from "@/lib/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function capturedConfig(
  overrides: Partial<CapturedRunExecutionConfig> = {},
): CapturedRunExecutionConfig {
  return {
    provenance: "captured",
    snapshotVersion: 2,
    executionProfileId: "standard_research",
    profileLabel: "标准研究",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    reasoningMode: "standard",
    reasoningModeEnabled: false,
    reasoningEffort: "medium",
    reasoningSummary: "auto",
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
    maxAgentTurns: 8,
    billing: {
      policyVersion: 1,
      reservationCredits: 100,
      creditsPer1kInputTokens: 1,
      creditsPer1kOutputTokens: 5,
      creditsPerWebSearch: 10,
    },
    ...overrides,
  };
}

function runWorkerCapability(
  config: CapturedRunExecutionConfig = capturedConfig(),
): RunWorkerCapability {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoningMode: config.reasoningModeEnabled,
    codeInterpreter: false,
  };
}

function claimNextRun(
  input: Omit<
    Parameters<typeof claimNextRunWithCapability>[0],
    "capability"
  > & { capability?: RunWorkerCapability },
  database: Pool,
) {
  return claimNextRunWithCapability(
    {
      ...input,
      capability: input.capability ?? runWorkerCapability(),
    },
    database,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  description: string,
  milliseconds = 5_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function completeEvent(content: string): AgentRuntimeEvent {
  return {
    type: "complete",
    content,
    citations: [],
    artifacts: [],
    usage: {
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    webSearches: 0,
  };
}

function sseEventIds(payload: string): string[] {
  return Array.from(payload.matchAll(/^id: (\d+)$/gmu), (match) => match[1]);
}

describe.runIf(databaseUrl !== undefined)("durable agent runs", () => {
  let database: Pool;
  let currentUserId: string | null = null;

  beforeAll(async () => {
    database = new Pool({ connectionString: databaseUrl });
    environmentState.inputAttachmentDirectory = await mkdtemp(
      path.join(os.tmpdir(), "custent-durable-run-attachments-"),
    );
  });

  afterEach(async () => {
    if (currentUserId === null) {
      return;
    }
    await database.query("DELETE FROM artifacts WHERE user_id = $1", [
      currentUserId,
    ]);
    await database.query("DELETE FROM research_snapshots WHERE user_id = $1", [
      currentUserId,
    ]);
    await database.query("DELETE FROM credit_ledger WHERE user_id = $1", [
      currentUserId,
    ]);
    await database.query("DELETE FROM conversations WHERE user_id = $1", [
      currentUserId,
    ]);
    await database.query("DELETE FROM runs WHERE user_id = $1", [currentUserId]);
    await database.query("DELETE FROM input_attachments WHERE user_id = $1", [
      currentUserId,
    ]);
    await database.query(
      "DELETE FROM input_attachment_deletions WHERE user_id = $1",
      [currentUserId],
    );
    await database.query("DELETE FROM users WHERE id = $1", [currentUserId]);
    currentUserId = null;
  });

  afterAll(async () => {
    await database.end();
    await closePool();
    await rm(environmentState.inputAttachmentDirectory, {
      recursive: true,
      force: true,
    });
  });

  async function createUser(): Promise<string> {
    const userId = randomUUID();
    await database.query(
      "INSERT INTO users (id, name, available_credits) VALUES ($1, $2, 1000)",
      [userId, "Durable runs integration user"],
    );
    currentUserId = userId;
    authState.userId = userId;
    return userId;
  }

  async function enqueue(
    userId: string,
    message: string,
    requestId = randomUUID(),
    executionConfig = capturedConfig(),
  ) {
    return enqueueChatRun(
      {
        userId,
        request: {
          kind: "append",
          conversationId: null,
          parentRunId: null,
          message,
          attachmentIds: [],
          requestId,
          executionProfileId: "standard_research",
        },
        executionConfig,
        maxAttachmentCount: 5,
        maxAttachmentTotalBytes: 20 * 1024 * 1024,
      },
      database,
    );
  }

  async function enqueueInConversation(
    userId: string,
    conversationId: string,
    message: string,
    requestId = randomUUID(),
    targetDatabase: Pool = database,
  ) {
    const selected = await targetDatabase.query<{
      selected_run_id: string | null;
    }>(
      `
        SELECT selected_run_id
        FROM conversations
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `,
      [conversationId, userId],
    );
    if (selected.rowCount !== 1) {
      throw new Error("The enqueue target conversation is missing");
    }
    return enqueueChatRun(
      {
        userId,
        request: {
          kind: "append",
          conversationId,
          parentRunId: selected.rows[0].selected_run_id,
          message,
          attachmentIds: [],
          requestId,
          executionProfileId: "standard_research",
        },
        executionConfig: capturedConfig(),
        maxAttachmentCount: 5,
        maxAttachmentTotalBytes: 20 * 1024 * 1024,
      },
      targetDatabase,
    );
  }

  async function completeClaim(
    claim: NonNullable<Awaited<ReturnType<typeof claimNextRun>>>,
    targetDatabase: Pool = database,
  ) {
    return completeClaimedRun(
      {
        lease: {
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
        },
        userId: claim.userId,
        conversationId: claim.run.conversationId,
        assistantMessageId: claim.run.assistantMessageId,
        content: `Completed ${claim.input}`,
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
        sessionItems: [],
      },
      targetDatabase,
    );
  }

  async function failClaim(
    claim: NonNullable<Awaited<ReturnType<typeof claimNextRun>>>,
    targetDatabase: Pool = database,
  ) {
    return failClaimedRun(
      {
        lease: {
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
        },
        errorName: "TestFailure",
        eventCode: "TEST_FAILURE",
        eventMessage: "The test Run failed before model start.",
      },
      targetDatabase,
    );
  }

  async function runOneSuccessfulWorker(content: string): Promise<void> {
    const logger = { error: vi.fn() };
    const processed = await new AgentRunWorker({
      runtimeFactory: {
        capability: runWorkerCapability(),
        forRun: () => ({
          async *run(): AsyncGenerator<AgentRuntimeEvent> {
            yield completeEvent(content);
          },
        }),
      },
      database,
      workerId: randomUUID(),
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 10_000,
      recoverAbandoned: false,
      logger,
    }).runOnce();
    expect(processed).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  }

  async function waitForDatabaseLock(applicationName: string): Promise<void> {
    await waitFor(
      async () => {
        const result = await database.query<{ blocked: boolean }>(
          `
            SELECT EXISTS (
              SELECT 1
              FROM pg_stat_activity
              WHERE application_name = $1 AND wait_event_type = 'Lock'
            ) AS blocked
          `,
          [applicationName],
        );
        return result.rows[0].blocked;
      },
      (blocked) => blocked,
      `${applicationName} to wait on a database lock`,
    );
  }

  function applicationPool(applicationName: string): Pool {
    return new Pool({
      connectionString: databaseUrl,
      application_name: applicationName,
      max: 1,
    });
  }

  it("enqueues atomically and returns the same run for a repeated request ID", async () => {
    const userId = await createUser();
    const requestId = randomUUID();
    const input = {
      userId,
      request: {
        kind: "append" as const,
        conversationId: null,
        parentRunId: null,
        message: "Find German pump buyers",
        attachmentIds: [],
        requestId,
        executionProfileId: "standard_research" as const,
      },
      executionConfig: capturedConfig(),
      maxAttachmentCount: 5,
      maxAttachmentTotalBytes: 20 * 1024 * 1024,
    };

    const [first, retry] = await Promise.all([
      enqueueChatRun(input, database),
      enqueueChatRun(input, database),
    ]);

    expect(retry).toEqual(first);
    expect(first.run.status).toBe("queued");
    expect(first.userMessage.runId).toBe(first.run.id);
    expect(first.run.executionConfig).toEqual(
      summarizeRunExecutionConfig(input.executionConfig),
    );
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 900,
      reserved: 100,
    });

    const proExecutionConfig = capturedConfig({
      executionProfileId: "pro_research",
      profileLabel: "Pro 深度研究",
      reasoningMode: "pro",
      reasoningEffort: "high",
      maxAgentTurns: 16,
    });
    await expect(
      enqueueChatRun(
        {
          ...input,
          request: {
            ...input.request,
            executionProfileId: "pro_research",
          },
          executionConfig: proExecutionConfig,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });

    const counts = await database.query<{
      conversations: number;
      runs: number;
      messages: number;
      reservations: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM conversations WHERE user_id = $1) AS conversations,
          (SELECT COUNT(*)::integer FROM runs WHERE user_id = $1) AS runs,
          (
            SELECT COUNT(*)::integer
            FROM messages message
            JOIN conversations conversation ON conversation.id = message.conversation_id
            WHERE conversation.user_id = $1
          ) AS messages,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger
            WHERE user_id = $1 AND entry_type = 'reserve'
          ) AS reservations
      `,
      [userId],
    );
    expect(counts.rows[0]).toEqual({
      conversations: 1,
      runs: 1,
      messages: 1,
      reservations: 1,
    });
  });

  it("commits the post-run snapshot, captured-rate settlement, and done event together", async () => {
    const userId = await createUser();
    const executionConfig = capturedConfig({
      billing: {
        policyVersion: 1,
        reservationCredits: 100,
        creditsPer1kInputTokens: 7,
        creditsPer1kOutputTokens: 11,
        creditsPerWebSearch: 13,
      },
    });
    const start = await enqueue(
      userId,
      "Persist this completed session",
      randomUUID(),
      executionConfig,
    );
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== start.run.id) {
      throw new Error("The post-snapshot source was not claimed");
    }
    const sessionItems = [
      { role: "user", content: "Persist this completed session" },
      {
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "The completed session was persisted." },
        ],
      },
    ] satisfies AgentInputItem[];

    const result = await completeClaimedRun(
      {
        lease: {
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
        },
        userId,
        conversationId: claim.run.conversationId,
        assistantMessageId: claim.run.assistantMessageId,
        content: "The completed session was persisted.",
        citations: [],
        usage: { inputTokens: 1_000, outputTokens: 1_000, webSearches: 1 },
        sessionItems,
      },
      database,
    );

    expect(result.kind).toBe("completed");
    await expect(
      readRunSessionSnapshot(claim.run.id, "post", database),
    ).resolves.toMatchObject({ items: sessionItems });
    expect(await getAgentRun(userId, claim.run.id, database)).toMatchObject({
      status: "completed",
    });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 969,
      reserved: 0,
    });
    const settlement = await database.query<{
      available_delta: number;
      charged_credits: number;
    }>(
      `
        SELECT run.charged_credits, ledger.available_delta
        FROM runs run
        JOIN credit_ledger ledger
          ON ledger.run_id = run.id AND ledger.entry_type = 'settle'
        WHERE run.id = $1
      `,
      [claim.run.id],
    );
    expect(settlement.rows[0]).toEqual({
      charged_credits: 31,
      available_delta: 69,
    });
    const events = await readRunEventBatch(
      { userId, runId: claim.run.id, afterEventId: "0" },
      database,
    );
    expect(events?.events.map((event) => event.payload.type)).toEqual([
      "done",
    ]);
  });

  it("lets a committed cancellation beat a late successful completion", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Cancel before completion commits");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== start.run.id) {
      throw new Error("The cancellation completion race source was not claimed");
    }
    const lease = {
      runId: claim.run.id,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
    };
    await markRunModelStarted(lease, database);

    const cancellation = await cancelAgentRun(userId, claim.run.id, database);
    expect(cancellation.status).toBe("running");

    const completion = await completeClaimedRun(
      {
        lease,
        userId,
        conversationId: claim.run.conversationId,
        assistantMessageId: claim.run.assistantMessageId,
        content: "This late answer must not be committed.",
        citations: [],
        usage: { inputTokens: 1, outputTokens: 1, webSearches: 0 },
        sessionItems: [
          { role: "user", content: "Cancel before completion commits" },
          {
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "This late answer must not be committed.",
              },
            ],
          },
        ],
      },
      database,
    );

    expect(completion).toEqual({
      kind: "reconciliation_required",
      credits: { available: 900, reserved: 100 },
    });
    expect(await getAgentRun(userId, claim.run.id, database)).toMatchObject({
      status: "reconciliation_required",
      failure: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
      },
    });
    await expect(
      readRunSessionSnapshot(claim.run.id, "post", database),
    ).resolves.toBeNull();

    const persisted = await database.query<{
      assistant_count: number;
      done_count: number;
      error_count: number;
      freeze_count: number;
      settle_count: number;
      available_credits: number;
      reserved_credits: number;
      frozen_credits: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM messages WHERE id = $2) AS assistant_count,
          (
            SELECT COUNT(*)::integer
            FROM run_events
            WHERE run_id = $1 AND event_type = 'done'
          ) AS done_count,
          (
            SELECT COUNT(*)::integer
            FROM run_events
            WHERE run_id = $1 AND event_type = 'error'
          ) AS error_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger
            WHERE run_id = $1 AND entry_type = 'freeze'
          ) AS freeze_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger
            WHERE run_id = $1 AND entry_type = 'settle'
          ) AS settle_count,
          available_credits,
          reserved_credits,
          frozen_credits
        FROM users
        WHERE id = $3
      `,
      [claim.run.id, claim.run.assistantMessageId, userId],
    );
    expect(persisted.rows[0]).toEqual({
      assistant_count: 0,
      done_count: 0,
      error_count: 1,
      freeze_count: 1,
      settle_count: 0,
      available_credits: 900,
      reserved_credits: 0,
      frozen_credits: 100,
    });
    const events = await readRunEventBatch(
      { userId, runId: claim.run.id, afterEventId: "0" },
      database,
    );
    expect(events?.events).toHaveLength(1);
    expect(events?.events[0].payload).toMatchObject({
      type: "error",
      error: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
        runId: claim.run.id,
      },
    });
  });

  it("rolls back finalization when the post-run snapshot is invalid", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Reject an invalid post snapshot");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== start.run.id) {
      throw new Error("The invalid post-snapshot source was not claimed");
    }
    const invalidSessionItems = [
      { role: "user", content: "Invalid", unexpected: true },
    ] as unknown as AgentInputItem[];

    await expect(
      completeClaimedRun(
        {
          lease: {
            runId: claim.run.id,
            leaseOwner: claim.leaseOwner,
            leaseToken: claim.leaseToken,
          },
          userId,
          conversationId: claim.run.conversationId,
          assistantMessageId: claim.run.assistantMessageId,
          content: "This completion must roll back.",
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
          sessionItems: invalidSessionItems,
        },
        database,
      ),
    ).rejects.toThrow("fields outside the AgentInputItem contract");

    expect(await getAgentRun(userId, claim.run.id, database)).toMatchObject({
      status: "running",
    });
    await expect(
      readRunSessionSnapshot(claim.run.id, "post", database),
    ).resolves.toBeNull();
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 900,
      reserved: 100,
    });
    const persisted = await database.query<{
      assistant_count: number;
      settlement_count: number;
      done_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM messages WHERE id = $2) AS assistant_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger
            WHERE run_id = $1 AND entry_type = 'settle'
          ) AS settlement_count,
          (
            SELECT COUNT(*)::integer
            FROM run_events
            WHERE run_id = $1 AND event_type = 'done'
          ) AS done_count
      `,
      [claim.run.id, claim.run.assistantMessageId],
    );
    expect(persisted.rows[0]).toEqual({
      assistant_count: 0,
      settlement_count: 0,
      done_count: 0,
    });
    await cancelAgentRun(userId, claim.run.id, database);
  });

  it("does not persist a post-run snapshot when completion requires reconciliation", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Force completion reconciliation");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== start.run.id) {
      throw new Error("The reconciliation source was not claimed");
    }

    const result = await completeClaimedRun(
      {
        lease: {
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
        },
        userId,
        conversationId: claim.run.conversationId,
        assistantMessageId: claim.run.assistantMessageId,
        content: "This answer must not be committed.",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 11 },
        sessionItems: [{ role: "user", content: "Must not persist" }],
      },
      database,
    );

    expect(result.kind).toBe("reconciliation_required");
    expect(await getAgentRun(userId, claim.run.id, database)).toMatchObject({
      status: "reconciliation_required",
      failure: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
      },
    });
    await expect(
      readRunSessionSnapshot(claim.run.id, "post", database),
    ).resolves.toBeNull();
    const persisted = await database.query<{
      assistant_count: number;
      done_count: number;
      error_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM messages WHERE id = $2) AS assistant_count,
          (
            SELECT COUNT(*)::integer
            FROM run_events
            WHERE run_id = $1 AND event_type = 'done'
          ) AS done_count,
          (
            SELECT COUNT(*)::integer
            FROM run_events
            WHERE run_id = $1 AND event_type = 'error'
          ) AS error_count
      `,
      [claim.run.id, claim.run.assistantMessageId],
    );
    expect(persisted.rows[0]).toEqual({
      assistant_count: 0,
      done_count: 0,
      error_count: 1,
    });
    const events = await readRunEventBatch(
      { userId, runId: claim.run.id, afterEventId: "0" },
      database,
    );
    expect(events?.events).toHaveLength(1);
    expect(events?.events[0].payload).toEqual({
      type: "error",
      error: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
        runId: claim.run.id,
      },
    });
  });

  it("creates and finalizes a generic artifact on a real claimed chat run", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Turn the current table into CSV");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== start.run.id) {
      throw new Error("The generic artifact run was not claimed");
    }

    const inputMessage = await database.query<{
      role: string;
      run_id: string | null;
    }>(
      "SELECT role, run_id FROM messages WHERE id = $1",
      [claim.run.inputMessageId],
    );
    expect(inputMessage.rows[0]).toEqual({
      role: "user",
      run_id: claim.run.id,
    });

    const artifact = await createGenericCsvArtifact(
      {
        userId,
        conversationId: claim.run.conversationId,
        messageId: null,
        runId: claim.run.id,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        storageDirectory: environmentState.inputAttachmentDirectory,
        request: {
          fileName: "current-table.csv",
          columns: ["company", "priority"],
          rows: [["Acme", "High"]],
        },
      },
      database,
    );
    await completeClaim(claim);

    const persisted = await database.query<{
      message_id: string | null;
      research_snapshot_id: string | null;
    }>(
      `
        SELECT message_id, research_snapshot_id
        FROM artifacts
        WHERE id = $1
      `,
      [artifact.id],
    );
    expect(persisted.rows[0]).toEqual({
      message_id: claim.run.assistantMessageId,
      research_snapshot_id: null,
    });
  });

  it("creates and finalizes a snapshot artifact on a real claimed chat run", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Research one buyer and export CSV");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== start.run.id) {
      throw new Error("The snapshot artifact run was not claimed");
    }
    const snapshot = await saveResearchSnapshot(
      {
        userId,
        conversationId: claim.run.conversationId,
        runId: claim.run.id,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        research: {
          title: "Claimed run buyer",
          querySummary: "A fixture saved through a real claimed Run.",
          limitations: "Integration fixture only.",
          companies: [
            {
              name: "Example GmbH",
              websiteUrl: "https://example.com",
              country: "Germany",
              companyType: "importer",
              relevanceSummary: "Integration fixture buyer.",
              contacts: [],
              evidence: [
                {
                  claim: "Fixture evidence.",
                  sourceUrl: "https://example.com/evidence",
                  sourceTitle: "Fixture evidence",
                  supports: "business_fit",
                },
              ],
            },
          ],
        },
      },
      database,
    );
    const artifact = await createCsvArtifact(
      {
        userId,
        conversationId: claim.run.conversationId,
        messageId: null,
        runId: claim.run.id,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        storageDirectory: environmentState.inputAttachmentDirectory,
        snapshot,
      },
      database,
    );
    await completeClaim(claim);

    const persisted = await database.query<{
      message_id: string | null;
      research_snapshot_id: string | null;
    }>(
      `
        SELECT message_id, research_snapshot_id
        FROM artifacts
        WHERE id = $1
      `,
      [artifact.id],
    );
    expect(persisted.rows[0]).toEqual({
      message_id: claim.run.assistantMessageId,
      research_snapshot_id: snapshot.id,
    });
  });

  it("queues later Turns as waiting and promotes only the direct successor after success", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "First Turn");
    const second = await enqueueInConversation(
      userId,
      first.conversation.id,
      "Second Turn",
    );
    const third = await enqueueInConversation(
      userId,
      first.conversation.id,
      "Third Turn",
    );

    expect(first.run).toMatchObject({
      status: "queued",
      conversationTurn: "1",
      attemptIndex: 1,
      predecessorRunId: null,
    });
    expect(second.run).toMatchObject({
      status: "waiting",
      conversationTurn: "2",
      attemptIndex: 1,
      predecessorRunId: first.run.id,
    });
    expect(third.run).toMatchObject({
      status: "waiting",
      conversationTurn: "3",
      attemptIndex: 1,
      predecessorRunId: second.run.id,
    });

    const firstClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (firstClaim === null || firstClaim.run.id !== first.run.id) {
      throw new Error("The first queued Turn was not claimed first");
    }
    await completeClaim(firstClaim);

    expect(await getAgentRun(userId, second.run.id, database)).toMatchObject({
      status: "queued",
    });
    expect(await getAgentRun(userId, third.run.id, database)).toMatchObject({
      status: "waiting",
    });

    const secondClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (secondClaim === null || secondClaim.run.id !== second.run.id) {
      throw new Error("The promoted second Turn was not claimed next");
    }
    await completeClaim(secondClaim);
    expect(await getAgentRun(userId, third.run.id, database)).toMatchObject({
      status: "queued",
    });

    const firstEvents = await readRunEventBatch(
      { userId, runId: first.run.id, afterEventId: "0" },
      database,
    );
    expect(firstEvents?.events.map((event) => event.payload.type)).toEqual([
      "done",
    ]);
    await cancelAgentRun(userId, third.run.id, database);
  });

  it("rejects a child Run before insertion or credit reservation when the completed parent has no post-run context", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Complete without a post snapshot");
    const firstClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (firstClaim === null || firstClaim.run.id !== first.run.id) {
      throw new Error("The contextless parent was not claimed");
    }
    await finalizeSuccessfulChatRun(
      {
        userId,
        conversationId: first.conversation.id,
        runId: first.run.id,
        assistantMessageId: first.run.assistantMessageId,
        content: "Completed without worker snapshot finalization",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
      },
      database,
    );
    await expect(
      readRunSessionSnapshot(first.run.id, "post", database),
    ).resolves.toBeNull();

    const requestId = randomUUID();
    const balanceBefore = await getCreditBalance(userId, database);
    await expect(
      enqueueInConversation(
        userId,
        first.conversation.id,
        "This child must not be persisted",
        requestId,
      ),
    ).rejects.toMatchObject({
      code: "RUN_CONTEXT_UNAVAILABLE",
      status: 409,
    });
    expect(await getCreditBalance(userId, database)).toEqual(balanceBefore);

    const sideEffects = await database.query<{
      message_count: number;
      reservation_count: number;
      run_count: number;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::integer
            FROM runs
            WHERE request_id = $1
          ) AS run_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger ledger
            JOIN runs run ON run.id = ledger.run_id
            WHERE run.request_id = $1 AND ledger.entry_type = 'reserve'
          ) AS reservation_count,
          (
            SELECT COUNT(*)::integer
            FROM messages
            WHERE
              conversation_id = $2
              AND role = 'user'
              AND content = 'This child must not be persisted'
          ) AS message_count
      `,
      [requestId, first.conversation.id],
    );
    expect(sideEffects.rows[0]).toEqual({
      run_count: 0,
      reservation_count: 0,
      message_count: 0,
    });
  });

  it("edits a non-root Turn as an immutable sibling using its completed parent's post-run context", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Completed parent for a child edit");
    const firstClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (firstClaim === null || firstClaim.run.id !== first.run.id) {
      throw new Error("The non-root edit parent was not claimed");
    }
    await completeClaim(firstClaim);
    await expect(
      readRunSessionSnapshot(first.run.id, "post", database),
    ).resolves.toMatchObject({ items: [] });

    const source = await enqueueInConversation(
      userId,
      first.conversation.id,
      "Original child prompt",
    );
    await cancelAgentRun(userId, source.run.id, database);
    const changedProfileRequestId = randomUUID();
    const changedProfileConfig = capturedConfig({
      executionProfileId: "pro_research",
      profileLabel: "Pro 深度研究",
      reasoningMode: "pro",
      reasoningEffort: "high",
      maxAgentTurns: 16,
    });
    await expect(
      enqueueChatRun(
        {
          userId,
          request: {
            kind: "edit",
            conversationId: first.conversation.id,
            parentRunId: first.run.id,
            sourceMessageId: source.userMessage.id,
            message: "Changed-profile edit",
            attachmentIds: [],
            requestId: changedProfileRequestId,
            executionProfileId: "pro_research",
          },
          executionConfig: changedProfileConfig,
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "INVALID_EDIT", status: 409 });
    const changedProfileSideEffects = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM runs WHERE request_id = $1",
      [changedProfileRequestId],
    );
    expect(changedProfileSideEffects.rows[0].count).toBe(0);
    const edited = await enqueueChatRun(
      {
        userId,
        request: {
          kind: "edit",
          conversationId: first.conversation.id,
          parentRunId: first.run.id,
          sourceMessageId: source.userMessage.id,
          message: "Edited child prompt",
          attachmentIds: [],
          requestId: randomUUID(),
          executionProfileId: "standard_research",
        },
        executionConfig: capturedConfig(),
        maxAttachmentCount: 5,
        maxAttachmentTotalBytes: 20 * 1024 * 1024,
      },
      database,
    );

    expect(edited.run).toMatchObject({
      status: "queued",
      conversationTurn: "2",
      attemptIndex: 1,
      predecessorRunId: first.run.id,
    });
    expect(edited.run.id).not.toBe(source.run.id);
    expect(edited.userMessage.id).not.toBe(source.userMessage.id);
    expect(edited.conversation.selectedRunId).toBe(edited.run.id);
    const siblingTurns = await database.query<{
      content: string;
      id: string;
      input_message_id: string;
      status: string;
    }>(
      `
        SELECT run.id, run.input_message_id, run.status, message.content
        FROM runs run
        JOIN messages message ON message.id = run.input_message_id
        WHERE run.conversation_id = $1 AND run.conversation_turn = 2
        ORDER BY run.created_at, run.id
      `,
      [first.conversation.id],
    );
    expect(siblingTurns.rows).toEqual([
      {
        id: source.run.id,
        input_message_id: source.userMessage.id,
        status: "cancelled",
        content: "Original child prompt",
      },
      {
        id: edited.run.id,
        input_message_id: edited.userMessage.id,
        status: "queued",
        content: "Edited child prompt",
      },
    ]);
    await cancelAgentRun(userId, edited.run.id, database);
  });

  it.each(["failed", "cancelled"] as const)(
    "reconstructs an unstarted root %s Run's missing pre-context and retries idempotently",
    async (terminalStatus) => {
      const userId = await createUser();
      const source = await enqueue(userId, `Missing pre snapshot: ${terminalStatus}`);
      if (terminalStatus === "failed") {
        const claim = await claimNextRun(
          { workerId: randomUUID(), leaseDurationMs: 10_000 },
          database,
        );
        if (claim === null || claim.run.id !== source.run.id) {
          throw new Error("The contextless retry source was not claimed");
        }
        await failClaim(claim);
      } else {
        await cancelAgentRun(userId, source.run.id, database);
      }
      await expect(
        readRunSessionSnapshot(source.run.id, "pre", database),
      ).resolves.toBeNull();

      const requestId = randomUUID().toUpperCase();
      const [retried, idempotent] = await Promise.all([
        retryAgentRun(
          {
            userId: userId.toUpperCase(),
            sourceRunId: source.run.id.toUpperCase(),
            requestId,
          },
          database,
        ),
        retryAgentRun(
          {
            userId,
            sourceRunId: source.run.id,
            requestId: requestId.toLowerCase(),
          },
          database,
        ),
      ]);
      expect(idempotent).toEqual(retried);
      expect(retried.run).toMatchObject({
        status: "queued",
        conversationTurn: "1",
        attemptIndex: 2,
        predecessorRunId: null,
        retryOfRunId: source.run.id,
        inputMessageId: source.run.inputMessageId,
      });
      expect(retried.run.assistantMessageId).not.toBe(
        source.run.assistantMessageId,
      );
      await expect(
        readRunSessionSnapshot(source.run.id, "pre", database),
      ).resolves.toMatchObject({ items: [] });
      expect(await getCreditBalance(userId, database)).toEqual({
        available: 900,
        reserved: 100,
      });

      const sideEffects = await database.query<{
        reservation_count: number;
        run_count: number;
      }>(
        `
          SELECT
            (
              SELECT COUNT(*)::integer
              FROM runs
              WHERE request_id = $1
            ) AS run_count,
            (
              SELECT COUNT(*)::integer
              FROM credit_ledger ledger
              JOIN runs run ON run.id = ledger.run_id
              WHERE run.request_id = $1 AND ledger.entry_type = 'reserve'
            ) AS reservation_count
        `,
        [requestId.toLowerCase()],
      );
      expect(sideEffects.rows[0]).toEqual({
        run_count: 1,
        reservation_count: 1,
      });

      await runOneSuccessfulWorker(`Retried ${terminalStatus} root`);
      expect(await getAgentRun(userId, retried.run.id, database)).toMatchObject({
        status: "completed",
      });
      expect(await getCreditBalance(userId, database)).toEqual({
        available: 1000,
        reserved: 0,
      });
      const ledger = await database.query<{
        entry_type: string;
        run_id: string;
      }>(
        `
          SELECT run_id, entry_type
          FROM credit_ledger
          WHERE run_id IN ($1, $2)
          ORDER BY run_id, entry_type
        `,
        [source.run.id, retried.run.id],
      );
      expect(ledger.rows).toHaveLength(4);
      expect(ledger.rows).toEqual(
        expect.arrayContaining([
          { run_id: source.run.id, entry_type: "reserve" },
          { run_id: source.run.id, entry_type: "release" },
          { run_id: retried.run.id, entry_type: "reserve" },
          { run_id: retried.run.id, entry_type: "settle" },
        ]),
      );
    },
  );

  it("retries the latest failed attempt idempotently and rewires its waiting successor", async () => {
    const userId = await createUser();
    const sourceExecutionConfig = capturedConfig({
      provider: "sharesub",
      baseUrl: "https://share.underelay.com/v1",
      model: "retry-source-model",
      reasoningModeEnabled: true,
      billing: {
        policyVersion: 1,
        reservationCredits: 100,
        creditsPer1kInputTokens: 2,
        creditsPer1kOutputTokens: 3,
        creditsPerWebSearch: 4,
      },
    });
    const first = await enqueue(
      userId,
      "Retry this Turn",
      randomUUID(),
      sourceExecutionConfig,
    );
    const successor = await enqueueInConversation(
      userId,
      first.conversation.id,
      "Wait behind the retry",
    );
    const firstClaim = await claimNextRun(
      {
        workerId: randomUUID(),
        leaseDurationMs: 10_000,
        capability: runWorkerCapability(sourceExecutionConfig),
      },
      database,
    );
    if (firstClaim === null || firstClaim.run.id !== first.run.id) {
      throw new Error("The retry source was not claimed");
    }
    const authoritativeSourcePre = [
      { role: "user", content: "Authoritative inherited root context" },
    ] satisfies AgentInputItem[];
    await writeRunSessionSnapshot(
      first.run.id,
      "pre",
      authoritativeSourcePre,
      database,
    );
    await failClaim(firstClaim);
    expect(await getAgentRun(userId, successor.run.id, database)).toMatchObject({
      status: "waiting",
      predecessorRunId: first.run.id,
    });

    const sourceBeforeRetry = await database.query<{
      event_count: number;
      ledger_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM run_events WHERE run_id = $1) AS event_count,
          (SELECT COUNT(*)::integer FROM credit_ledger WHERE run_id = $1) AS ledger_count
      `,
      [first.run.id],
    );
    const requestId = randomUUID().toUpperCase();
    const [retried, idempotent] = await Promise.all([
      retryAgentRun(
        {
          userId: userId.toUpperCase(),
          sourceRunId: first.run.id.toUpperCase(),
          requestId,
        },
        database,
      ),
      retryAgentRun(
        {
          userId,
          sourceRunId: first.run.id,
          requestId: requestId.toLowerCase(),
        },
        database,
      ),
    ]);

    expect(idempotent).toEqual(retried);
    expect(retried.run).toMatchObject({
      status: "queued",
      conversationTurn: "1",
      attemptIndex: 2,
      predecessorRunId: null,
      retryOfRunId: first.run.id,
      inputMessageId: first.run.inputMessageId,
    });
    expect(retried.run.executionConfig).toEqual(
      summarizeRunExecutionConfig(sourceExecutionConfig),
    );
    expect(retried.run.executionConfig).toEqual(first.run.executionConfig);
    expect(retried.run.assistantMessageId).not.toBe(
      first.run.assistantMessageId,
    );
    await expect(
      readRunSessionSnapshot(first.run.id, "pre", database),
    ).resolves.toMatchObject({ items: authoritativeSourcePre });
    expect(await getAgentRun(userId, successor.run.id, database)).toMatchObject({
      status: "waiting",
      predecessorRunId: retried.run.id,
    });
    await expect(
      retryAgentRun(
        {
          userId,
          sourceRunId: successor.run.id,
          requestId: requestId.toLowerCase(),
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    const sourceAfterRetry = await database.query<{
      event_count: number;
      ledger_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM run_events WHERE run_id = $1) AS event_count,
          (SELECT COUNT(*)::integer FROM credit_ledger WHERE run_id = $1) AS ledger_count
      `,
      [first.run.id],
    );
    expect(sourceAfterRetry.rows[0]).toEqual(sourceBeforeRetry.rows[0]);

    const retryClaim = await claimNextRun(
      {
        workerId: randomUUID(),
        leaseDurationMs: 10_000,
        capability: runWorkerCapability(sourceExecutionConfig),
      },
      database,
    );
    if (retryClaim === null || retryClaim.run.id !== retried.run.id) {
      throw new Error("The retry attempt was not claimable");
    }
    await completeClaim(retryClaim);
    expect(await getAgentRun(userId, successor.run.id, database)).toMatchObject({
      status: "queued",
      predecessorRunId: retried.run.id,
    });
    await expect(
      retryAgentRun(
        {
          userId,
          sourceRunId: first.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_NOT_RETRYABLE", status: 409 });
    await cancelAgentRun(userId, successor.run.id, database);
  });

  it("regenerates the latest completed leaf idempotently from its pre-run context", async () => {
    const userId = await createUser();
    const sourceExecutionConfig = capturedConfig({
      provider: "sharesub",
      baseUrl: "https://share.underelay.com/v1",
      model: "regenerate-source-model",
      reasoningModeEnabled: true,
      billing: {
        policyVersion: 1,
        reservationCredits: 100,
        creditsPer1kInputTokens: 3,
        creditsPer1kOutputTokens: 7,
        creditsPerWebSearch: 11,
      },
    });
    const sourceStart = await enqueue(
      userId,
      "Regenerate this answer",
      randomUUID(),
      sourceExecutionConfig,
    );
    const sourceClaim = await claimNextRun(
      {
        workerId: randomUUID(),
        leaseDurationMs: 10_000,
        capability: runWorkerCapability(sourceExecutionConfig),
      },
      database,
    );
    if (sourceClaim === null || sourceClaim.run.id !== sourceStart.run.id) {
      throw new Error("The regenerate source was not claimed");
    }
    await completeClaim(sourceClaim);
    await database.query(
      `
        INSERT INTO run_session_snapshots (run_id, phase, item_count)
        VALUES ($1, 'pre', 0)
      `,
      [sourceStart.run.id],
    );

    const sourceBeforeRegenerate = await database.query<{
      event_count: number;
      ledger_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM run_events WHERE run_id = $1) AS event_count,
          (SELECT COUNT(*)::integer FROM credit_ledger WHERE run_id = $1) AS ledger_count
      `,
      [sourceStart.run.id],
    );
    const requestId = randomUUID().toUpperCase();
    const [regenerated, idempotent] = await Promise.all([
      regenerateAgentRun(
        {
          userId: userId.toUpperCase(),
          sourceRunId: sourceStart.run.id.toUpperCase(),
          requestId,
        },
        database,
      ),
      regenerateAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId: requestId.toLowerCase(),
        },
        database,
      ),
    ]);

    expect(idempotent).toEqual(regenerated);
    expect(regenerated.run).toMatchObject({
      status: "queued",
      conversationTurn: sourceStart.run.conversationTurn,
      attemptIndex: sourceStart.run.attemptIndex + 1,
      predecessorRunId: sourceStart.run.predecessorRunId,
      retryOfRunId: null,
      regenerateOfRunId: sourceStart.run.id,
      inputMessageId: sourceStart.run.inputMessageId,
    });
    expect(regenerated.run.executionConfig).toEqual(
      summarizeRunExecutionConfig(sourceExecutionConfig),
    );
    expect(regenerated.run.executionConfig).toEqual(
      sourceStart.run.executionConfig,
    );
    expect(regenerated.run.assistantMessageId).not.toBe(
      sourceStart.run.assistantMessageId,
    );
    expect(regenerated.credits).toEqual({ available: 900, reserved: 100 });
    const persisted = await database.query<{
      request_fingerprint: string;
      retry_of_run_id: string | null;
      regenerate_of_run_id: string | null;
    }>(
      `
        SELECT request_fingerprint, retry_of_run_id, regenerate_of_run_id
        FROM runs
        WHERE id = $1
      `,
      [regenerated.run.id],
    );
    expect(persisted.rows[0]).toEqual({
      request_fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            "custent.run-regenerate.v2",
            sourceStart.run.id,
            sourceExecutionConfig,
          ]),
          "utf8",
        )
        .digest("hex"),
      retry_of_run_id: null,
      regenerate_of_run_id: sourceStart.run.id,
    });
    const sourceAfterRegenerate = await database.query<{
      event_count: number;
      ledger_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM run_events WHERE run_id = $1) AS event_count,
          (SELECT COUNT(*)::integer FROM credit_ledger WHERE run_id = $1) AS ledger_count
      `,
      [sourceStart.run.id],
    );
    expect(sourceAfterRegenerate.rows[0]).toEqual(
      sourceBeforeRegenerate.rows[0],
    );

    await expect(
      regenerateAgentRun(
        {
          userId,
          sourceRunId: randomUUID(),
          requestId: requestId.toLowerCase(),
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    await expect(
      retryAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId: requestId.toLowerCase(),
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    await expect(
      regenerateAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_NOT_REGENERATABLE", status: 409 });
    await cancelAgentRun(userId, regenerated.run.id, database);
    await expect(
      regenerateAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_NOT_REGENERATABLE", status: 409 });
  });

  it("rejects regeneration when the durable pre-run context is unavailable", async () => {
    const userId = await createUser();
    const sourceStart = await enqueue(userId, "No saved pre-run context");
    await expect(
      regenerateAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({
      code: "RUN_NOT_REGENERATABLE",
      status: 409,
    });
    const sourceClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (sourceClaim === null || sourceClaim.run.id !== sourceStart.run.id) {
      throw new Error("The contextless regenerate source was not claimed");
    }
    await completeClaim(sourceClaim);

    await expect(
      regenerateAgentRun(
        {
          userId: randomUUID(),
          sourceRunId: sourceStart.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    await expect(
      regenerateAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({
      code: "RUN_CONTEXT_UNAVAILABLE",
      status: 409,
    });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 1000,
      reserved: 0,
    });
    const runs = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM runs WHERE user_id = $1",
      [userId],
    );
    expect(runs.rows[0].count).toBe(1);
  });

  it("rolls back the regenerate Run when its credit reservation fails", async () => {
    const userId = await createUser();
    const sourceStart = await enqueue(userId, "Regenerate only with credit");
    const sourceClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (sourceClaim === null || sourceClaim.run.id !== sourceStart.run.id) {
      throw new Error("The credit-check regenerate source was not claimed");
    }
    await completeClaim(sourceClaim);
    await database.query(
      `
        INSERT INTO run_session_snapshots (run_id, phase, item_count)
        VALUES ($1, 'pre', 0)
      `,
      [sourceStart.run.id],
    );
    const requestId = randomUUID();
    await database.query(
      "UPDATE users SET available_credits = 99 WHERE id = $1",
      [userId],
    );

    await expect(
      regenerateAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS", status: 402 });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 99,
      reserved: 0,
    });
    const rolledBack = await database.query<{
      run_count: number;
      reservation_count: number;
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::integer
            FROM runs
            WHERE user_id = $1 AND request_id = $2
          ) AS run_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger ledger
            JOIN runs run ON run.id = ledger.run_id
            WHERE
              run.user_id = $1
              AND run.request_id = $2
              AND ledger.entry_type = 'reserve'
          ) AS reservation_count
      `,
      [userId, requestId],
    );
    expect(rolledBack.rows[0]).toEqual({
      run_count: 0,
      reservation_count: 0,
    });

    await database.query(
      "UPDATE users SET available_credits = 1000 WHERE id = $1",
      [userId],
    );

    const regenerated = await regenerateAgentRun(
      {
        userId,
        sourceRunId: sourceStart.run.id,
        requestId,
      },
      database,
    );
    expect(regenerated.run.regenerateOfRunId).toBe(sourceStart.run.id);
    await cancelAgentRun(userId, regenerated.run.id, database);
  });

  it("rejects regeneration of a completed Run that has a later Turn", async () => {
    const userId = await createUser();
    const sourceStart = await enqueue(userId, "First completed answer");
    const sourceClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (sourceClaim === null || sourceClaim.run.id !== sourceStart.run.id) {
      throw new Error("The earlier regenerate source was not claimed");
    }
    await completeClaim(sourceClaim);
    await database.query(
      `
        INSERT INTO run_session_snapshots (run_id, phase, item_count)
        VALUES ($1, 'pre', 0)
      `,
      [sourceStart.run.id],
    );
    const later = await enqueueInConversation(
      userId,
      sourceStart.conversation.id,
      "A later Turn blocks regeneration",
    );

    await expect(
      regenerateAgentRun(
        {
          userId,
          sourceRunId: sourceStart.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({
      code: "RUN_NOT_REGENERATABLE",
      status: 409,
    });
    await cancelAgentRun(userId, later.run.id, database);
  });

  it("reconstructs a cancelled child's pre-context from its completed parent's post snapshot", async () => {
    const userId = await createUser();
    const parent = await enqueue(userId, "Parent with durable post context");
    const parentClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (parentClaim === null || parentClaim.run.id !== parent.run.id) {
      throw new Error("The completed parent was not claimed");
    }
    const parentPost = [
      { role: "user", content: "Parent with durable post context" },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Durable parent answer" }],
      },
    ] satisfies AgentInputItem[];
    await completeClaimedRun(
      {
        lease: {
          runId: parentClaim.run.id,
          leaseOwner: parentClaim.leaseOwner,
          leaseToken: parentClaim.leaseToken,
        },
        userId,
        conversationId: parent.run.conversationId,
        assistantMessageId: parent.run.assistantMessageId,
        content: "Durable parent answer",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
        sessionItems: parentPost,
      },
      database,
    );
    const child = await enqueueInConversation(
      userId,
      parent.conversation.id,
      "Cancelled child of completed parent",
    );
    expect(child.run.status).toBe("queued");
    await cancelAgentRun(userId, child.run.id, database);
    await expect(
      readRunSessionSnapshot(child.run.id, "pre", database),
    ).resolves.toBeNull();

    const retried = await retryAgentRun(
      {
        userId,
        sourceRunId: child.run.id,
        requestId: randomUUID(),
      },
      database,
    );
    expect(retried.run).toMatchObject({
      status: "queued",
      predecessorRunId: parent.run.id,
      retryOfRunId: child.run.id,
    });
    await expect(
      readRunSessionSnapshot(child.run.id, "pre", database),
    ).resolves.toMatchObject({ items: parentPost });

    await runOneSuccessfulWorker("Retried completed-parent child");
    expect(await getAgentRun(userId, retried.run.id, database)).toMatchObject({
      status: "completed",
    });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 1000,
      reserved: 0,
    });
  });

  it("keeps a cancelled child retry waiting behind its active parent and rewires descendants", async () => {
    const userId = await createUser();
    const parent = await enqueue(userId, "Active parent before child retry");
    const child = await enqueueInConversation(
      userId,
      parent.conversation.id,
      "Cancelled while waiting for parent",
    );
    const grandchild = await enqueueInConversation(
      userId,
      parent.conversation.id,
      "Wait behind the retried child",
    );
    const parentClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (parentClaim === null || parentClaim.run.id !== parent.run.id) {
      throw new Error("The active retry predecessor was not claimed");
    }
    await cancelAgentRun(userId, child.run.id, database);

    const requestId = randomUUID().toUpperCase();
    const [retried, idempotent] = await Promise.all([
      retryAgentRun(
        {
          userId,
          sourceRunId: child.run.id,
          requestId,
        },
        database,
      ),
      retryAgentRun(
        {
          userId: userId.toUpperCase(),
          sourceRunId: child.run.id.toUpperCase(),
          requestId: requestId.toLowerCase(),
        },
        database,
      ),
    ]);
    expect(idempotent).toEqual(retried);
    expect(retried.run).toMatchObject({
      status: "waiting",
      predecessorRunId: parent.run.id,
      retryOfRunId: child.run.id,
    });
    expect(await getAgentRun(userId, grandchild.run.id, database)).toMatchObject({
      status: "waiting",
      predecessorRunId: retried.run.id,
    });
    await expect(
      readRunSessionSnapshot(child.run.id, "pre", database),
    ).resolves.toBeNull();
    await expect(
      claimNextRun(
        { workerId: randomUUID(), leaseDurationMs: 10_000 },
        database,
      ),
    ).resolves.toBeNull();

    const parentPost = [
      { role: "user", content: "Active parent before child retry" },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Active parent finished" }],
      },
    ] satisfies AgentInputItem[];
    await completeClaimedRun(
      {
        lease: {
          runId: parentClaim.run.id,
          leaseOwner: parentClaim.leaseOwner,
          leaseToken: parentClaim.leaseToken,
        },
        userId,
        conversationId: parent.run.conversationId,
        assistantMessageId: parent.run.assistantMessageId,
        content: "Active parent finished",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
        sessionItems: parentPost,
      },
      database,
    );
    expect(await getAgentRun(userId, retried.run.id, database)).toMatchObject({
      status: "queued",
    });
    expect(await getAgentRun(userId, grandchild.run.id, database)).toMatchObject({
      status: "waiting",
    });

    await runOneSuccessfulWorker("Retried child completed");
    await expect(
      readRunSessionSnapshot(child.run.id, "pre", database),
    ).resolves.toMatchObject({ items: parentPost });
    expect(await getAgentRun(userId, retried.run.id, database)).toMatchObject({
      status: "completed",
    });
    expect(await getAgentRun(userId, grandchild.run.id, database)).toMatchObject({
      status: "queued",
      predecessorRunId: retried.run.id,
    });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 900,
      reserved: 100,
    });
    const ledgerCounts = await database.query<{
      release_count: number;
      reserve_count: number;
      settle_count: number;
    }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE entry_type = 'reserve')::integer AS reserve_count,
          COUNT(*) FILTER (WHERE entry_type = 'release')::integer AS release_count,
          COUNT(*) FILTER (WHERE entry_type = 'settle')::integer AS settle_count
        FROM credit_ledger
        WHERE user_id = $1
      `,
      [userId],
    );
    expect(ledgerCounts.rows[0]).toEqual({
      reserve_count: 4,
      release_count: 1,
      settle_count: 2,
    });
    await cancelAgentRun(userId, grandchild.run.id, database);
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 1000,
      reserved: 0,
    });
  });

  it("reparents an unstarted cancelled child and its waiting retry when the failed parent is retried", async () => {
    const userId = await createUser();
    const parent = await enqueue(userId, "Parent that fails before model start");
    const child = await enqueueInConversation(
      userId,
      parent.conversation.id,
      "Cancelled child whose retry must follow the parent retry",
    );
    const parentClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (parentClaim === null || parentClaim.run.id !== parent.run.id) {
      throw new Error("The lineage parent was not claimed");
    }
    await cancelAgentRun(userId, child.run.id, database);
    const childRetry = await retryAgentRun(
      {
        userId,
        sourceRunId: child.run.id,
        requestId: randomUUID(),
      },
      database,
    );
    expect(childRetry.run).toMatchObject({
      status: "waiting",
      predecessorRunId: parent.run.id,
      retryOfRunId: child.run.id,
    });
    await failClaim(parentClaim);
    expect(await getAgentRun(userId, childRetry.run.id, database)).toMatchObject({
      status: "waiting",
      predecessorRunId: parent.run.id,
    });

    const parentRetry = await retryAgentRun(
      {
        userId,
        sourceRunId: parent.run.id,
        requestId: randomUUID(),
      },
      database,
    );
    expect(parentRetry.run).toMatchObject({
      status: "queued",
      predecessorRunId: null,
      retryOfRunId: parent.run.id,
    });
    expect(parentRetry.conversation.selectedRunId).toBe(childRetry.run.id);
    expect(await getAgentRun(userId, child.run.id, database)).toMatchObject({
      status: "cancelled",
      predecessorRunId: parentRetry.run.id,
    });
    expect(await getAgentRun(userId, childRetry.run.id, database)).toMatchObject({
      status: "waiting",
      predecessorRunId: parentRetry.run.id,
    });
    await expect(
      readRunSessionSnapshot(child.run.id, "pre", database),
    ).resolves.toBeNull();

    await runOneSuccessfulWorker("Retried parent completed");
    expect(await getAgentRun(userId, parentRetry.run.id, database)).toMatchObject({
      status: "completed",
    });
    expect(await getAgentRun(userId, childRetry.run.id, database)).toMatchObject({
      status: "queued",
      predecessorRunId: parentRetry.run.id,
    });
    await runOneSuccessfulWorker("Waiting child retry completed");
    const retriedParentPost = await readRunSessionSnapshot(
      parentRetry.run.id,
      "post",
      database,
    );
    if (retriedParentPost === null) {
      throw new Error("The retried parent post snapshot is missing");
    }
    await expect(
      readRunSessionSnapshot(child.run.id, "pre", database),
    ).resolves.toMatchObject({ items: retriedParentPost.items });
    expect(await getAgentRun(userId, childRetry.run.id, database)).toMatchObject({
      status: "completed",
    });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 1000,
      reserved: 0,
    });
    const ledgerCounts = await database.query<{
      release_count: number;
      reserve_count: number;
      settle_count: number;
    }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE entry_type = 'reserve')::integer AS reserve_count,
          COUNT(*) FILTER (WHERE entry_type = 'release')::integer AS release_count,
          COUNT(*) FILTER (WHERE entry_type = 'settle')::integer AS settle_count
        FROM credit_ledger
        WHERE user_id = $1
      `,
      [userId],
    );
    expect(ledgerCounts.rows[0]).toEqual({
      reserve_count: 4,
      release_count: 2,
      settle_count: 2,
    });
  });

  it("rejects retry when a completed parent has no post snapshot without reserving credits", async () => {
    const userId = await createUser();
    const parent = await enqueue(userId, "Completed parent without post context");
    const child = await enqueueInConversation(
      userId,
      parent.conversation.id,
      "Cancelled child with unavailable parent context",
    );
    const parentClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (parentClaim === null || parentClaim.run.id !== parent.run.id) {
      throw new Error("The contextless parent was not claimed");
    }
    await cancelAgentRun(userId, child.run.id, database);
    await finalizeSuccessfulChatRun(
      {
        userId,
        conversationId: parent.conversation.id,
        runId: parent.run.id,
        assistantMessageId: parent.run.assistantMessageId,
        content: "Completed without a worker post snapshot",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
      },
      database,
    );
    await expect(
      readRunSessionSnapshot(parent.run.id, "post", database),
    ).resolves.toBeNull();

    const requestId = randomUUID();
    const balanceBefore = await getCreditBalance(userId, database);
    await expect(
      retryAgentRun(
        { userId, sourceRunId: child.run.id, requestId },
        database,
      ),
    ).rejects.toMatchObject({
      code: "RUN_CONTEXT_UNAVAILABLE",
      status: 409,
    });
    expect(await getCreditBalance(userId, database)).toEqual(balanceBefore);
    const sideEffects = await database.query<{
      reservation_count: number;
      run_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM runs WHERE request_id = $1) AS run_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger ledger
            JOIN runs run ON run.id = ledger.run_id
            WHERE run.request_id = $1 AND ledger.entry_type = 'reserve'
          ) AS reservation_count
      `,
      [requestId],
    );
    expect(sideEffects.rows[0]).toEqual({
      run_count: 0,
      reservation_count: 0,
    });
  });

  it("rejects missing pre-context after model start and does not expose it across owners", async () => {
    const userId = await createUser();
    const source = await enqueue(userId, "Historical model-started cancellation");
    await cancelAgentRun(userId, source.run.id, database);
    await database.query(
      "UPDATE runs SET model_started_at = now(), updated_at = now() WHERE id = $1",
      [source.run.id],
    );
    const balanceBefore = await getCreditBalance(userId, database);

    for (const retryUserId of [userId, randomUUID()]) {
      const requestId = randomUUID();
      await expect(
        retryAgentRun(
          { userId: retryUserId, sourceRunId: source.run.id, requestId },
          database,
        ),
      ).rejects.toMatchObject(
        retryUserId === userId
          ? { code: "RUN_CONTEXT_UNAVAILABLE", status: 409 }
          : { code: "NOT_FOUND", status: 404 },
      );
      const persisted = await database.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM runs WHERE request_id = $1",
        [requestId],
      );
      expect(persisted.rows[0].count).toBe(0);
    }
    expect(await getCreditBalance(userId, database)).toEqual(balanceBefore);
  });

  it("does not promote after cancellation or reconciliation and refunds a waiting Run once", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Hold the active slot");
    const waiting = await enqueueInConversation(
      userId,
      first.conversation.id,
      "Cancel while waiting",
    );

    await cancelAgentRun(userId, first.run.id, database);
    expect(await getAgentRun(userId, waiting.run.id, database)).toMatchObject({
      status: "waiting",
    });

    const cancelled = await cancelAgentRun(userId, waiting.run.id, database);
    const repeated = await cancelAgentRun(userId, waiting.run.id, database);
    expect(cancelled.status).toBe("cancelled");
    expect(repeated).toEqual(cancelled);
    const releases = await database.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM credit_ledger
        WHERE run_id = $1 AND entry_type = 'release'
      `,
      [waiting.run.id],
    );
    expect(releases.rows[0].count).toBe(1);
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 1000,
      reserved: 0,
    });

    const reconciliationHead = await enqueue(
      userId,
      "Requires reconciliation",
    );
    const reconciliationWaiting = await enqueueInConversation(
      userId,
      reconciliationHead.conversation.id,
      "Must remain waiting",
    );
    await markRunReconciliationRequired(
      {
        userId,
        runId: reconciliationHead.run.id,
        reason: "Provider usage is unknown",
      },
      database,
    );
    expect(
      await getAgentRun(userId, reconciliationWaiting.run.id, database),
    ).toMatchObject({ status: "waiting" });
    await expect(
      retryAgentRun(
        {
          userId,
          sourceRunId: reconciliationHead.run.id,
          requestId: randomUUID(),
        },
        database,
      ),
    ).rejects.toMatchObject({
      code: "RUN_REQUIRES_RECONCILIATION",
      status: 409,
    });
  });

  it("serializes concurrent enqueue and completion on the conversation lock", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Complete while enqueueing");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== first.run.id) {
      throw new Error("The concurrent completion source was not claimed");
    }

    const completionName = `queue-complete-${randomUUID()}`;
    const enqueueName = `queue-enqueue-${randomUUID()}`;
    const completionDatabase = applicationPool(completionName);
    const enqueueDatabase = applicationPool(enqueueName);
    const blocker = await database.connect();
    let blockerOpen = true;
    let completionPromise: Promise<unknown> | null = null;
    let enqueuePromise: ReturnType<typeof enqueueInConversation> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM conversations WHERE id = $1 FOR UPDATE",
        [first.conversation.id],
      );
      completionPromise = completeClaim(claim, completionDatabase);
      enqueuePromise = enqueueInConversation(
        userId,
        first.conversation.id,
        "Concurrent successor",
        randomUUID(),
        enqueueDatabase,
      );
      await Promise.all([
        waitForDatabaseLock(completionName),
        waitForDatabaseLock(enqueueName),
      ]);
      await blocker.query("COMMIT");
      blockerOpen = false;

      const [, successor] = await withTimeout(
        Promise.all([completionPromise, enqueuePromise]),
        "concurrent enqueue and completion",
      );
      expect(await getAgentRun(userId, first.run.id, database)).toMatchObject({
        status: "completed",
      });
      expect(await getAgentRun(userId, successor.run.id, database)).toMatchObject({
        status: "queued",
        predecessorRunId: first.run.id,
      });
      await cancelAgentRun(userId, successor.run.id, database);
    } finally {
      if (blockerOpen) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await Promise.allSettled([
        completionPromise ?? Promise.resolve(),
        enqueuePromise ?? Promise.resolve(),
      ]);
      await Promise.all([completionDatabase.end(), enqueueDatabase.end()]);
    }
  });

  it("rejects completion when the lease expires while waiting for the conversation lock", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Reject a late completion");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== first.run.id) {
      throw new Error("The lock-wait completion source was not claimed");
    }

    const completionName = `late-completion-${randomUUID()}`;
    const completionDatabase = applicationPool(completionName);
    const blocker = await database.connect();
    let blockerOpen = true;
    let completionPromise: Promise<unknown> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM conversations WHERE id = $1 FOR UPDATE",
        [first.conversation.id],
      );
      await database.query(
        "UPDATE runs SET lease_expires_at = clock_timestamp() + interval '500 milliseconds' WHERE id = $1",
        [claim.run.id],
      );
      completionPromise = completeClaim(claim, completionDatabase);
      await waitForDatabaseLock(completionName);
      await new Promise((resolve) => setTimeout(resolve, 650));
      await blocker.query("COMMIT");
      blockerOpen = false;

      await expect(
        withTimeout(completionPromise, "late completion after lease expiry"),
      ).rejects.toBeInstanceOf(RunLeaseLostError);
      await expect(
        getAgentRun(userId, claim.run.id, database),
      ).resolves.toMatchObject({ status: "running" });

      expect(await recoverAbandonedRuns({ maxRuns: 1 }, database)).toBe(1);
      await cancelAgentRun(userId, claim.run.id, database);
      expect(await getAgentRun(userId, claim.run.id, database)).toMatchObject({
        status: "cancelled",
      });
    } finally {
      if (blockerOpen) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await Promise.allSettled([completionPromise ?? Promise.resolve()]);
      await completionDatabase.end();
    }
  });

  it("serializes waiting cancellation against predecessor promotion", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Complete while cancelling");
    const waiting = await enqueueInConversation(
      userId,
      first.conversation.id,
      "Cancel during promotion",
    );
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== first.run.id) {
      throw new Error("The cancellation race predecessor was not claimed");
    }

    const completionName = `cancel-complete-${randomUUID()}`;
    const cancellationName = `cancel-waiting-${randomUUID()}`;
    const completionDatabase = applicationPool(completionName);
    const cancellationDatabase = applicationPool(cancellationName);
    const blocker = await database.connect();
    let blockerOpen = true;
    let completionPromise: Promise<unknown> | null = null;
    let cancellationPromise: ReturnType<typeof cancelAgentRun> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM conversations WHERE id = $1 FOR UPDATE",
        [first.conversation.id],
      );
      completionPromise = completeClaim(claim, completionDatabase);
      cancellationPromise = cancelAgentRun(
        userId,
        waiting.run.id,
        cancellationDatabase,
      );
      await Promise.all([
        waitForDatabaseLock(completionName),
        waitForDatabaseLock(cancellationName),
      ]);
      await blocker.query("COMMIT");
      blockerOpen = false;
      await withTimeout(
        Promise.all([completionPromise, cancellationPromise]),
        "waiting cancellation and predecessor promotion",
      );

      expect(await getAgentRun(userId, first.run.id, database)).toMatchObject({
        status: "completed",
      });
      expect(await getAgentRun(userId, waiting.run.id, database)).toMatchObject({
        status: "cancelled",
      });
      const releases = await database.query<{ count: number }>(
        `
          SELECT COUNT(*)::integer AS count
          FROM credit_ledger
          WHERE run_id = $1 AND entry_type = 'release'
        `,
        [waiting.run.id],
      );
      expect(releases.rows[0].count).toBe(1);
      expect(await getCreditBalance(userId, database)).toEqual({
        available: 1000,
        reserved: 0,
      });
    } finally {
      if (blockerOpen) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await Promise.allSettled([
        completionPromise ?? Promise.resolve(),
        cancellationPromise ?? Promise.resolve(),
      ]);
      await Promise.all([completionDatabase.end(), cancellationDatabase.end()]);
    }
  });

  it("serializes retry of a cancelled waiting Turn behind predecessor completion and reconstructs its context", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Complete while retrying");
    const waiting = await enqueueInConversation(
      userId,
      first.conversation.id,
      "Retry during promotion",
    );
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null || claim.run.id !== first.run.id) {
      throw new Error("The retry race predecessor was not claimed");
    }
    await cancelAgentRun(userId, waiting.run.id, database);

    const completionName = `retry-complete-${randomUUID()}`;
    const retryName = `retry-waiting-${randomUUID()}`;
    const completionDatabase = applicationPool(completionName);
    const retryDatabase = applicationPool(retryName);
    const blocker = await database.connect();
    let blockerOpen = true;
    let completionPromise: Promise<unknown> | null = null;
    let retryPromise: ReturnType<typeof retryAgentRun> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM conversations WHERE id = $1 FOR UPDATE",
        [first.conversation.id],
      );
      completionPromise = completeClaim(claim, completionDatabase);
      await waitForDatabaseLock(completionName);
      const retryRequestId = randomUUID();
      retryPromise = retryAgentRun(
        {
          userId,
          sourceRunId: waiting.run.id,
          requestId: retryRequestId,
        },
        retryDatabase,
      );
      await waitForDatabaseLock(retryName);
      await blocker.query("COMMIT");
      blockerOpen = false;
      await withTimeout(
        completionPromise,
        "predecessor completion ahead of waiting retry",
      );
      const retried = await withTimeout(
        retryPromise,
        "reconstructed waiting retry",
      );
      expect(retried.run).toMatchObject({
        status: "queued",
        predecessorRunId: first.run.id,
        retryOfRunId: waiting.run.id,
      });

      expect(await getAgentRun(userId, first.run.id, database)).toMatchObject({
        status: "completed",
      });
      expect(await getAgentRun(userId, waiting.run.id, database)).toMatchObject({
        status: "cancelled",
      });
      await expect(
        readRunSessionSnapshot(waiting.run.id, "pre", database),
      ).resolves.toMatchObject({ items: [] });
      const retryRuns = await database.query<{ count: number }>(
        "SELECT COUNT(*)::integer AS count FROM runs WHERE request_id = $1",
        [retryRequestId],
      );
      expect(retryRuns.rows[0].count).toBe(1);
      expect(await getCreditBalance(userId, database)).toEqual({
        available: 900,
        reserved: 100,
      });
      await cancelAgentRun(userId, retried.run.id, database);
    } finally {
      if (blockerOpen) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await Promise.allSettled([
        completionPromise ?? Promise.resolve(),
        retryPromise ?? Promise.resolve(),
      ]);
      await Promise.all([completionDatabase.end(), retryDatabase.end()]);
    }
  });

  it("lets the worker finish after the event client disconnects and replays from a cursor", async () => {
    const userId = await createUser();
    const started = deferred();
    const release = deferred();
    const stop = new AbortController();
    const logger = { error: vi.fn() };
    const start = await enqueue(userId, "Research an Italian distributor");
    const runtime = {
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        yield {
          type: "status",
          phase: "searching",
          message: "Searching public sources",
        };
        started.resolve();
        await release.promise;
        yield completeEvent("Research complete");
      },
    };
    const worker = new AgentRunWorker({
      runtimeFactory: {
        capability: runWorkerCapability(),
        forRun: () => runtime,
      },
      database,
      workerId: randomUUID(),
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 10_000,
      recoverAbandoned: false,
      logger,
    });
    const workerPromise = worker.run(stop.signal);

    try {
      await withTimeout(started.promise, "the worker runtime to start");
      const firstBatch = await waitFor(
        () =>
          readRunEventBatch(
            {
              userId,
              runId: start.run.id,
              afterEventId: "0",
            },
            database,
          ),
        (batch) => batch !== null && batch.events.length === 1,
        "the first persisted run event",
      );
      if (firstBatch === null) {
        throw new Error("Run disappeared while reading its first event");
      }

      const liveResponse = await getRunEvents(
        new Request(`http://localhost/api/runs/${start.run.id}/events`),
        { params: Promise.resolve({ runId: start.run.id }) },
      );
      expect(liveResponse.status).toBe(200);
      if (liveResponse.body === null) {
        throw new Error("Run event response did not include a stream");
      }
      const reader = liveResponse.body.getReader();
      const firstChunk = await withTimeout(
        reader.read(),
        "the first SSE event",
      );
      expect(new TextDecoder().decode(firstChunk.value)).toContain(
        `id: ${firstBatch.events[0].id}`,
      );
      await reader.cancel();

      release.resolve();
      const completedRun = await waitFor(
        () => getAgentRun(userId, start.run.id, database),
        (run) => run?.status === "completed",
        "the disconnected run to complete",
      );
      expect(completedRun?.status).toBe("completed");
      await expect(
        readRunSessionSnapshot(start.run.id, "pre", database),
      ).resolves.toMatchObject({ phase: "pre", items: [] });
      await expect(
        readRunSessionSnapshot(start.run.id, "post", database),
      ).resolves.toMatchObject({ phase: "post", items: [] });

      const completedBatch = await readRunEventBatch(
        { userId, runId: start.run.id, afterEventId: "0" },
        database,
      );
      if (completedBatch === null) {
        throw new Error("Completed run disappeared before replay");
      }
      expect(completedBatch.events.map((event) => event.payload.type)).toEqual([
        "status",
        "done",
      ]);

      const replayResponse = await getRunEvents(
        new Request(`http://localhost/api/runs/${start.run.id}/events`, {
          headers: { "Last-Event-ID": firstBatch.events[0].id },
        }),
        { params: Promise.resolve({ runId: start.run.id }) },
      );
      const replayPayload = await withTimeout(
        replayResponse.text(),
        "terminal event replay to close",
      );
      expect(sseEventIds(replayPayload)).toEqual([
        completedBatch.events[1].id,
      ]);

      const exhaustedReplay = await getRunEvents(
        new Request(`http://localhost/api/runs/${start.run.id}/events`, {
          headers: { "Last-Event-ID": completedBatch.events[1].id },
        }),
        { params: Promise.resolve({ runId: start.run.id }) },
      );
      await expect(
        withTimeout(exhaustedReplay.text(), "empty terminal replay to close"),
      ).resolves.toBe("");
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      stop.abort();
      await withTimeout(workerPromise, "the worker to stop");
    }
  });

  it("runs two conversations at the same time when concurrency is two", async () => {
    const userId = await createUser();
    const first = await enqueue(userId, "Research buyer A");
    const second = await enqueue(userId, "Research buyer B");
    const bothStarted = deferred();
    const release = deferred();
    const stop = new AbortController();
    const logger = { error: vi.fn() };
    let startedCount = 0;
    let activeCount = 0;
    let maximumActiveCount = 0;
    const runtime = {
      async *run(
        input: string,
      ): AsyncGenerator<AgentRuntimeEvent> {
        activeCount += 1;
        maximumActiveCount = Math.max(maximumActiveCount, activeCount);
        try {
          startedCount += 1;
          if (startedCount === 2) {
            bothStarted.resolve();
          }
          yield {
            type: "status",
            phase: "thinking",
            message: `Planning ${input}`,
          };
          await release.promise;
          yield completeEvent(`Completed ${input}`);
        } finally {
          activeCount -= 1;
        }
      },
    };
    const worker = new AgentRunWorker({
      runtimeFactory: {
        capability: runWorkerCapability(),
        forRun: () => runtime,
      },
      database,
      workerId: randomUUID(),
      concurrency: 2,
      pollIntervalMs: 5,
      leaseDurationMs: 10_000,
      recoverAbandoned: false,
      logger,
    });
    const workerPromise = worker.run(stop.signal);

    try {
      await withTimeout(bothStarted.promise, "both concurrent runs to start");
      expect(maximumActiveCount).toBe(2);
      release.resolve();
      await waitFor(
        async () =>
          Promise.all([
            getAgentRun(userId, first.run.id, database),
            getAgentRun(userId, second.run.id, database),
          ]),
        (runs) => runs.every((run) => run?.status === "completed"),
        "both concurrent runs to complete",
      );
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      stop.abort();
      await withTimeout(workerPromise, "the concurrent worker to stop");
    }
  });

  it("allows only one worker to claim a queued run", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Claim this run once");
    const claims = await Promise.all([
      claimNextRun(
        { workerId: randomUUID(), leaseDurationMs: 10_000 },
        database,
      ),
      claimNextRun(
        { workerId: randomUUID(), leaseDurationMs: 10_000 },
        database,
      ),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const claim = claims.find((value) => value !== null);
    if (claim === undefined || claim === null) {
      throw new Error("Neither worker claimed the queued run");
    }
    expect(claim.run.id).toBe(start.run.id);
    expect(claim.inputAttachmentIds).toEqual([]);
    await cancelAgentRun(userId, start.run.id, database);
  });

  it("leaves incompatible provider Runs queued for a capable Worker", async () => {
    const userId = await createUser();
    const sharesubConfig = capturedConfig({
      provider: "sharesub",
      baseUrl: "https://share.underelay.com/v1",
      model: "sharesub-test-model",
    });
    const sharesub = await enqueue(
      userId,
      "Sharesub capability Run",
      randomUUID(),
      sharesubConfig,
    );
    const openai = await enqueue(
      userId,
      "OpenAI capability Run",
    );

    const openaiClaim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    expect(openaiClaim?.run.id).toBe(openai.run.id);
    expect(await getAgentRun(userId, sharesub.run.id, database)).toMatchObject({
      status: "queued",
    });

    const sharesubClaim = await claimNextRun(
      {
        workerId: randomUUID(),
        leaseDurationMs: 10_000,
        capability: runWorkerCapability(sharesubConfig),
      },
      database,
    );
    expect(sharesubClaim?.run.id).toBe(sharesub.run.id);
    if (openaiClaim === null || sharesubClaim === null) {
      throw new Error("A capable Worker did not claim its queued Run");
    }
    await Promise.all([
      cancelAgentRun(userId, openaiClaim.run.id, database),
      cancelAgentRun(userId, sharesubClaim.run.id, database),
    ]);
  });

  it("claims only Runs compatible with the Worker's reasoning.mode capability", async () => {
    const userId = await createUser();
    const reasoningModeConfig = capturedConfig({
      reasoningModeEnabled: true,
    });
    const requiresReasoningMode = await enqueue(
      userId,
      "Requires reasoning mode capability",
      randomUUID(),
      reasoningModeConfig,
    );
    const omitsReasoningMode = await enqueue(
      userId,
      "Omits reasoning mode capability",
    );

    const incapableClaim = await claimNextRun(
      {
        workerId: randomUUID(),
        leaseDurationMs: 10_000,
        capability: {
          ...runWorkerCapability(),
          reasoningMode: false,
        },
      },
      database,
    );
    expect(incapableClaim?.run.id).toBe(omitsReasoningMode.run.id);
    expect(incapableClaim?.executionConfig.reasoningModeEnabled).toBe(false);
    expect(
      await getAgentRun(userId, requiresReasoningMode.run.id, database),
    ).toMatchObject({ status: "queued" });

    const capableClaim = await claimNextRun(
      {
        workerId: randomUUID(),
        leaseDurationMs: 10_000,
        capability: runWorkerCapability(reasoningModeConfig),
      },
      database,
    );
    expect(capableClaim?.run.id).toBe(requiresReasoningMode.run.id);
    expect(capableClaim?.executionConfig.reasoningModeEnabled).toBe(true);
    if (incapableClaim === null || capableClaim === null) {
      throw new Error("A reasoning-mode-compatible Worker did not claim its Run");
    }
    await Promise.all([
      cancelAgentRun(userId, incapableClaim.run.id, database),
      cancelAgentRun(userId, capableClaim.run.id, database),
    ]);
  });

  it("does not renew or revive an already expired lease", async () => {
    const userId = await createUser();
    await enqueue(userId, "Do not revive this expired lease");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null) {
      throw new Error("Worker did not claim the queued run");
    }
    const expiredAt = new Date(Date.now() - 60_000);
    const heartbeatAt = new Date(expiredAt.getTime() - 1_000);
    await database.query(
      `
        UPDATE runs
        SET lease_expires_at = $2, heartbeat_at = $3
        WHERE id = $1
      `,
      [claim.run.id, expiredAt, heartbeatAt],
    );

    await expect(
      renewRunLease(
        {
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
        },
        10_000,
        database,
      ),
    ).resolves.toEqual({ owned: false, cancelRequested: false });
    await expect(
      failClaimedRun(
        {
          lease: {
            runId: claim.run.id,
            leaseOwner: claim.leaseOwner,
            leaseToken: claim.leaseToken,
          },
          errorName: "AbortError",
        },
        database,
      ),
    ).rejects.toBeInstanceOf(RunLeaseLostError);

    const persisted = await database.query<{
      heartbeat_at: Date;
      lease_expires_at: Date;
    }>(
      `
        SELECT heartbeat_at, lease_expires_at
        FROM runs
        WHERE id = $1
      `,
      [claim.run.id],
    );
    expect(persisted.rows[0]).toEqual({
      heartbeat_at: heartbeatAt,
      lease_expires_at: expiredAt,
    });
  });

  it("keeps cancellation as the reconciliation reason for an expired lease", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Recover this cancelled lease");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null) {
      throw new Error("Worker did not claim the queued run");
    }
    const lease = {
      runId: claim.run.id,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
    };
    await markRunModelStarted(lease, database);
    await expect(
      cancelAgentRun(userId, claim.run.id, database),
    ).resolves.toMatchObject({ status: "running" });
    await database.query(
      "UPDATE runs SET lease_expires_at = now() - interval '1 millisecond' WHERE id = $1",
      [claim.run.id],
    );

    await expect(
      recoverAbandonedRuns({ maxRuns: 1 }, database),
    ).resolves.toBe(1);
    await expect(
      getAgentRun(userId, claim.run.id, database),
    ).resolves.toMatchObject({
      status: "reconciliation_required",
      failure: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
      },
    });
    const batch = await readRunEventBatch(
      { userId, runId: start.run.id, afterEventId: "0" },
      database,
    );
    expect(batch?.events.at(-1)?.payload).toEqual({
      type: "error",
      error: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
        runId: claim.run.id,
      },
    });
    const reconciliation = await database.query<{
      reconciliation_reason: string;
    }>("SELECT reconciliation_reason FROM runs WHERE id = $1", [claim.run.id]);
    expect(reconciliation.rows[0].reconciliation_reason).toBe(
      "Worker lease expired after cancellation was requested",
    );
  });

  it("finalizes cancellation immediately when the model-started lease is already expired", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Cancel this already abandoned lease");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null) {
      throw new Error("Worker did not claim the queued run");
    }
    const lease = {
      runId: claim.run.id,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
    };
    await markRunModelStarted(lease, database);
    await database.query(
      "UPDATE runs SET lease_expires_at = now() - interval '1 millisecond' WHERE id = $1",
      [claim.run.id],
    );

    const cancelled = await cancelAgentRun(userId, claim.run.id, database);
    const repeated = await cancelAgentRun(userId, claim.run.id, database);

    expect(cancelled).toMatchObject({
      status: "reconciliation_required",
      cancelRequestedAt: expect.any(String),
      failure: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
      },
    });
    expect(repeated).toEqual(cancelled);
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 900,
      reserved: 100,
    });
    const ledger = await database.query<{
      entry_type: string;
      count: number;
    }>(
      `
        SELECT entry_type, COUNT(*)::integer AS count
        FROM credit_ledger
        WHERE user_id = $1 AND run_id = $2
        GROUP BY entry_type
        ORDER BY entry_type
      `,
      [userId, claim.run.id],
    );
    expect(ledger.rows).toEqual([
      { entry_type: "freeze", count: 1 },
      { entry_type: "reserve", count: 1 },
    ]);
    const batch = await readRunEventBatch(
      { userId, runId: start.run.id, afterEventId: "0" },
      database,
    );
    expect(batch?.events.at(-1)?.payload).toEqual({
      type: "error",
      error: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
        runId: claim.run.id,
      },
    });
    const reconciliation = await database.query<{
      reconciliation_reason: string;
    }>("SELECT reconciliation_reason FROM runs WHERE id = $1", [claim.run.id]);
    expect(reconciliation.rows[0].reconciliation_reason).toBe(
      "Worker lease expired after cancellation was requested",
    );
  });

  it("finalizes cancellation when a model-started running run has no lease fields", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Cancel this lease-less run");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null) {
      throw new Error("Worker did not claim the queued run");
    }
    await markRunModelStarted(
      {
        runId: claim.run.id,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
      },
      database,
    );
    await database.query(
      `
        UPDATE runs
        SET lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE id = $1
      `,
      [claim.run.id],
    );

    const cancelled = await cancelAgentRun(userId, claim.run.id, database);
    expect(cancelled).toMatchObject({
      status: "reconciliation_required",
      failure: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
      },
    });
    expect(await getAgentRun(userId, claim.run.id, database)).toEqual(
      cancelled,
    );
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 900,
      reserved: 100,
    });
    const events = await readRunEventBatch(
      { userId, runId: start.run.id, afterEventId: "0" },
      database,
    );
    expect(events?.events.at(-1)?.payload).toMatchObject({
      type: "error",
      error: { code: "RUN_REQUIRES_RECONCILIATION", runId: claim.run.id },
    });
  });

  it("fences event and tool writes from an expired or replaced lease", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Create a fenced research snapshot");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null) {
      throw new Error("Worker did not claim the queued run");
    }
    const oldLease = {
      runId: claim.run.id,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
    };
    await appendRunEvent(
      oldLease,
      { type: "status", phase: "thinking", message: "Lease is active" },
      database,
    );
    await database.query(
      "UPDATE runs SET lease_expires_at = now() - interval '1 millisecond' WHERE id = $1",
      [claim.run.id],
    );

    await expect(
      appendRunEvent(
        oldLease,
        { type: "delta", text: "stale event" },
        database,
      ),
    ).rejects.toBeInstanceOf(RunLeaseLostError);
    await expect(
      saveResearchSnapshot(
        {
          userId,
          conversationId: start.conversation.id,
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
          research: {
            title: "Stale snapshot",
            querySummary: "The expired lease must not persist this snapshot.",
            limitations: "Lease fencing test.",
            companies: [
              {
                name: "Example GmbH",
                websiteUrl: "https://example.com",
                country: "Germany",
                companyType: "importer",
                relevanceSummary: "Test company.",
                contacts: [],
                evidence: [
                  {
                    claim: "Example evidence.",
                    sourceUrl: "https://example.com/evidence",
                    sourceTitle: "Evidence",
                    supports: "business_fit",
                  },
                ],
              },
            ],
          },
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const leaseOwner = randomUUID();
    const replacement = await database.query<{ lease_token: string }>(
      `
        UPDATE runs
        SET
          lease_owner = $2,
          lease_token = lease_token + 1,
          lease_expires_at = now() + interval '1 minute',
          heartbeat_at = now(),
          updated_at = now()
        WHERE id = $1 AND status = 'running'
        RETURNING lease_token::text
      `,
      [claim.run.id, leaseOwner],
    );
    const replacementLease = {
      runId: claim.run.id,
      leaseOwner,
      leaseToken: replacement.rows[0].lease_token,
    };

    await expect(
      appendRunEvent(
        oldLease,
        { type: "delta", text: "old token" },
        database,
      ),
    ).rejects.toBeInstanceOf(RunLeaseLostError);
    await expect(
      appendRunEvent(
        replacementLease,
        { type: "delta", text: "new token" },
        database,
      ),
    ).resolves.toMatchObject({ runId: claim.run.id });
    await cancelAgentRun(userId, claim.run.id, database);
  });

  it("fences tool side effects after cancellation is requested", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Cancel before persisting tool results");
    const claim = await claimNextRun(
      { workerId: randomUUID(), leaseDurationMs: 10_000 },
      database,
    );
    if (claim === null) {
      throw new Error("Worker did not claim the queued run");
    }
    const lease = {
      runId: claim.run.id,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
    };
    await markRunModelStarted(lease, database);

    const cancelled = await cancelAgentRun(userId, claim.run.id, database);
    expect(cancelled.status).toBe("running");

    await expect(
      saveResearchSnapshot(
        {
          userId,
          conversationId: start.conversation.id,
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
          research: {
            title: "Cancelled snapshot",
            querySummary: "This snapshot must not be persisted.",
            limitations: "Cancellation fence test.",
            companies: [
              {
                name: "Example GmbH",
                websiteUrl: "https://example.com",
                country: "Germany",
                companyType: "importer",
                relevanceSummary: "Test company.",
                contacts: [],
                evidence: [
                  {
                    claim: "Example evidence.",
                    sourceUrl: "https://example.com/evidence",
                    sourceTitle: "Evidence",
                    supports: "business_fit",
                  },
                ],
              },
            ],
          },
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      createGenericCsvArtifact(
        {
          userId,
          conversationId: start.conversation.id,
          messageId: null,
          runId: claim.run.id,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
          storageDirectory: environmentState.inputAttachmentDirectory,
          request: {
            fileName: "cancelled-output.csv",
            columns: ["company"],
            rows: [["Example GmbH"]],
          },
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const persisted = await database.query<{
      artifact_count: number;
      snapshot_count: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM artifacts WHERE run_id = $1) AS artifact_count,
          (
            SELECT COUNT(*)::integer
            FROM research_snapshots
            WHERE run_id = $1
          ) AS snapshot_count
      `,
      [claim.run.id],
    );
    expect(persisted.rows[0]).toEqual({
      artifact_count: 0,
      snapshot_count: 0,
    });
    expect(
      await readdir(path.join(environmentState.inputAttachmentDirectory, userId)),
    ).toEqual([]);

    const finalized = await failClaimedRun(
      {
        lease,
        errorName: "ToolPersistenceRejected",
        eventCode: "INTERNAL_ERROR",
        eventMessage: "This generic failure must not mask cancellation.",
      },
      database,
    );
    expect(finalized.status).toBe("reconciliation_required");
    const terminalEvents = await readRunEventBatch(
      { userId, runId: claim.run.id, afterEventId: "0" },
      database,
    );
    expect(terminalEvents?.events).toHaveLength(1);
    expect(terminalEvents?.events[0].payload).toEqual({
      type: "error",
      error: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "这次运行需要积分对账。",
        runId: claim.run.id,
      },
    });
    const reconciliation = await database.query<{
      reconciliation_reason: string;
    }>("SELECT reconciliation_reason FROM runs WHERE id = $1", [claim.run.id]);
    expect(reconciliation.rows[0].reconciliation_reason).toBe(
      "Agent run ended after cancellation was requested",
    );
  });

  it("cancels a queued run once and releases its reserved credits", async () => {
    const userId = await createUser();
    const start = await enqueue(userId, "Cancel before a worker starts");

    const cancelled = await cancelAgentRun(userId, start.run.id, database);
    const retry = await cancelAgentRun(userId, start.run.id, database);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failure).toEqual({
      code: "RUN_CANCELLED",
      message: "运行已停止，预扣积分已退回。",
    });
    expect(retry).toEqual(cancelled);
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 1000,
      reserved: 0,
    });
    const releases = await database.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM credit_ledger
        WHERE user_id = $1 AND run_id = $2 AND entry_type = 'release'
      `,
      [userId, start.run.id],
    );
    expect(releases.rows[0].count).toBe(1);
    const events = await readRunEventBatch(
      { userId, runId: start.run.id, afterEventId: "0" },
      database,
    );
    expect(events?.events.map((event) => event.payload.type)).toEqual(["error"]);
  });

  it("fails a corrupted current attachment before model start and releases reserved credits", async () => {
    const userId = await createUser();
    const validBytes = Buffer.from("historical buyer list", "utf8");
    const stored = await storeInputAttachment({
      file: new File([validBytes], "historical-buyers.txt", {
        type: "text/plain",
      }),
      storageDirectory: environmentState.inputAttachmentDirectory,
      maxBytes: 10 * 1024 * 1024,
    });
    const staged = await createInputAttachment(
      {
        userId,
        stored,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
      database,
    );
    const start = await enqueueChatRun(
      {
        userId,
        request: {
          kind: "append",
          conversationId: null,
          parentRunId: null,
          message: "Read the corrupted attachment",
          attachmentIds: [staged.attachment.id],
          requestId: randomUUID(),
          executionProfileId: "standard_research",
        },
        executionConfig: capturedConfig(),
        maxAttachmentCount: 5,
        maxAttachmentTotalBytes: 20 * 1024 * 1024,
      },
      database,
    );
    const corruptedBytes = Buffer.from(validBytes);
    corruptedBytes[0] ^= 0xff;
    expect(createHash("sha256").update(corruptedBytes).digest("hex")).not.toBe(
      stored.sha256,
    );
    await writeFile(
      resolveStoredInputAttachmentPath(
        environmentState.inputAttachmentDirectory,
        stored.storagePath,
      ),
      corruptedBytes,
    );
    const runtime = {
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        throw new Error("Runtime must not start for corrupt history");
      },
    };

    await expect(
      new AgentRunWorker({
        runtimeFactory: {
          capability: runWorkerCapability(),
          forRun: () => runtime,
        },
        database,
        workerId: randomUUID(),
        concurrency: 1,
        pollIntervalMs: 5,
        leaseDurationMs: 10_000,
        recoverAbandoned: false,
        logger: { error: vi.fn() },
      }).runOnce(),
    ).resolves.toBe(true);

    expect(await getAgentRun(userId, start.run.id, database)).toMatchObject({
      status: "failed",
      failure: {
        code: "INTERNAL_ERROR",
        message: "这次运行未能开始，预扣积分已退回。",
      },
    });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 1000,
      reserved: 0,
    });
    const runState = await database.query<{ model_started_at: Date | null }>(
      "SELECT model_started_at FROM runs WHERE id = $1",
      [start.run.id],
    );
    expect(runState.rows[0].model_started_at).toBeNull();
    const releases = await database.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM credit_ledger
        WHERE user_id = $1 AND run_id = $2 AND entry_type = 'release'
      `,
      [userId, start.run.id],
    );
    expect(releases.rows[0].count).toBe(1);
  });
});
