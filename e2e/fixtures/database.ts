import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { createCsvArtifact } from "../../lib/artifacts/repository";
import {
  RunEventPayloadSchema,
  RunWorkerCapabilitySchema,
  type ArtifactSummary,
} from "../../lib/contracts";
import type { ResearchSnapshot } from "../../lib/domain/research";
import { saveResearchSnapshot } from "../../lib/research/repository";

import {
  appendRunEvent,
  claimNextRun,
  completeClaimedRun,
  failClaimedRun,
  markRunModelStarted,
} from "../../lib/runs/repository";
import { materializeRetrySourcePreRunContext } from "../../lib/runs/pre-run-context";
import { writeRunSessionSnapshot } from "../../lib/runs/session-snapshots";
import type { ClaimedAgentRun, RunLease } from "../../lib/runs/types";

export const E2E_PRE_SWITCH_REASONING_TEXT =
  "已提交切换会话前的分析进度。";
export const E2E_RETRYABLE_FAILURE_CODE = "E2E_RETRYABLE_FAILURE";
export const E2E_RETRYABLE_FAILURE_MESSAGE =
  "E2E 首次尝试失败，原始运行已保留并可以重试。";
export const E2E_RECONCILIATION_REASONING_TEXT =
  "E2E 已保存模型开始后的活动，随后进入待对账状态。";
export const E2E_RECONCILIATION_PARTIAL_TEXT =
  "E2E 已保留待对账运行在中断前生成的内容。";
export const E2E_LIBRARY_RESEARCH_TITLE = "E2E 德国工业泵目标买家";
export const E2E_LIBRARY_QUERY_SUMMARY =
  "通过公开网页核验德国工业泵分销商及其采购负责人。";
export const E2E_LIBRARY_LIMITATIONS =
  "仅使用公开网页资料；联系人职位可能随时间变化。";
export const E2E_LIBRARY_COMPANY_NAME = "E2E Buyer GmbH";
export const E2E_LIBRARY_COMPANY_RELEVANCE =
  "该公司公开展示工业泵分销业务，符合目标买家画像。";
export const E2E_LIBRARY_COMPANY_EVIDENCE =
  "公司官网展示工业泵产品与德国分销服务。";
export const E2E_LIBRARY_CONTACT_NAME = "Anna Einkauf";
export const E2E_LIBRARY_CONTACT_TITLE = "Head of Procurement";
export const E2E_LIBRARY_CONTACT_EVIDENCE =
  "公开团队页列明 Anna Einkauf 负责采购。";
export const E2E_LIBRARY_ARTIFACT_NAME = "e2e-verified-buyers.csv";
const e2eLeaseDurationMs = 60 * 60_000;

function e2eWorkerCapability() {
  return RunWorkerCapabilitySchema.parse({
    provider: process.env.OPENAI_PROVIDER,
    baseUrl: process.env.OPENAI_BASE_URL,
    codeInterpreter:
      process.env.OPENAI_CODE_INTERPRETER_ENABLED === "true",
    reasoningMode:
      process.env.OPENAI_REASONING_MODE_ENABLED === "true",
  });
}

function leaseForClaim(claim: ClaimedAgentRun): RunLease {
  return {
    runId: claim.run.id,
    leaseOwner: claim.leaseOwner,
    leaseToken: claim.leaseToken,
  };
}

export type E2eClaimedRun = Readonly<{
  claim: ClaimedAgentRun;
  committedEventId: string;
}>;

export type E2eExpectedCustomInstructionsSnapshot = Readonly<{
  content: string;
  revision: number;
}>;

export type E2eLibraryFixture = Readonly<{
  artifact: ArtifactSummary;
  assistantMessageId: string;
  conversationId: string;
  runId: string;
  snapshot: ResearchSnapshot;
}>;

async function createE2eLibraryFixture(
  claim: ClaimedAgentRun,
  database: Pool,
): Promise<E2eLibraryFixture> {
  const snapshot = await saveResearchSnapshot(
    {
      userId: claim.userId,
      conversationId: claim.run.conversationId,
      runId: claim.run.id,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      research: {
        title: E2E_LIBRARY_RESEARCH_TITLE,
        querySummary: E2E_LIBRARY_QUERY_SUMMARY,
        limitations: E2E_LIBRARY_LIMITATIONS,
        companies: [
          {
            name: E2E_LIBRARY_COMPANY_NAME,
            websiteUrl: "https://example.com/e2e-buyer",
            country: "德国",
            companyType: "distributor",
            relevanceSummary: E2E_LIBRARY_COMPANY_RELEVANCE,
            evidence: [
              {
                claim: E2E_LIBRARY_COMPANY_EVIDENCE,
                sourceUrl: "https://example.com/e2e-buyer/pumps",
                sourceTitle: "E2E Buyer industrial pumps",
                supports: "business_fit",
              },
            ],
            contacts: [
              {
                name: E2E_LIBRARY_CONTACT_NAME,
                titleOriginal: E2E_LIBRARY_CONTACT_TITLE,
                roleCategory: "procurement",
                publicProfileUrl:
                  "https://example.com/e2e-buyer/anna-einkauf",
                confidence: "A",
                evidence: [
                  {
                    claim: E2E_LIBRARY_CONTACT_EVIDENCE,
                    sourceUrl: "https://example.com/e2e-buyer/team",
                    sourceTitle: "E2E Buyer team",
                    supports: "contact_role",
                  },
                ],
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
      userId: claim.userId,
      conversationId: claim.run.conversationId,
      messageId: null,
      runId: claim.run.id,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      snapshot,
      name: E2E_LIBRARY_ARTIFACT_NAME,
    },
    database,
  );
  return {
    artifact,
    assistantMessageId: claim.run.assistantMessageId,
    conversationId: claim.run.conversationId,
    runId: claim.run.id,
    snapshot,
  };
}

function assertClaimedCustomInstructionsSnapshot(
  runId: string,
  actual: ClaimedAgentRun["customInstructionsSnapshot"],
  expectedByRunId: Readonly<
    Record<string, E2eExpectedCustomInstructionsSnapshot | null>
  >,
): void {
  if (!Object.hasOwn(expectedByRunId, runId)) {
    throw new Error(
      `E2E custom-instructions expectations omitted claimed Run ${runId}`,
    );
  }

  const expected = expectedByRunId[runId];
  if (expected === null) {
    if (actual !== null) {
      throw new Error(
        `E2E Run ${runId} unexpectedly claimed custom instructions`,
      );
    }
    return;
  }
  if (
    actual === null ||
    actual.content !== expected.content ||
    actual.revision !== expected.revision
  ) {
    throw new Error(
      `E2E Run ${runId} did not preserve its conversation custom-instructions snapshot`,
    );
  }
}

export async function claimE2eRunAndAppendCommittedEvent(
  expectedRunId: string,
): Promise<E2eClaimedRun> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the E2E database driver");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const claim = await claimNextRun(
      {
        workerId: randomUUID(),
        leaseDurationMs: e2eLeaseDurationMs,
        capability: e2eWorkerCapability(),
      },
      database,
    );
    if (claim === null || claim.run.id !== expectedRunId) {
      throw new Error(
        `Claimed ${claim?.run.id ?? "no"} E2E Run; expected ${expectedRunId}`,
      );
    }
    const event = await appendRunEvent(
      leaseForClaim(claim),
      {
        type: "reasoning",
        itemId: `e2e-pre-switch-reasoning-${claim.run.id}`,
        summaryIndex: 0,
        providerSequence: 0,
        text: E2E_PRE_SWITCH_REASONING_TEXT,
      },
      database,
    );
    return { claim, committedEventId: event.id };
  } finally {
    await database.end();
  }
}

async function claimExpectedE2eRun(
  expectedRunId: string,
  database: Pool,
): Promise<ClaimedAgentRun> {
  const claim = await claimNextRun(
    {
      workerId: randomUUID(),
      leaseDurationMs: e2eLeaseDurationMs,
      capability: e2eWorkerCapability(),
    },
    database,
  );
  if (claim === null || claim.run.id !== expectedRunId) {
    throw new Error(
      `Claimed ${claim?.run.id ?? "no"} E2E Run; expected ${expectedRunId}`,
    );
  }
  return claim;
}

async function materializeE2eRetryContext(
  claim: ClaimedAgentRun,
  database: Pool,
): Promise<void> {
  if (claim.run.retryOfRunId === null) {
    return;
  }
  const context = await materializeRetrySourcePreRunContext(
    {
      userId: claim.userId,
      conversationId: claim.run.conversationId,
      sourceRunId: claim.run.retryOfRunId,
      allowDeferredPredecessor: false,
    },
    database,
  );
  if (context.kind !== "available") {
    throw new Error("E2E retry context remained deferred after claim");
  }
}

export async function failE2eRunBeforeProvider(
  expectedRunId: string,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the E2E database driver");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const claim = await claimExpectedE2eRun(expectedRunId, database);
    await materializeE2eRetryContext(claim, database);
    if (claim.run.retryOfRunId === null) {
      await writeRunSessionSnapshot(claim.run.id, "pre", [], database);
    }
    const failed = await failClaimedRun(
      {
        lease: leaseForClaim(claim),
        errorName: "E2eRetryableFailureBeforeProvider",
        eventCode: E2E_RETRYABLE_FAILURE_CODE,
        eventMessage: E2E_RETRYABLE_FAILURE_MESSAGE,
      },
      database,
    );
    if (
      failed.id !== expectedRunId ||
      failed.status !== "failed" ||
      failed.failure?.code !== E2E_RETRYABLE_FAILURE_CODE ||
      failed.failure.message !== E2E_RETRYABLE_FAILURE_MESSAGE
    ) {
      throw new Error("E2E retry source did not enter the expected failure state");
    }
  } finally {
    await database.end();
  }
}

export async function abandonE2eRunAfterSimulatedModelStart(
  expectedRunId: string,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the E2E database driver");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const claim = await claimExpectedE2eRun(expectedRunId, database);
    await materializeE2eRetryContext(claim, database);
    const lease = leaseForClaim(claim);
    await appendRunEvent(
      lease,
      {
        type: "reasoning",
        itemId: `e2e-reconciliation-reasoning-${claim.run.id}`,
        summaryIndex: 0,
        providerSequence: 0,
        text: E2E_RECONCILIATION_REASONING_TEXT,
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "delta",
        text: E2E_RECONCILIATION_PARTIAL_TEXT,
      },
      database,
    );
    await markRunModelStarted(lease, database);
    const abandoned = await database.query<{ id: string }>(
      `
        UPDATE runs
        SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
        WHERE
          id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND lease_token = $3::bigint
        RETURNING id
      `,
      [claim.run.id, claim.leaseOwner, claim.leaseToken],
    );
    if (abandoned.rowCount !== 1 || abandoned.rows[0].id !== expectedRunId) {
      throw new Error("E2E Run lease was not abandoned exactly once");
    }
  } finally {
    await database.end();
  }
}

export async function assertE2eRetryQueueGraph(input: {
  headRunId: string;
  expectedHeadStatus: "queued" | "completed";
  attempts: readonly Readonly<{
    runId: string;
    status:
      | "cancelled"
      | "waiting"
      | "queued"
      | "failed"
      | "completed";
  }>[];
  successorRunId: string;
  expectedSuccessorStatus:
    | "waiting"
    | "queued"
    | "reconciliation_required";
}): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the E2E database driver");
  }
  if (input.attempts.length < 2) {
    throw new Error("E2E retry queue graph requires at least two attempts");
  }
  const runIds = [
    input.headRunId,
    ...input.attempts.map((attempt) => attempt.runId),
    input.successorRunId,
  ];
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("E2E retry queue graph requires distinct Run IDs");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await database.query<{
      assistant_message_id: string;
      attempt_index: number;
      conversation_id: string;
      conversation_turn: string;
      id: string;
      input_message_id: string;
      predecessor_run_id: string | null;
      retry_of_run_id: string | null;
      selected_run_id: string;
      status:
        | "failed"
        | "waiting"
        | "queued"
        | "completed"
        | "cancelled"
        | "reconciliation_required";
    }>(
      `
        SELECT
          run.id,
          run.conversation_id,
          run.input_message_id,
          run.assistant_message_id,
          run.status,
          run.conversation_turn::text AS conversation_turn,
          run.attempt_index,
          run.predecessor_run_id,
          run.retry_of_run_id,
          conversation.selected_run_id
        FROM runs run
        JOIN conversations conversation ON conversation.id = run.conversation_id
        WHERE run.id = ANY($1::uuid[])
        ORDER BY run.conversation_turn, run.attempt_index
      `,
      [runIds],
    );
    if (result.rowCount !== runIds.length) {
      throw new Error("E2E retry queue graph is missing a Run");
    }
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    const head = byId.get(input.headRunId);
    const attempts = input.attempts.map(({ runId }) => byId.get(runId));
    const successor = byId.get(input.successorRunId);
    if (head === undefined || attempts.some((attempt) => attempt === undefined) ||
      successor === undefined) {
      throw new Error("E2E retry queue graph did not return the requested Runs");
    }
    const presentAttempts = attempts as NonNullable<(typeof attempts)[number]>[];
    const firstAttempt = presentAttempts[0];
    const latestAttempt = presentAttempts.at(-1);
    if (firstAttempt === undefined || latestAttempt === undefined) {
      throw new Error("E2E retry queue graph is missing an attempt");
    }
    if (
      new Set(result.rows.map((row) => row.conversation_id)).size !== 1 ||
      result.rows.some(
        (row) => row.selected_run_id !== input.successorRunId,
      ) ||
      head.status !== input.expectedHeadStatus ||
      head.conversation_turn !== "1" ||
      head.attempt_index !== 1 ||
      head.predecessor_run_id !== null ||
      head.retry_of_run_id !== null ||
      presentAttempts.some((attempt, index) =>
        attempt.status !== input.attempts[index].status ||
        attempt.conversation_turn !== "2" ||
        attempt.attempt_index !== index + 1 ||
        attempt.predecessor_run_id !== head.id ||
        attempt.retry_of_run_id !==
          (index === 0 ? null : presentAttempts[index - 1].id) ||
        attempt.input_message_id !== firstAttempt.input_message_id
      ) ||
      new Set(
        presentAttempts.map((attempt) => attempt.assistant_message_id),
      ).size !== presentAttempts.length ||
      successor.status !== input.expectedSuccessorStatus ||
      successor.conversation_turn !== "3" ||
      successor.attempt_index !== 1 ||
      successor.predecessor_run_id !== latestAttempt.id ||
      successor.retry_of_run_id !== null
    ) {
      throw new Error(
        `Unexpected E2E retry queue graph: ${JSON.stringify(result.rows)}`,
      );
    }

    for (let index = 0; index < presentAttempts.length; index += 1) {
      const attempt = presentAttempts[index];
      const status = input.attempts[index].status;
      if (status !== "cancelled" && status !== "failed") {
        continue;
      }
      const events = await database.query<{
        event_type: string;
        payload: unknown;
      }>(
        `
          SELECT event_type, payload
          FROM run_events
          WHERE run_id = $1
          ORDER BY id
        `,
        [attempt.id],
      );
      const payload = events.rows[0]?.payload === undefined
        ? null
        : RunEventPayloadSchema.parse(events.rows[0].payload);
      const expectedCode = status === "cancelled"
        ? "RUN_CANCELLED"
        : E2E_RETRYABLE_FAILURE_CODE;
      const expectedMessage = status === "cancelled"
        ? "运行已停止，预扣积分已退回。"
        : E2E_RETRYABLE_FAILURE_MESSAGE;
      if (
        events.rowCount !== 1 ||
        events.rows[0]?.event_type !== "error" ||
        payload?.type !== "error" ||
        payload.error.code !== expectedCode ||
        payload.error.message !== expectedMessage ||
        payload.error.runId !== attempt.id
      ) {
        throw new Error(
          `Retry creation changed terminal E2E attempt ${attempt.id}`,
        );
      }
    }
  } finally {
    await database.end();
  }
}

export async function completeE2eRunWithoutProvider(
  expectedRunId: string,
): Promise<void> {
  await completeE2eRunsWithoutProvider({
    detailedRunId: expectedRunId,
    expectedRunIds: [expectedRunId],
  });
}

export async function completeE2eRunsWithoutProvider(input: {
  claimedRun?: E2eClaimedRun;
  detailedRunId: string;
  expectedCustomInstructionsByRunId?: Readonly<
    Record<string, E2eExpectedCustomInstructionsSnapshot | null>
  >;
  expectedRunIds: readonly string[];
  includeLibraryFixture?: boolean;
}): Promise<E2eLibraryFixture | null> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the E2E database driver");
  }
  if (
    input.expectedRunIds.length < 1 ||
    new Set(input.expectedRunIds).size !== input.expectedRunIds.length ||
    !input.expectedRunIds.includes(input.detailedRunId)
  ) {
    throw new Error("E2E Run completion requires unique expected Run IDs");
  }
  const expectedCustomInstructionsByRunId =
    input.expectedCustomInstructionsByRunId;
  if (
    expectedCustomInstructionsByRunId !== undefined &&
    (Object.keys(expectedCustomInstructionsByRunId).length !==
      input.expectedRunIds.length ||
      input.expectedRunIds.some(
        (runId) =>
          !Object.hasOwn(expectedCustomInstructionsByRunId, runId),
      ))
  ) {
    throw new Error(
      "E2E custom-instructions expectations must cover exactly the completed Runs",
    );
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  let libraryFixture: E2eLibraryFixture | null = null;
  try {
    const capability = e2eWorkerCapability();
    const remainingRunIds = new Set(input.expectedRunIds);

    for (let index = 0; index < input.expectedRunIds.length; index += 1) {
      const claim =
        input.claimedRun !== undefined && index === 0
          ? input.claimedRun.claim
          : await claimNextRun(
              {
                workerId: randomUUID(),
                leaseDurationMs: e2eLeaseDurationMs,
                capability,
              },
              database,
            );
      if (claim === null) {
        throw new Error("An expected E2E Run was not queued for completion");
      }
      if (!remainingRunIds.delete(claim.run.id)) {
        throw new Error(`Claimed unexpected E2E Run ${claim.run.id}`);
      }
      if (expectedCustomInstructionsByRunId !== undefined) {
        assertClaimedCustomInstructionsSnapshot(
          claim.run.id,
          claim.customInstructionsSnapshot,
          expectedCustomInstructionsByRunId,
        );
      }

      await materializeE2eRetryContext(claim, database);

      const lease = leaseForClaim(claim);
      const hasCommittedPreface =
        input.claimedRun?.claim.run.id === claim.run.id;
      if (!hasCommittedPreface) {
        await appendRunEvent(
          lease,
          {
            type: "status",
            phase: "thinking",
            message: "正在执行隔离的浏览器回归任务…",
          },
          database,
        );
      }
      await appendRunEvent(
        lease,
        {
          type: "reasoning",
          itemId: `e2e-reasoning-${claim.run.id}`,
          summaryIndex: 0,
          providerSequence: hasCommittedPreface ? 1 : 0,
          text:
            claim.run.id === input.detailedRunId
              ? "已在不调用模型供应商的 E2E 驱动中继续执行。"
              : `后台并行回归任务 ${index + 1} 已完成持久化核验。`,
        },
        database,
      );

      if (claim.run.id !== input.detailedRunId) {
        const result = await completeClaimedRun(
          {
            lease,
            userId: claim.userId,
            conversationId: claim.run.conversationId,
            assistantMessageId: claim.run.assistantMessageId,
            content: `E2E 批量后台任务 ${index + 1} 已完成。`,
            citations: [],
            usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
            sessionItems: [],
          },
          database,
        );
        if (result.kind !== "completed") {
          throw new Error("A provider-free E2E Run required reconciliation");
        }
        continue;
      }

    await appendRunEvent(
      lease,
      {
        type: "web_search",
        callId: "e2e-search",
        phase: "completed",
        outputIndex: 0,
        providerSequence: hasCommittedPreface ? 2 : 1,
        action: {
          type: "search",
          query: "E2E official buyer source",
          queries: ["E2E official buyer source"],
          sources: [
            {
              type: "url",
              url: "https://example.com/official-buyers",
            },
          ],
        },
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "code_interpreter_status",
        callId: "e2e-python",
        phase: "in_progress",
        outputIndex: 1,
        providerSequence: hasCommittedPreface ? 3 : 2,
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "code_interpreter_code",
        callId: "e2e-python",
        update: "done",
        code: "verified_buyers = 2\\nprint(verified_buyers)",
        outputIndex: 1,
        providerSequence: hasCommittedPreface ? 4 : 3,
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "code_interpreter_status",
        callId: "e2e-python",
        phase: "interpreting",
        outputIndex: 1,
        providerSequence: hasCommittedPreface ? 5 : 4,
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "code_interpreter_status",
        callId: "e2e-python",
        phase: "completed",
        outputIndex: 1,
        providerSequence: hasCommittedPreface ? 6 : 5,
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "code_interpreter_result",
        callId: "e2e-python",
        phase: "completed",
        outputIndex: 1,
        providerSequence: hasCommittedPreface ? 7 : 6,
        containerId: "e2e-container",
        code: "verified_buyers = 2\\nprint(verified_buyers)",
        outputs: [{ type: "logs", logs: "2" }],
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "tool_started",
        callId: "e2e-csv-tool",
        toolName: "create_csv_file",
        title: "生成 E2E CSV 文件",
        input: "{\"rows\":1}",
      },
      database,
    );
    await appendRunEvent(
      lease,
      {
        type: "tool_completed",
        callId: "e2e-csv-tool",
        toolName: "create_csv_file",
        title: "生成 E2E CSV 文件",
        output: "{\"status\":\"verified\"}",
      },
      database,
    );

    const preparedLibraryFixture = input.includeLibraryFixture
      ? await createE2eLibraryFixture(claim, database)
      : null;
    const result = await completeClaimedRun(
      {
        lease,
        userId: claim.userId,
        conversationId: claim.run.conversationId,
        assistantMessageId: claim.run.assistantMessageId,
        content: "E2E 后台任务已完成，切换会话没有中断执行。",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
        sessionItems: [],
      },
      database,
    );
    if (result.kind !== "completed") {
      throw new Error("The provider-free E2E Run required reconciliation");
    }
    if (preparedLibraryFixture !== null) {
      if (
        result.message.id !== preparedLibraryFixture.assistantMessageId ||
        result.message.artifacts.length !== 1 ||
        result.message.artifacts[0]?.id !== preparedLibraryFixture.artifact.id
      ) {
        throw new Error(
          "E2E Library artifact was not bound to the final assistant message",
        );
      }
      libraryFixture = preparedLibraryFixture;
    }
    }

    if (remainingRunIds.size !== 0) {
      throw new Error(
        `E2E did not complete expected Runs: ${[...remainingRunIds].join(", ")}`,
      );
    }
    return libraryFixture;
  } finally {
    await database.end();
  }
}

export async function assertE2eCustomInstructionsPersistence(input: {
  expectedConversationSnapshots: Readonly<
    Record<string, E2eExpectedCustomInstructionsSnapshot>
  >;
  forbiddenMarkers: readonly string[];
  runIds: readonly string[];
  sharedConversationId: string;
}): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required for the E2E database driver");
  }
  const conversationIds = Object.keys(input.expectedConversationSnapshots);
  if (
    conversationIds.length < 1 ||
    input.runIds.length < 1 ||
    input.forbiddenMarkers.length < 1 ||
    new Set(input.runIds).size !== input.runIds.length ||
    !Object.hasOwn(
      input.expectedConversationSnapshots,
      input.sharedConversationId,
    )
  ) {
    throw new Error("Invalid E2E custom-instructions persistence assertion");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const conversations = await database.query<{
      custom_instructions_snapshot: string | null;
      custom_instructions_snapshot_revision: number;
      id: string;
    }>(
      `
        SELECT
          id,
          custom_instructions_snapshot,
          custom_instructions_snapshot_revision
        FROM conversations
        WHERE id = ANY($1::uuid[])
      `,
      [conversationIds],
    );
    if (conversations.rowCount !== conversationIds.length) {
      throw new Error(
        "E2E did not find every custom-instructions conversation snapshot",
      );
    }
    for (const row of conversations.rows) {
      const expected = input.expectedConversationSnapshots[row.id];
      if (
        expected === undefined ||
        row.custom_instructions_snapshot !== expected.content ||
        row.custom_instructions_snapshot_revision !== expected.revision
      ) {
        throw new Error(
          `E2E conversation ${row.id} did not preserve its exact custom-instructions snapshot`,
        );
      }
    }

    const persistedSurfaces = await database.query<{
      run_events: string;
      share_snapshot: string | null;
    }>(
      `
        SELECT
          COALESCE((
            SELECT string_agg(event.payload::text, E'\\n' ORDER BY event.id)
            FROM run_events event
            WHERE event.run_id = ANY($1::uuid[])
          ), '') AS run_events,
          (
            SELECT share.messages::text
            FROM conversation_shares share
            WHERE share.conversation_id = $2
          ) AS share_snapshot
      `,
      [input.runIds, input.sharedConversationId],
    );
    const persisted = persistedSurfaces.rows[0];
    if (persisted === undefined || persisted.share_snapshot === null) {
      throw new Error("E2E custom-instructions share snapshot was not persisted");
    }
    for (const marker of input.forbiddenMarkers) {
      if (
        persisted.run_events.includes(marker) ||
        persisted.share_snapshot.includes(marker)
      ) {
        throw new Error(
          "Custom instructions leaked into persisted Run activity or a share snapshot",
        );
      }
    }
  } finally {
    await database.end();
  }
}
