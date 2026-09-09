import { createHash, randomUUID } from "node:crypto";

import type { AgentInputItem } from "@openai/agents";
import type { Pool, PoolClient } from "pg";

import {
  AgentRunSchema,
  ChatMessageSchema,
  ChatRequestSchema,
  ChatStartResponseSchema,
  CreatedAgentRunSchema,
  RegenerateRunResponseSchema,
  RetryRunResponseSchema,
  RunWorkerCapabilitySchema,
  RunEventPayloadSchema,
  RunEventSchema,
  type AgentRun,
  type AgentRunStatus,
  type ChatRequest,
  type ChatStartResponse,
  type Citation,
  type CapturedRunExecutionConfig,
  type CreditBalance,
  type RegenerateRunResponse,
  type RetryRunResponse,
  type RunWorkerCapability,
  type RunEvent,
  type RunEventPayload,
} from "@/lib/contracts";
import {
  beginRunReservationInTransaction,
  reserveCreditsForRunInTransaction,
} from "@/lib/credits";
import {
  createConversation,
  finalizeSuccessfulChatRunInTransaction,
  getConversation,
  insertMessage,
  updateConversationTitle,
} from "@/lib/db";
import { deriveConversationTitle } from "@/lib/chat/title";
import { getPool, withTransaction } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";
import { AppError } from "@/lib/errors";
import {
  bindInputAttachmentsToMessage,
  listInputAttachmentSummariesForMessages,
  lockInputAttachmentsForNewMessage,
} from "@/lib/input-attachments";
import {
  capturedRunExecutionConfigFingerprintPayload,
  copyCapturedRunExecutionConfig,
  parseRunExecutionConfig,
  RUN_EXECUTION_CONFIG_JSON_SQL,
  summarizeRunExecutionConfig,
} from "@/lib/run-config";

import type {
  ClaimedAgentRun,
  LeaseHeartbeat,
  RunEventBatch,
  RunLease,
} from "./types";
import { materializeRetrySourcePreRunContext } from "./pre-run-context";
import { readRunSessionSnapshot, writeRunSessionSnapshot } from "./session-snapshots";

type RunRow = {
  id: string;
  request_id: string;
  user_id: string;
  conversation_id: string;
  input_message_id: string | null;
  assistant_message_id: string | null;
  status: AgentRunStatus;
  conversation_turn: string;
  attempt_index: number;
  predecessor_run_id: string | null;
  retry_of_run_id: string | null;
  regenerate_of_run_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  reservation_credits: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  model_started_at: Date | null;
  cancel_requested_at: Date | null;
  lease_owner: string | null;
  lease_token: string;
  lease_expires_at: Date | null;
  request_fingerprint: string | null;
  execution_config: unknown;
};

type EventRow = {
  id: string;
  run_id: string;
  payload: unknown;
  created_at: Date;
};

type CreditRow = {
  available_credits: number;
  reserved_credits: number;
  frozen_credits: number;
};

type ExistingStartRow = RunRow & {
  input_content: string | null;
  input_role: "user" | null;
  input_citations: unknown | null;
  input_created_at: Date | null;
  input_attachment_ids: string[];
};

const RUN_COLUMNS = `
  run.id,
  run.request_id,
  run.user_id,
  run.conversation_id,
  run.input_message_id,
  run.assistant_message_id,
  run.status,
  run.conversation_turn::text AS conversation_turn,
  run.attempt_index,
  run.predecessor_run_id,
  run.retry_of_run_id,
  run.regenerate_of_run_id,
  run.failure_code,
  run.failure_message,
  run.reservation_credits,
  run.created_at,
  run.started_at,
  run.finished_at,
  run.model_started_at,
  run.cancel_requested_at,
  run.lease_owner,
  run.lease_token,
  run.lease_expires_at,
  run.request_fingerprint,
  ${RUN_EXECUTION_CONFIG_JSON_SQL}
`;

const terminalRunStatuses = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "reconciliation_required",
]);

const RECONCILIATION_FAILURE = {
  code: "RUN_REQUIRES_RECONCILIATION",
  message: "这次运行需要积分对账。",
} as const;

export class RunLeaseLostError extends Error {
  constructor(readonly runId: string) {
    super(`Lease for run ${runId} is no longer owned by this worker`);
    this.name = "RunLeaseLostError";
  }
}

function validatePositiveInteger(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${description} must be a positive safe integer`);
  }
}

function mapFailure(row: RunRow): AgentRun["failure"] {
  if (row.failure_code === null && row.failure_message === null) {
    return null;
  }
  if (row.failure_code === null || row.failure_message === null) {
    throw new TypeError("Run failure fields are inconsistent");
  }
  return { code: row.failure_code, message: row.failure_message };
}

export function mapAgentRun(row: RunRow): AgentRun {
  return AgentRunSchema.parse({
    id: row.id,
    requestId: row.request_id,
    conversationId: row.conversation_id,
    inputMessageId: row.input_message_id,
    assistantMessageId: row.assistant_message_id,
    status: row.status,
    conversationTurn: row.conversation_turn,
    attemptIndex: row.attempt_index,
    predecessorRunId: row.predecessor_run_id,
    retryOfRunId: row.retry_of_run_id,
    regenerateOfRunId: row.regenerate_of_run_id,
    executionConfig: summarizeRunExecutionConfig(row.execution_config),
    failure: mapFailure(row),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
  });
}

function mapCreatedAgentRun(row: RunRow) {
  return CreatedAgentRunSchema.parse(mapAgentRun(row));
}

function mapBalance(row: CreditRow): CreditBalance {
  return {
    available: row.available_credits,
    reserved: row.reserved_credits + row.frozen_credits,
  };
}

function mapEvent(row: EventRow): RunEvent {
  return RunEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
    payload: RunEventPayloadSchema.parse(row.payload),
  });
}

function isRequestIdConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "runs_request_id_key"
  );
}

function chatRequestFingerprint(
  request: ChatRequest,
  executionConfig: CapturedRunExecutionConfig,
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
        capturedRunExecutionConfigFingerprintPayload(executionConfig),
      ]),
      "utf8",
    )
    .digest("hex");
}

function normalizeChatRequest(request: ChatRequest): ChatRequest {
  const parsed = ChatRequestSchema.parse(request);
  if (parsed.kind === "edit") {
    return {
      ...parsed,
      conversationId: parsed.conversationId.toLowerCase(),
      parentRunId: parsed.parentRunId?.toLowerCase() ?? null,
      sourceMessageId: parsed.sourceMessageId.toLowerCase(),
      requestId: parsed.requestId.toLowerCase(),
      attachmentIds: parsed.attachmentIds.map((id) => id.toLowerCase()),
    };
  }
  return {
    ...parsed,
    conversationId: parsed.conversationId?.toLowerCase() ?? null,
    parentRunId: parsed.parentRunId?.toLowerCase() ?? null,
    requestId: parsed.requestId.toLowerCase(),
    attachmentIds: parsed.attachmentIds.map((id) => id.toLowerCase()),
  };
}

function retryRequestFingerprint(
  sourceRunId: string,
  executionConfig: CapturedRunExecutionConfig,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "custent.run-retry.v2",
        sourceRunId,
        capturedRunExecutionConfigFingerprintPayload(executionConfig),
      ]),
      "utf8",
    )
    .digest("hex");
}

function regenerateRequestFingerprint(
  sourceRunId: string,
  executionConfig: CapturedRunExecutionConfig,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "custent.run-regenerate.v2",
        sourceRunId,
        capturedRunExecutionConfigFingerprintPayload(executionConfig),
      ]),
      "utf8",
    )
    .digest("hex");
}

async function selectBalance(
  client: PoolClient,
  userId: string,
): Promise<CreditBalance> {
  const result = await client.query<CreditRow>(
    `
      SELECT available_credits, reserved_credits, frozen_credits
      FROM users
      WHERE id = $1
    `,
    [userId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }
  return mapBalance(result.rows[0]);
}

async function selectRunByRequestId(
  client: PoolClient,
  requestId: string,
): Promise<ExistingStartRow | null> {
  const result = await client.query<ExistingStartRow>(
    `
      SELECT
        ${RUN_COLUMNS},
        input_message.content AS input_content,
        input_message.role AS input_role,
        input_message.citations AS input_citations,
        input_message.created_at AS input_created_at,
        ARRAY(
          SELECT message_attachment.attachment_id
          FROM message_input_attachments message_attachment
          WHERE message_attachment.message_id = input_message.id
          ORDER BY message_attachment.position
        ) AS input_attachment_ids
      FROM runs run
      LEFT JOIN messages input_message ON input_message.id = run.input_message_id
      WHERE run.request_id = $1
    `,
    [requestId],
  );
  return result.rowCount === 0 ? null : result.rows[0];
}

async function lockChatRequestId(
  client: PoolClient,
  requestId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [requestId],
  );
}

async function existingChatStartResponse(
  client: PoolClient,
  userId: string,
  request: ChatRequest,
): Promise<ChatStartResponse | null> {
  const row = await selectRunByRequestId(client, request.requestId);
  if (row === null) {
    return null;
  }
  const persistedExecutionConfig = parseRunExecutionConfig(
    row.execution_config,
  );
  if (
    persistedExecutionConfig.provenance !== "captured" ||
    row.user_id !== userId ||
    row.request_fingerprint !==
      chatRequestFingerprint(request, persistedExecutionConfig) ||
    (request.conversationId !== null &&
      row.conversation_id !== request.conversationId) ||
    row.input_message_id === null ||
    row.assistant_message_id === null ||
    row.input_role !== "user" ||
    row.input_content !== request.message ||
    row.input_citations === null ||
    row.input_created_at === null ||
    row.input_attachment_ids.length !== request.attachmentIds.length ||
    row.input_attachment_ids.some(
      (attachmentId, position) =>
        attachmentId !== request.attachmentIds[position],
    )
  ) {
    throw new AppError(
      "RUN_ALREADY_EXISTS",
      "Request ID is already bound to a different run",
      409,
    );
  }

  const conversation = await getConversation(
    userId,
    row.conversation_id,
    client,
  );
  if (conversation === null) {
    throw new AppError("NOT_FOUND", "Conversation was not found", 404);
  }

  const attachmentsByMessage =
    await listInputAttachmentSummariesForMessages(
      { userId, messageIds: [row.input_message_id] },
      client,
    );
  const attachments = attachmentsByMessage.get(row.input_message_id);
  if (attachments === undefined) {
    throw new TypeError("Message attachment result is incomplete");
  }

  return ChatStartResponseSchema.parse({
    conversation,
    userMessage: ChatMessageSchema.parse({
      id: row.input_message_id,
      runId: row.id,
      role: row.input_role,
      content: row.input_content,
      citations: row.input_citations,
      artifacts: [],
      attachments,
      feedback: null,
      createdAt: row.input_created_at.toISOString(),
    }),
    run: mapCreatedAgentRun(row),
    credits: await selectBalance(client, userId),
  });
}

type LockedChatConversation = {
  id: string;
  title: string;
  selected_run_id: string | null;
};

async function lockChatConversation(
  client: PoolClient,
  userId: string,
  conversationId: string,
): Promise<LockedChatConversation> {
  const result = await client.query<LockedChatConversation>(
    `
      SELECT id, title, selected_run_id
      FROM conversations
      WHERE
        id = $1
        AND user_id = $2
        AND deleted_at IS NULL
        AND archived_at IS NULL
      FOR UPDATE
    `,
    [conversationId, userId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "对话不存在。", 404);
  }
  return result.rows[0];
}

function validateAppendParent(
  conversation: LockedChatConversation,
  parentRunId: string | null,
): void {
  if (conversation.selected_run_id !== parentRunId) {
    throw new AppError(
      "STALE_PARENT",
      "The selected conversation branch has changed",
      409,
    );
  }
}

async function validateEditSource(
  client: PoolClient,
  input: {
    userId: string;
    conversation: LockedChatConversation;
    sourceMessageId: string;
    parentRunId: string | null;
    executionProfileId: CapturedRunExecutionConfig["executionProfileId"];
  },
): Promise<void> {
  if (input.conversation.selected_run_id === null) {
    throw new AppError("INVALID_EDIT", "The source message is not selected", 409);
  }
  const result = await client.query<{
    predecessor_run_id: string | null;
    config_provenance: "captured" | "legacy_unknown";
    execution_profile_id: string | null;
  }>(
    `
      WITH RECURSIVE selected_path AS (
        SELECT id, input_message_id, predecessor_run_id
        FROM runs
        WHERE
          id = $1
          AND conversation_id = $2
          AND user_id = $3
        UNION ALL
        SELECT predecessor.id, predecessor.input_message_id,
          predecessor.predecessor_run_id
        FROM runs predecessor
        JOIN selected_path child ON child.predecessor_run_id = predecessor.id
      )
      SELECT
        first_attempt.predecessor_run_id,
        first_config.provenance AS config_provenance,
        first_config.execution_profile_id
      FROM messages source_message
      JOIN runs first_attempt
        ON first_attempt.input_message_id = source_message.id
        AND first_attempt.attempt_index = 1
      JOIN run_execution_configs first_config
        ON first_config.run_id = first_attempt.id
      WHERE
        source_message.id = $4
        AND source_message.conversation_id = $2
        AND source_message.role = 'user'
        AND first_attempt.conversation_id = $2
        AND first_attempt.user_id = $3
        AND EXISTS (
          SELECT 1
          FROM selected_path path_run
          WHERE path_run.input_message_id = source_message.id
        )
      FOR UPDATE OF source_message, first_attempt
    `,
    [
      input.conversation.selected_run_id,
      input.conversation.id,
      input.userId,
      input.sourceMessageId,
    ],
  );
  if (result.rowCount !== 1) {
    throw new AppError(
      "INVALID_EDIT",
      "The source message is not on the selected branch",
      409,
    );
  }
  if (result.rows[0].predecessor_run_id !== input.parentRunId) {
    throw new AppError(
      "STALE_PARENT",
      "The edited message parent does not match its original parent",
      409,
    );
  }
  if (
    result.rows[0].config_provenance !== "captured" ||
    result.rows[0].execution_profile_id !== input.executionProfileId
  ) {
    throw new AppError(
      "INVALID_EDIT",
      "The edited message must preserve its original execution profile",
      409,
    );
  }
}

async function assertRunOnSelectedPath(
  client: PoolClient,
  input: {
    conversationId: string;
    selectedRunId: string | null;
    sourceRunId: string;
  },
  errorCode: "RUN_NOT_RETRYABLE" | "RUN_NOT_REGENERATABLE",
): Promise<void> {
  if (input.selectedRunId === null) {
    throw new AppError(errorCode, "Run is not on the selected branch", 409);
  }
  const result = await client.query<{ exists: boolean }>(
    `
      WITH RECURSIVE selected_path AS (
        SELECT id, predecessor_run_id
        FROM runs
        WHERE id = $1 AND conversation_id = $2
        UNION ALL
        SELECT predecessor.id, predecessor.predecessor_run_id
        FROM runs predecessor
        JOIN selected_path child ON child.predecessor_run_id = predecessor.id
      )
      SELECT EXISTS (
        SELECT 1 FROM selected_path WHERE id = $3
      ) AS exists
    `,
    [input.selectedRunId, input.conversationId, input.sourceRunId],
  );
  if (!result.rows[0].exists) {
    throw new AppError(errorCode, "Run is not on the selected branch", 409);
  }
}

export async function enqueueChatRun(
  input: {
    userId: string;
    request: ChatRequest;
    executionConfig: CapturedRunExecutionConfig;
    maxAttachmentCount: number;
    maxAttachmentTotalBytes: number;
  },
  database: Pool = getPool(),
): Promise<ChatStartResponse> {
  const userId = input.userId.toLowerCase();
  const request = normalizeChatRequest(input.request);
  const parsedExecutionConfig = parseRunExecutionConfig(
    input.executionConfig,
  );
  if (parsedExecutionConfig.provenance !== "captured") {
    throw new TypeError("A new Run requires a captured execution config");
  }
  const executionConfig = parsedExecutionConfig;
  if (
    executionConfig.executionProfileId !== request.executionProfileId
  ) {
    throw new TypeError(
      "Chat request profile does not match its resolved execution config",
    );
  }
  validatePositiveInteger(
    executionConfig.billing.reservationCredits,
    "reservationCredits",
  );
  validatePositiveInteger(input.maxAttachmentCount, "maxAttachmentCount");
  validatePositiveInteger(
    input.maxAttachmentTotalBytes,
    "maxAttachmentTotalBytes",
  );

  const operation = async (client: PoolClient): Promise<ChatStartResponse> => {
    await lockChatRequestId(client, request.requestId);
    const existing = await existingChatStartResponse(
      client,
      userId,
      request,
    );
    if (existing !== null) {
      return existing;
    }

    let conversation: LockedChatConversation;
    let lockedAttachments: Awaited<
      ReturnType<typeof lockInputAttachmentsForNewMessage>
    >;
    if (request.conversationId === null) {
      lockedAttachments = await lockInputAttachmentsForNewMessage(
        {
          userId,
          attachmentIds: request.attachmentIds,
          sourceMessageId: null,
          maxCount: input.maxAttachmentCount,
          maxTotalBytes: input.maxAttachmentTotalBytes,
        },
        client,
      );
      const title = request.message.length > 0
        ? deriveConversationTitle(request.message)
        : lockedAttachments[0]?.originalName;
      if (title === undefined) {
        throw new TypeError("An attachment-only message is missing attachments");
      }
      const created = await createConversation(userId, title, client);
      conversation = {
        id: created.id,
        title: created.title,
        selected_run_id: created.selectedRunId,
      };
      validateAppendParent(conversation, request.parentRunId);
    } else {
      conversation = await lockChatConversation(
        client,
        userId,
        request.conversationId,
      );
      if (request.kind === "append") {
        validateAppendParent(conversation, request.parentRunId);
      } else {
        await validateEditSource(client, {
          userId,
          conversation,
          sourceMessageId: request.sourceMessageId,
          parentRunId: request.parentRunId,
          executionProfileId: request.executionProfileId,
        });
      }
      lockedAttachments = await lockInputAttachmentsForNewMessage(
        {
          userId,
          attachmentIds: request.attachmentIds,
          sourceMessageId:
            request.kind === "edit" ? request.sourceMessageId : null,
          maxCount: input.maxAttachmentCount,
          maxTotalBytes: input.maxAttachmentTotalBytes,
        },
        client,
      );
    }

    let inputTitle: string;
    if (request.message.length > 0) {
      inputTitle = deriveConversationTitle(request.message);
    } else {
      const firstAttachment = lockedAttachments[0];
      if (firstAttachment === undefined) {
        throw new TypeError("An attachment-only message is missing attachments");
      }
      inputTitle = firstAttachment.originalName;
    }

    const assistantMessageId = randomUUID();
    const userMessage = await insertMessage(
      {
        userId,
        conversationId: conversation.id,
        role: "user",
        content: request.message,
        citations: [],
      },
      client,
    );
    const boundAttachments = await bindInputAttachmentsToMessage(
      {
        userId,
        messageId: userMessage.id,
        attachmentIds: request.attachmentIds,
        sourceMessageId:
          request.kind === "edit" ? request.sourceMessageId : null,
      },
      client,
    );
    const reservation = await beginRunReservationInTransaction(
      {
        kind: request.kind,
        userId,
        conversationId: conversation.id,
        requestId: request.requestId,
        reservationCredits: executionConfig.billing.reservationCredits,
        inputMessageId: userMessage.id,
        assistantMessageId,
        requestFingerprint: chatRequestFingerprint(request, executionConfig),
        parentRunId: request.parentRunId,
        executionConfig,
      },
      client,
    );

    const messageBinding = await client.query<{ id: string }>(
      `
        UPDATE messages
        SET run_id = $2
        WHERE
          id = $1
          AND conversation_id = $3
          AND role = 'user'
          AND run_id IS NULL
        RETURNING id
      `,
      [userMessage.id, reservation.run.id, conversation.id],
    );
    if (messageBinding.rowCount !== 1) {
      throw new TypeError("Run input message could not be bound to its Run");
    }
    const userMessageWithAttachments = ChatMessageSchema.parse({
      ...userMessage,
      runId: reservation.run.id,
      attachments: boundAttachments,
    });

    const runResult = await client.query<RunRow>(
      `
        SELECT ${RUN_COLUMNS}
        FROM runs run
        WHERE
          run.id = $1
          AND run.user_id = $2
          AND run.status IN ('waiting', 'queued')
      `,
      [reservation.run.id, userId],
    );
    if (runResult.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }

    if (conversation.title === "新对话") {
      await updateConversationTitle(
        conversation.id,
        userId,
        inputTitle,
        client,
      );
    }
    const updatedConversation = await getConversation(
      userId,
      conversation.id,
      client,
    );
    if (updatedConversation === null) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }

    return ChatStartResponseSchema.parse({
      conversation: updatedConversation,
      userMessage: userMessageWithAttachments,
      run: mapCreatedAgentRun(runResult.rows[0]),
      credits: reservation.credits,
    });
  };

  try {
    return await withTransaction(operation, database);
  } catch (error) {
    const shouldResolveExisting =
      isRequestIdConflict(error) ||
      (error instanceof AppError &&
        (error.code === "RUN_ALREADY_EXISTS" ||
          error.code === "RUN_IN_PROGRESS" ||
          error.status === 409));
    if (shouldResolveExisting) {
      const existing = await withTransaction(
        (client) =>
          existingChatStartResponse(
            client,
            userId,
            request,
          ),
        database,
      );
      if (existing !== null) {
        return existing;
      }
    }
    throw error;
  }
}

async function existingRetryRunResponse(
  client: PoolClient,
  input: {
    userId: string;
    sourceRunId: string;
    requestId: string;
  },
): Promise<RetryRunResponse | null> {
  const result = await client.query<RunRow>(
    `
      SELECT ${RUN_COLUMNS}
      FROM runs run
      WHERE run.request_id = $1
    `,
    [input.requestId],
  );
  if (result.rowCount === 0) {
    return null;
  }
  const run = result.rows[0];
  const executionConfig = parseRunExecutionConfig(run.execution_config);
  if (
    executionConfig.provenance !== "captured" ||
    run.user_id !== input.userId ||
    run.retry_of_run_id !== input.sourceRunId ||
    run.regenerate_of_run_id !== null ||
    run.request_fingerprint !==
      retryRequestFingerprint(input.sourceRunId, executionConfig) ||
    run.input_message_id === null ||
    run.assistant_message_id === null
  ) {
    throw new AppError(
      "RUN_ALREADY_EXISTS",
      "Request ID is already bound to a different run",
      409,
    );
  }

  const conversation = await getConversation(
    input.userId,
    run.conversation_id,
    client,
  );
  if (conversation === null) {
    throw new AppError("NOT_FOUND", "Conversation was not found", 404);
  }
  return RetryRunResponseSchema.parse({
    conversation,
    run: mapCreatedAgentRun(run),
    credits: await selectBalance(client, input.userId),
  });
}

export async function retryAgentRun(
  rawInput: {
    userId: string;
    sourceRunId: string;
    requestId: string;
  },
  database: Pool = getPool(),
): Promise<RetryRunResponse> {
  const input = {
    ...rawInput,
    userId: rawInput.userId.toLowerCase(),
    sourceRunId: rawInput.sourceRunId.toLowerCase(),
    requestId: rawInput.requestId.toLowerCase(),
  };

  const operation = async (client: PoolClient): Promise<RetryRunResponse> => {
    await lockChatRequestId(client, input.requestId);
    const existing = await existingRetryRunResponse(client, input);
    if (existing !== null) {
      return existing;
    }

    const conversationLock = await client.query<{
      conversation_id: string;
      selected_run_id: string | null;
    }>(
      `
        SELECT
          conversation.id AS conversation_id,
          conversation.selected_run_id
        FROM conversations conversation
        JOIN runs run ON run.conversation_id = conversation.id
        WHERE
          run.id = $1
          AND run.user_id = $2
          AND conversation.user_id = $2
          AND conversation.deleted_at IS NULL
          AND conversation.archived_at IS NULL
        FOR UPDATE OF conversation
      `,
      [input.sourceRunId, input.userId],
    );
    if (conversationLock.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }
    await assertRunOnSelectedPath(
      client,
      {
        conversationId: conversationLock.rows[0].conversation_id,
        selectedRunId: conversationLock.rows[0].selected_run_id,
        sourceRunId: input.sourceRunId,
      },
      "RUN_NOT_RETRYABLE",
    );

    const sourceResult = await client.query<RunRow>(
      `
        SELECT ${RUN_COLUMNS}
        FROM runs run
        WHERE run.id = $1 AND run.user_id = $2
        FOR UPDATE OF run
      `,
      [input.sourceRunId, input.userId],
    );
    if (sourceResult.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }
    const source = sourceResult.rows[0];
    const sourceExecutionConfig = parseRunExecutionConfig(
      source.execution_config,
    );
    if (sourceExecutionConfig.provenance !== "captured") {
      throw new AppError(
        "RUN_CONTEXT_UNAVAILABLE",
        "Run execution configuration is unavailable",
        409,
      );
    }
    if (source.status === "reconciliation_required") {
      throw new AppError(
        "RUN_REQUIRES_RECONCILIATION",
        "Run requires credit reconciliation and cannot be retried",
        409,
      );
    }
    if (source.status !== "failed" && source.status !== "cancelled") {
      throw new AppError(
        "RUN_NOT_RETRYABLE",
        "Only the latest failed or cancelled Run can be retried",
        409,
      );
    }
    if (source.input_message_id === null) {
      throw new AppError(
        "RUN_NOT_RETRYABLE",
        "Run has no durable input message to retry",
        409,
      );
    }

    const outstanding = await client.query<{
      has_off_branch_outstanding: boolean;
      waiting_leaf_id: string | null;
    }>(
      `
        WITH RECURSIVE source_ancestors AS (
          SELECT ancestor.id, ancestor.predecessor_run_id
          FROM runs ancestor
          WHERE
            ancestor.id = $3::uuid
            AND ancestor.conversation_id = $2
          UNION ALL
          SELECT ancestor.id, ancestor.predecessor_run_id
          FROM runs ancestor
          JOIN source_ancestors child
            ON ancestor.id = child.predecessor_run_id
          WHERE ancestor.conversation_id = $2
        ), retry_descendants AS (
          SELECT child.id, child.predecessor_run_id, 1 AS depth
          FROM runs child
          WHERE
            child.predecessor_run_id = $1
            AND child.status IN ('waiting', 'cancelled')
            AND child.model_started_at IS NULL
            AND child.started_at IS NULL
            AND child.attempt_count = 0
            AND NOT EXISTS (
              SELECT 1
              FROM run_session_snapshots snapshot
              WHERE snapshot.run_id = child.id AND snapshot.phase = 'pre'
            )
          UNION ALL
          SELECT child.id, child.predecessor_run_id, parent.depth + 1
          FROM runs child
          JOIN retry_descendants parent
            ON child.predecessor_run_id = parent.id
          WHERE
            child.status IN ('waiting', 'cancelled')
            AND child.model_started_at IS NULL
            AND child.started_at IS NULL
            AND child.attempt_count = 0
            AND NOT EXISTS (
              SELECT 1
              FROM run_session_snapshots snapshot
              WHERE snapshot.run_id = child.id AND snapshot.phase = 'pre'
            )
        ), locked_outstanding AS MATERIALIZED (
          SELECT outstanding.id, outstanding.status
          FROM runs outstanding
          WHERE
            outstanding.conversation_id = $2
            AND outstanding.status IN ('waiting', 'queued', 'running')
          FOR UPDATE OF outstanding
        )
        SELECT
          EXISTS (
            SELECT 1
            FROM locked_outstanding outstanding
            WHERE
              NOT EXISTS (
                SELECT 1
                FROM source_ancestors allowed
                WHERE allowed.id = outstanding.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM retry_descendants allowed
                WHERE allowed.id = outstanding.id
              )
          ) AS has_off_branch_outstanding,
          (
            SELECT descendant.id
            FROM retry_descendants descendant
            ORDER BY
              (descendant.id = $4::uuid) DESC,
              descendant.depth DESC,
              descendant.id DESC
            LIMIT 1
          ) AS waiting_leaf_id
      `,
      [
        source.id,
        source.conversation_id,
        source.predecessor_run_id,
        conversationLock.rows[0].selected_run_id,
      ],
    );
    if (outstanding.rows[0].has_off_branch_outstanding) {
      throw new AppError(
        "RUN_IN_PROGRESS",
        "Another branch already has an outstanding Run",
        409,
      );
    }
    const selectedRetryLeafId = outstanding.rows[0].waiting_leaf_id;

    const conflictingHistory = await client.query<{ exists: boolean }>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM runs newer_attempt
            WHERE
              newer_attempt.input_message_id = $1
              AND newer_attempt.attempt_index > $2
          )
          OR EXISTS (
            SELECT 1
            FROM runs direct_successor
            WHERE
              direct_successor.predecessor_run_id = $3
              AND NOT (
                direct_successor.status IN ('waiting', 'cancelled')
                AND direct_successor.model_started_at IS NULL
                AND direct_successor.started_at IS NULL
                AND direct_successor.attempt_count = 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM run_session_snapshots snapshot
                  WHERE
                    snapshot.run_id = direct_successor.id
                    AND snapshot.phase = 'pre'
                )
              )
          ) AS exists
      `,
      [
        source.input_message_id,
        source.attempt_index,
        source.id,
      ],
    );
    if (conflictingHistory.rows[0].exists) {
      throw new AppError(
        "RUN_NOT_RETRYABLE",
        "Run is no longer the latest retryable attempt",
        409,
      );
    }

    let retryStatus: "waiting" | "queued" = "queued";
    if (source.predecessor_run_id !== null) {
      const predecessorResult = await client.query<{
        status: AgentRunStatus;
      }>(
        `
          SELECT status
          FROM runs
          WHERE
            id = $1
            AND user_id = $2
            AND conversation_id = $3
          FOR UPDATE
        `,
        [
          source.predecessor_run_id,
          input.userId,
          source.conversation_id,
        ],
      );
      if (predecessorResult.rowCount !== 1) {
        throw new TypeError("Retry predecessor Run is missing");
      }
      if (predecessorResult.rows[0].status !== "completed") {
        const predecessorStatus = predecessorResult.rows[0].status;
        const interruptedSnapshot = (
          predecessorStatus === "cancelled" || predecessorStatus === "reconciliation_required"
        ) ? await readRunSessionSnapshot(source.predecessor_run_id, "post", client) : null;
        if (interruptedSnapshot === null) {
          retryStatus = "waiting";
        }
      }
    }

    await materializeRetrySourcePreRunContext(
      {
        userId: input.userId,
        conversationId: source.conversation_id,
        sourceRunId: source.id,
        allowDeferredPredecessor: retryStatus === "waiting",
      },
      client,
    );

    const assistantMessageId = randomUUID();
    const retryResult = await client.query<RunRow>(
      `
        INSERT INTO runs AS run (
          request_id,
          user_id,
          conversation_id,
          status,
          reservation_credits,
          input_message_id,
          assistant_message_id,
          request_fingerprint,
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
          $5,
          $6,
          $7,
          $8,
          $9::bigint,
          $10,
          $11,
          $12,
          NULL
        )
        RETURNING ${RUN_COLUMNS}
      `,
      [
        input.requestId,
        input.userId,
        source.conversation_id,
        retryStatus,
        sourceExecutionConfig.billing.reservationCredits,
        source.input_message_id,
        assistantMessageId,
        retryRequestFingerprint(source.id, sourceExecutionConfig),
        source.conversation_turn,
        source.attempt_index + 1,
        source.predecessor_run_id,
        source.id,
      ],
    );
    const insertedRetry = retryResult.rows[0];
    await copyCapturedRunExecutionConfig(source.id, insertedRetry.id, client);
    const configuredRetryResult = await client.query<RunRow>(
      `
        SELECT ${RUN_COLUMNS}
        FROM runs run
        WHERE run.id = $1
      `,
      [insertedRetry.id],
    );
    if (configuredRetryResult.rowCount !== 1) {
      throw new TypeError("Retry Run is missing after configuration capture");
    }
    const retry = configuredRetryResult.rows[0];

    await client.query(
      `
        UPDATE runs successor
        SET predecessor_run_id = $2, updated_at = now()
        WHERE
          successor.predecessor_run_id = $1
          AND successor.status IN ('waiting', 'cancelled')
          AND successor.model_started_at IS NULL
          AND successor.started_at IS NULL
          AND successor.attempt_count = 0
          AND NOT EXISTS (
            SELECT 1
            FROM run_session_snapshots snapshot
            WHERE snapshot.run_id = successor.id AND snapshot.phase = 'pre'
          )
      `,
      [source.id, retry.id],
    );

    const credits = await reserveCreditsForRunInTransaction(
      {
        userId: input.userId,
        runId: retry.id,
        reservationCredits: sourceExecutionConfig.billing.reservationCredits,
      },
      client,
    );
    await client.query(
      `
        UPDATE conversations
        SET selected_run_id = $3, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `,
      [
        source.conversation_id,
        input.userId,
        selectedRetryLeafId ?? retry.id,
      ],
    );
    const conversation = await getConversation(
      input.userId,
      source.conversation_id,
      client,
    );
    if (conversation === null) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }
    return RetryRunResponseSchema.parse({
      conversation,
      run: mapCreatedAgentRun(retry),
      credits,
    });
  };

  try {
    return await withTransaction(operation, database);
  } catch (error) {
    if (isRequestIdConflict(error)) {
      const existing = await withTransaction(
        (client) => existingRetryRunResponse(client, input),
        database,
      );
      if (existing !== null) {
        return existing;
      }
    }
    throw error;
  }
}

async function existingRegenerateRunResponse(
  client: PoolClient,
  input: {
    userId: string;
    sourceRunId: string;
    requestId: string;
  },
): Promise<RegenerateRunResponse | null> {
  const result = await client.query<RunRow>(
    `
      SELECT ${RUN_COLUMNS}
      FROM runs run
      WHERE run.request_id = $1
    `,
    [input.requestId],
  );
  if (result.rowCount === 0) {
    return null;
  }
  const run = result.rows[0];
  const executionConfig = parseRunExecutionConfig(run.execution_config);
  if (
    executionConfig.provenance !== "captured" ||
    run.user_id !== input.userId ||
    run.retry_of_run_id !== null ||
    run.regenerate_of_run_id !== input.sourceRunId ||
    run.request_fingerprint !==
      regenerateRequestFingerprint(input.sourceRunId, executionConfig) ||
    run.input_message_id === null ||
    run.assistant_message_id === null
  ) {
    throw new AppError(
      "RUN_ALREADY_EXISTS",
      "Request ID is already bound to a different run",
      409,
    );
  }

  const conversation = await getConversation(
    input.userId,
    run.conversation_id,
    client,
  );
  if (conversation === null) {
    throw new AppError("NOT_FOUND", "Conversation was not found", 404);
  }
  return RegenerateRunResponseSchema.parse({
    conversation,
    run: mapCreatedAgentRun(run),
    credits: await selectBalance(client, input.userId),
  });
}

export async function regenerateAgentRun(
  rawInput: {
    userId: string;
    sourceRunId: string;
    requestId: string;
  },
  database: Pool = getPool(),
): Promise<RegenerateRunResponse> {
  const input = {
    ...rawInput,
    userId: rawInput.userId.toLowerCase(),
    sourceRunId: rawInput.sourceRunId.toLowerCase(),
    requestId: rawInput.requestId.toLowerCase(),
  };

  const operation = async (
    client: PoolClient,
  ): Promise<RegenerateRunResponse> => {
    await lockChatRequestId(client, input.requestId);
    const existing = await existingRegenerateRunResponse(client, input);
    if (existing !== null) {
      return existing;
    }

    const conversationLock = await client.query<{
      conversation_id: string;
      selected_run_id: string | null;
    }>(
      `
        SELECT
          conversation.id AS conversation_id,
          conversation.selected_run_id
        FROM conversations conversation
        JOIN runs run ON run.conversation_id = conversation.id
        WHERE
          run.id = $1
          AND run.user_id = $2
          AND conversation.user_id = $2
          AND conversation.deleted_at IS NULL
          AND conversation.archived_at IS NULL
        FOR UPDATE OF conversation
      `,
      [input.sourceRunId, input.userId],
    );
    if (conversationLock.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }
    await assertRunOnSelectedPath(
      client,
      {
        conversationId: conversationLock.rows[0].conversation_id,
        selectedRunId: conversationLock.rows[0].selected_run_id,
        sourceRunId: input.sourceRunId,
      },
      "RUN_NOT_REGENERATABLE",
    );

    const sourceResult = await client.query<RunRow>(
      `
        SELECT ${RUN_COLUMNS}
        FROM runs run
        WHERE run.id = $1 AND run.user_id = $2
        FOR UPDATE OF run
      `,
      [input.sourceRunId, input.userId],
    );
    if (sourceResult.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }
    const source = sourceResult.rows[0];
    const sourceExecutionConfig = parseRunExecutionConfig(
      source.execution_config,
    );
    if (sourceExecutionConfig.provenance !== "captured") {
      throw new AppError(
        "RUN_CONTEXT_UNAVAILABLE",
        "Run execution configuration is unavailable",
        409,
      );
    }
    if (source.status !== "completed") {
      throw new AppError(
        "RUN_NOT_REGENERATABLE",
        "Only the latest completed Run can be regenerated",
        409,
      );
    }
    if (
      source.input_message_id === null ||
      source.assistant_message_id === null
    ) {
      throw new AppError(
        "RUN_CONTEXT_UNAVAILABLE",
        "Run regeneration context is unavailable",
        409,
      );
    }

    const blockers = await client.query<{
      has_outstanding: boolean;
      has_higher_attempt: boolean;
    }>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM runs outstanding
            WHERE
              outstanding.conversation_id = $1
              AND outstanding.status IN ('waiting', 'queued', 'running')
          ) AS has_outstanding,
          EXISTS (
            SELECT 1
            FROM runs newer_attempt
            WHERE
              newer_attempt.input_message_id = $2
              AND newer_attempt.attempt_index > $3
          ) AS has_higher_attempt
      `,
      [
        source.conversation_id,
        source.input_message_id,
        source.attempt_index,
      ],
    );
    const blocker = blockers.rows[0];
    if (
      blocker.has_outstanding ||
      blocker.has_higher_attempt
    ) {
      throw new AppError(
        "RUN_NOT_REGENERATABLE",
        "Run is no longer the latest selected attempt",
        409,
      );
    }

    const durableContext = await client.query<{
      has_pre_snapshot: boolean;
      has_assistant_message: boolean;
    }>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM run_session_snapshots snapshot
            WHERE snapshot.run_id = $1 AND snapshot.phase = 'pre'
          ) AS has_pre_snapshot,
          EXISTS (
            SELECT 1
            FROM messages assistant_message
            WHERE
              assistant_message.id = $2
              AND assistant_message.conversation_id = $3
              AND assistant_message.run_id = $1
              AND assistant_message.role = 'assistant'
          ) AS has_assistant_message
      `,
      [
        source.id,
        source.assistant_message_id,
        source.conversation_id,
      ],
    );
    if (
      !durableContext.rows[0].has_pre_snapshot ||
      !durableContext.rows[0].has_assistant_message
    ) {
      throw new AppError(
        "RUN_CONTEXT_UNAVAILABLE",
        "Run regeneration context is unavailable",
        409,
      );
    }

    const assistantMessageId = randomUUID();
    const regenerateResult = await client.query<RunRow>(
      `
        INSERT INTO runs AS run (
          request_id,
          user_id,
          conversation_id,
          status,
          reservation_credits,
          input_message_id,
          assistant_message_id,
          request_fingerprint,
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
          'queued',
          $4,
          $5,
          $6,
          $7,
          $8::bigint,
          $9,
          $10,
          NULL,
          $11
        )
        RETURNING ${RUN_COLUMNS}
      `,
      [
        input.requestId,
        input.userId,
        source.conversation_id,
        sourceExecutionConfig.billing.reservationCredits,
        source.input_message_id,
        assistantMessageId,
        regenerateRequestFingerprint(source.id, sourceExecutionConfig),
        source.conversation_turn,
        source.attempt_index + 1,
        source.predecessor_run_id,
        source.id,
      ],
    );
    const insertedRegenerate = regenerateResult.rows[0];
    await copyCapturedRunExecutionConfig(
      source.id,
      insertedRegenerate.id,
      client,
    );
    const configuredRegenerateResult = await client.query<RunRow>(
      `
        SELECT ${RUN_COLUMNS}
        FROM runs run
        WHERE run.id = $1
      `,
      [insertedRegenerate.id],
    );
    if (configuredRegenerateResult.rowCount !== 1) {
      throw new TypeError(
        "Regenerated Run is missing after configuration capture",
      );
    }
    const regenerate = configuredRegenerateResult.rows[0];

    const credits = await reserveCreditsForRunInTransaction(
      {
        userId: input.userId,
        runId: regenerate.id,
        reservationCredits: sourceExecutionConfig.billing.reservationCredits,
      },
      client,
    );
    await client.query(
      `
        UPDATE conversations
        SET selected_run_id = $3, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `,
      [source.conversation_id, input.userId, regenerate.id],
    );
    const conversation = await getConversation(
      input.userId,
      source.conversation_id,
      client,
    );
    if (conversation === null) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }
    return RegenerateRunResponseSchema.parse({
      conversation,
      run: mapCreatedAgentRun(regenerate),
      credits,
    });
  };

  try {
    return await withTransaction(operation, database);
  } catch (error) {
    if (isRequestIdConflict(error)) {
      const existing = await withTransaction(
        (client) => existingRegenerateRunResponse(client, input),
        database,
      );
      if (existing !== null) {
        return existing;
      }
    }
    throw error;
  }
}

export async function getAgentRun(
  userId: string,
  runId: string,
  database: Pool = getPool(),
): Promise<AgentRun | null> {
  const result = await database.query<RunRow>(
    `
      SELECT ${RUN_COLUMNS}
      FROM runs run
      JOIN conversations conversation ON conversation.id = run.conversation_id
      WHERE
        run.id = $1
        AND run.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
    `,
    [runId, userId],
  );
  return result.rowCount === 0 ? null : mapAgentRun(result.rows[0]);
}

export async function listConversationRuns(
  userId: string,
  conversationId: string,
  database: Queryable = getPool(),
): Promise<AgentRun[]> {
  const result = await database.query<RunRow>(
    `
      SELECT ${RUN_COLUMNS}
      FROM runs run
      JOIN conversations conversation ON conversation.id = run.conversation_id
      WHERE
        run.user_id = $1
        AND run.conversation_id = $2
        AND conversation.user_id = $1
        AND conversation.deleted_at IS NULL
      ORDER BY run.conversation_turn, run.attempt_index
    `,
    [userId, conversationId],
  );
  return result.rows.map(mapAgentRun);
}

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return terminalRunStatuses.has(status);
}

export async function insertRunEventInTransaction(
  runId: string,
  payload: RunEventPayload,
  client: PoolClient,
): Promise<RunEvent> {
  const parsed = RunEventPayloadSchema.parse(payload);
  const result = await client.query<EventRow>(
    `
      INSERT INTO run_events (run_id, event_type, payload)
      VALUES ($1, $2, $3::jsonb)
      RETURNING id::text, run_id, payload, created_at
    `,
    [runId, parsed.type, JSON.stringify(parsed)],
  );
  return mapEvent(result.rows[0]);
}

export async function appendRunEvent(
  lease: RunLease,
  payload: RunEventPayload,
  database: Pool = getPool(),
): Promise<RunEvent> {
  const parsed = RunEventPayloadSchema.parse(payload);
  const result = await database.query<EventRow>(
    `
      WITH locked_run AS MATERIALIZED (
        SELECT run.id, run.lease_expires_at
        FROM runs run
        WHERE
          run.id = $1
          AND run.status = 'running'
          AND run.lease_owner = $2
          AND run.lease_token = $3::bigint
        FOR UPDATE OF run
      ), wall_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS current_time
        FROM locked_run
      )
      INSERT INTO run_events (run_id, event_type, payload)
      SELECT locked_run.id, $4, $5::jsonb
      FROM locked_run, wall_clock
      WHERE
        locked_run.lease_expires_at > wall_clock.current_time
      RETURNING id::text, run_id, payload, created_at
    `,
    [
      lease.runId,
      lease.leaseOwner,
      lease.leaseToken,
      parsed.type,
      JSON.stringify(parsed),
    ],
  );
  if (result.rowCount !== 1) {
    throw new RunLeaseLostError(lease.runId);
  }
  return mapEvent(result.rows[0]);
}

export async function readRunEventBatch(
  input: {
    userId: string;
    runId: string;
    afterEventId: string;
    limit?: number;
  },
  database: Pool = getPool(),
): Promise<RunEventBatch | null> {
  if (!/^\d+$/u.test(input.afterEventId)) {
    throw new TypeError("afterEventId must be an unsigned integer string");
  }
  const limit = input.limit ?? 200;
  validatePositiveInteger(limit, "limit");

  const result = await database.query<RunRow & {
    event_id: string | null;
    event_run_id: string | null;
    event_payload: unknown | null;
    event_created_at: Date | null;
  }>(
    `
      SELECT
        ${RUN_COLUMNS},
        event.id::text AS event_id,
        event.run_id AS event_run_id,
        event.payload AS event_payload,
        event.created_at AS event_created_at
      FROM runs run
      JOIN conversations conversation ON conversation.id = run.conversation_id
      LEFT JOIN LATERAL (
        SELECT id, run_id, payload, created_at
        FROM run_events
        WHERE run_id = run.id AND id > $3::bigint
        ORDER BY id
        LIMIT $4
      ) event ON true
      WHERE
        run.id = $1
        AND run.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
      ORDER BY event.id
    `,
    [input.runId, input.userId, input.afterEventId, limit],
  );
  if (result.rowCount === 0) {
    return null;
  }

  const events: RunEvent[] = [];
  for (const row of result.rows) {
    if (row.event_id === null) {
      if (
        row.event_run_id !== null ||
        row.event_payload !== null ||
        row.event_created_at !== null
      ) {
        throw new TypeError("Run event fields are inconsistent");
      }
      continue;
    }
    if (
      row.event_run_id === null ||
      row.event_payload === null ||
      row.event_created_at === null
    ) {
      throw new TypeError("Run event fields are inconsistent");
    }
    events.push(
      mapEvent({
        id: row.event_id,
        run_id: row.event_run_id,
        payload: row.event_payload,
        created_at: row.event_created_at,
      }),
    );
  }
  return { run: mapAgentRun(result.rows[0]), events };
}

export async function claimNextRun(
  input: {
    workerId: string;
    leaseDurationMs: number;
    capability: RunWorkerCapability;
  },
  database: Pool = getPool(),
): Promise<ClaimedAgentRun | null> {
  validatePositiveInteger(input.leaseDurationMs, "leaseDurationMs");
  const capability = RunWorkerCapabilitySchema.parse(input.capability);
  const result = await database.query<
    RunRow & {
      input_content: string;
      input_attachment_ids: string[];
      custom_instructions_snapshot: string | null;
      custom_instructions_snapshot_revision: number;
    }
  >(
    `
      WITH candidate AS (
        SELECT run.id
        FROM runs run
        JOIN run_execution_configs config ON config.run_id = run.id
        WHERE
          run.status = 'queued'
          AND run.input_message_id IS NOT NULL
          AND run.assistant_message_id IS NOT NULL
          AND config.provenance = 'captured'
          AND config.provider = $3
          AND config.base_url = $4
          AND (
            config.reasoning_mode_enabled IS FALSE
            OR $5::boolean
          )
          AND (
            config.code_interpreter_enabled IS FALSE
            OR $6::boolean
          )
        ORDER BY run.created_at, run.id
        FOR UPDATE OF run SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE runs run
        SET
          status = 'running',
          started_at = now(),
          lease_owner = $1,
          lease_token = run.lease_token + 1,
          lease_expires_at = clock_timestamp() + ($2 * interval '1 millisecond'),
          heartbeat_at = clock_timestamp(),
          attempt_count = run.attempt_count + 1,
          updated_at = now()
        FROM candidate
        WHERE run.id = candidate.id
        RETURNING run.*
      )
      SELECT
        ${RUN_COLUMNS},
        input_message.content AS input_content,
        conversation.custom_instructions_snapshot,
        conversation.custom_instructions_snapshot_revision,
        ARRAY(
          SELECT message_attachment.attachment_id
          FROM message_input_attachments message_attachment
          WHERE message_attachment.message_id = input_message.id
          ORDER BY message_attachment.position
        ) AS input_attachment_ids
      FROM claimed run
      JOIN messages input_message ON input_message.id = run.input_message_id
      JOIN conversations conversation
        ON conversation.id = run.conversation_id
        AND conversation.user_id = run.user_id
    `,
    [
      input.workerId,
      input.leaseDurationMs,
      capability.provider,
      capability.baseUrl,
      capability.reasoningMode,
      capability.codeInterpreter,
    ],
  );
  if (result.rowCount === 0) {
    return null;
  }
  const row = result.rows[0];
  if (row.lease_owner === null) {
    throw new TypeError("Claimed run is missing its lease owner");
  }
  const executionConfig = parseRunExecutionConfig(row.execution_config);
  if (executionConfig.provenance !== "captured") {
    throw new TypeError("Claimed Run execution configuration is not captured");
  }
  let customInstructionsSnapshot: ClaimedAgentRun["customInstructionsSnapshot"] =
    null;
  if (row.custom_instructions_snapshot === null) {
    if (row.custom_instructions_snapshot_revision !== 0) {
      throw new TypeError(
        "Empty conversation custom instructions snapshot has a revision",
      );
    }
  } else {
    if (row.custom_instructions_snapshot_revision <= 0) {
      throw new TypeError(
        "Conversation custom instructions snapshot revision is invalid",
      );
    }
    customInstructionsSnapshot = {
      content: row.custom_instructions_snapshot,
      revision: row.custom_instructions_snapshot_revision,
    };
  }
  return {
    run: mapCreatedAgentRun(row),
    executionConfig,
    userId: row.user_id,
    input: row.input_content,
    inputAttachmentIds: row.input_attachment_ids,
    customInstructionsSnapshot,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
  };
}

export async function renewRunLease(
  lease: RunLease,
  leaseDurationMs: number,
  database: Pool = getPool(),
): Promise<LeaseHeartbeat> {
  validatePositiveInteger(leaseDurationMs, "leaseDurationMs");
  const result = await database.query<{ cancel_requested_at: Date | null }>(
    `
      WITH locked_run AS MATERIALIZED (
        SELECT id
        FROM runs
        WHERE
          id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND lease_token = $3::bigint
        FOR UPDATE
      ), wall_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS current_time
        FROM locked_run
      )
      UPDATE runs run
      SET
        heartbeat_at = wall_clock.current_time,
        lease_expires_at = wall_clock.current_time + ($4 * interval '1 millisecond'),
        updated_at = wall_clock.current_time
      FROM locked_run, wall_clock
      WHERE
        run.id = locked_run.id
        AND run.lease_expires_at > wall_clock.current_time
      RETURNING run.cancel_requested_at
    `,
    [lease.runId, lease.leaseOwner, lease.leaseToken, leaseDurationMs],
  );
  return result.rowCount === 0
    ? { owned: false, cancelRequested: false }
    : {
        owned: true,
        cancelRequested: result.rows[0].cancel_requested_at !== null,
      };
}

export async function markRunModelStarted(
  lease: RunLease,
  database: Pool = getPool(),
): Promise<void> {
  const result = await database.query<{ id: string }>(
    `
      WITH locked_run AS MATERIALIZED (
        SELECT id
        FROM runs
        WHERE
          id = $1
          AND status = 'running'
          AND lease_owner = $2
          AND lease_token = $3::bigint
        FOR UPDATE
      ), wall_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS current_time
        FROM locked_run
      )
      UPDATE runs run
      SET
        model_started_at = wall_clock.current_time,
        updated_at = wall_clock.current_time
      FROM locked_run, wall_clock
      WHERE
        run.id = locked_run.id
        AND run.lease_expires_at > wall_clock.current_time
        AND run.cancel_requested_at IS NULL
        AND run.model_started_at IS NULL
      RETURNING run.id
    `,
    [lease.runId, lease.leaseOwner, lease.leaseToken],
  );
  if (result.rowCount !== 1) {
    throw new RunLeaseLostError(lease.runId);
  }
}

async function selectCreditForUpdate(
  client: PoolClient,
  userId: string,
): Promise<CreditRow> {
  const result = await client.query<CreditRow>(
    `
      SELECT available_credits, reserved_credits, frozen_credits
      FROM users
      WHERE id = $1
      FOR UPDATE
    `,
    [userId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }
  return result.rows[0];
}

async function lockOwnedRunConversationInTransaction(
  client: PoolClient,
  userId: string,
  runId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `
      SELECT conversation.id
      FROM conversations conversation
      JOIN runs run ON run.conversation_id = conversation.id
      WHERE
        run.id = $1
        AND run.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
      FOR UPDATE OF conversation
    `,
    [runId, userId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Run was not found", 404);
  }
}

async function lockLeasedRunConversationInTransaction(
  client: PoolClient,
  lease: RunLease,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `
      SELECT conversation.id
      FROM conversations conversation
      JOIN runs run ON run.conversation_id = conversation.id
      WHERE
        run.id = $1
        AND run.status = 'running'
        AND run.lease_owner = $2
        AND run.lease_token = $3::bigint
      FOR UPDATE OF conversation
    `,
    [lease.runId, lease.leaseOwner, lease.leaseToken],
  );
  if (result.rowCount !== 1) {
    throw new RunLeaseLostError(lease.runId);
  }

  const leaseResult = await client.query<{ id: string }>(
    `
      SELECT run.id
      FROM runs run
      WHERE
        run.id = $1
        AND run.status = 'running'
        AND run.lease_owner = $2
        AND run.lease_token = $3::bigint
        AND run.lease_expires_at > clock_timestamp()
      FOR UPDATE OF run
    `,
    [lease.runId, lease.leaseOwner, lease.leaseToken],
  );
  if (leaseResult.rowCount !== 1) {
    throw new RunLeaseLostError(lease.runId);
  }
}

async function releaseRunInTransaction(
  input: {
    run: RunRow;
    status: "failed" | "cancelled";
    failureCode: string;
    failureMessage: string;
  },
  client: PoolClient,
): Promise<AgentRun> {
  await selectCreditForUpdate(client, input.run.user_id);
  await client.query(
    `
      UPDATE users
      SET
        available_credits = available_credits + $2,
        reserved_credits = reserved_credits - $2,
        updated_at = now()
      WHERE id = $1
    `,
    [input.run.user_id, input.run.reservation_credits],
  );
  const result = await client.query<RunRow>(
    `
      UPDATE runs run
      SET
        status = $2,
        failure_code = $3,
        failure_message = $4,
        finished_at = now(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = now()
      WHERE run.id = $1
      RETURNING ${RUN_COLUMNS}
    `,
    [
      input.run.id,
      input.status,
      input.failureCode,
      input.failureMessage,
    ],
  );
  await client.query(
    `
      INSERT INTO credit_ledger (
        user_id,
        run_id,
        idempotency_key,
        entry_type,
        available_delta,
        reserved_delta,
        frozen_delta
      )
      VALUES ($1, $2, $3, 'release', $4, $5, 0)
    `,
    [
      input.run.user_id,
      input.run.id,
      `${input.run.id}:release`,
      input.run.reservation_credits,
      -input.run.reservation_credits,
    ],
  );
  await insertRunEventInTransaction(
    input.run.id,
    {
      type: "error",
      error: {
        code: input.failureCode,
        message: input.failureMessage,
        runId: input.run.id,
      },
    },
    client,
  );
  return mapAgentRun(result.rows[0]);
}

async function freezeRunInTransaction(
  input: {
    run: RunRow;
    reconciliationReason: string;
  },
  client: PoolClient,
): Promise<{ run: AgentRun; credits: CreditBalance }> {
  await selectCreditForUpdate(client, input.run.user_id);
  const balanceResult = await client.query<CreditRow>(
    `
      UPDATE users
      SET
        reserved_credits = reserved_credits - $2,
        frozen_credits = frozen_credits + $2,
        updated_at = now()
      WHERE id = $1
      RETURNING available_credits, reserved_credits, frozen_credits
    `,
    [input.run.user_id, input.run.reservation_credits],
  );
  const result = await client.query<RunRow>(
    `
      UPDATE runs run
      SET
        status = 'reconciliation_required',
        reconciliation_reason = $2,
        failure_code = $3,
        failure_message = $4,
        finished_at = now(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = now()
      WHERE run.id = $1
      RETURNING ${RUN_COLUMNS}
    `,
    [
      input.run.id,
      input.reconciliationReason,
      RECONCILIATION_FAILURE.code,
      RECONCILIATION_FAILURE.message,
    ],
  );
  await client.query(
    `
      INSERT INTO credit_ledger (
        user_id,
        run_id,
        idempotency_key,
        entry_type,
        available_delta,
        reserved_delta,
        frozen_delta
      )
      VALUES ($1, $2, $3, 'freeze', 0, $4, $5)
    `,
    [
      input.run.user_id,
      input.run.id,
      `${input.run.id}:freeze`,
      -input.run.reservation_credits,
      input.run.reservation_credits,
    ],
  );
  await insertRunEventInTransaction(
    input.run.id,
    {
      type: "error",
      error: {
        code: RECONCILIATION_FAILURE.code,
        message: RECONCILIATION_FAILURE.message,
        runId: input.run.id,
      },
    },
    client,
  );
  return {
    run: mapAgentRun(result.rows[0]),
    credits: mapBalance(balanceResult.rows[0]),
  };
}

export async function failClaimedRun(
  input: {
    lease: RunLease;
    errorName: string;
    eventCode?: string;
    eventMessage?: string;
  },
  database: Pool = getPool(),
): Promise<AgentRun> {
  return withTransaction(async (client) => {
    await lockLeasedRunConversationInTransaction(client, input.lease);
    const runResult = await client.query<RunRow>(
      `
        WITH locked_run AS MATERIALIZED (
          SELECT ${RUN_COLUMNS}
          FROM runs run
          WHERE
            run.id = $1
            AND run.status = 'running'
            AND run.lease_owner = $2
            AND run.lease_token = $3::bigint
          FOR UPDATE OF run
        )
        SELECT *
        FROM locked_run
        WHERE lease_expires_at > clock_timestamp()
      `,
      [input.lease.runId, input.lease.leaseOwner, input.lease.leaseToken],
    );
    if (runResult.rowCount !== 1) {
      throw new RunLeaseLostError(input.lease.runId);
    }
    const run = runResult.rows[0];
    if (run.model_started_at === null) {
      return releaseRunInTransaction(
        {
          run,
          status: "failed",
          failureCode: input.eventCode ?? "INTERNAL_ERROR",
          failureMessage:
            input.eventMessage ??
            "这次运行未能开始，预扣积分已退回。",
        },
        client,
      );
    }
    const cancellationRequested = run.cancel_requested_at !== null;
    const frozen = await freezeRunInTransaction(
      {
        run,
        reconciliationReason: cancellationRequested
          ? "Agent run ended after cancellation was requested"
          : `Agent run ended before settlement: ${input.errorName}`,
      },
      client,
    );
    return frozen.run;
  }, database);
}

export async function cancelAgentRun(
  userId: string,
  runId: string,
  database: Pool = getPool(),
): Promise<AgentRun> {
  return withTransaction(async (client) => {
    await lockOwnedRunConversationInTransaction(client, userId, runId);
    const result = await client.query<RunRow>(
      `
        SELECT ${RUN_COLUMNS}
        FROM runs run
        JOIN conversations conversation ON conversation.id = run.conversation_id
        WHERE
          run.id = $1
          AND run.user_id = $2
          AND conversation.user_id = $2
          AND conversation.deleted_at IS NULL
        FOR UPDATE OF run
      `,
      [runId, userId],
    );
    if (result.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }
    const run = result.rows[0];
    if (isTerminalRunStatus(run.status)) {
      return mapAgentRun(run);
    }
    if (run.status === "queued" || run.model_started_at === null) {
      return releaseRunInTransaction(
        {
          run,
          status: "cancelled",
          failureCode: "RUN_CANCELLED",
          failureMessage: "运行已停止，预扣积分已退回。",
        },
        client,
      );
    }

    const expiredCancellation = await client.query<RunRow>(
      `
        UPDATE runs run
        SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
        WHERE
          run.id = $1
          AND run.status = 'running'
          AND (
            run.lease_owner IS NULL
            OR run.lease_expires_at IS NULL
            OR run.lease_expires_at <= clock_timestamp()
          )
        RETURNING ${RUN_COLUMNS}
      `,
      [run.id],
    );
    if (expiredCancellation.rowCount === 1) {
      const frozen = await freezeRunInTransaction(
        {
          run: expiredCancellation.rows[0],
          reconciliationReason:
            "Worker lease expired after cancellation was requested",
        },
        client,
      );
      return frozen.run;
    }

    const updated = await client.query<RunRow>(
      `
        UPDATE runs run
        SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now()
        WHERE run.id = $1
        RETURNING ${RUN_COLUMNS}
      `,
      [run.id],
    );
    return mapAgentRun(updated.rows[0]);
  }, database);
}

export type CompleteClaimedRunResult =
  | {
      kind: "completed";
      message: ReturnType<typeof ChatMessageSchema.parse>;
      credits: CreditBalance;
    }
  | {
      kind: "reconciliation_required";
      credits: CreditBalance;
    };

export async function completeClaimedRun(
  input: {
    lease: RunLease;
    userId: string;
    conversationId: string;
    assistantMessageId: string;
    content: string;
    citations: Citation[];
    usage: {
      inputTokens: number;
      outputTokens: number;
      webSearches: number;
    };
    sessionItems: AgentInputItem[];
  },
  database: Pool = getPool(),
): Promise<CompleteClaimedRunResult> {
  return withTransaction(async (client) => {
    await lockOwnedRunConversationInTransaction(
      client,
      input.userId,
      input.lease.runId,
    );
    const owned = await client.query<RunRow>(
      `
        WITH locked_run AS MATERIALIZED (
          SELECT ${RUN_COLUMNS}
          FROM runs run
          WHERE
            run.id = $1
            AND run.user_id = $2
            AND run.conversation_id = $3
            AND run.assistant_message_id = $4
            AND run.status = 'running'
            AND run.lease_owner = $5
            AND run.lease_token = $6::bigint
          FOR UPDATE OF run
        )
        SELECT *
        FROM locked_run
        WHERE lease_expires_at > clock_timestamp()
      `,
      [
        input.lease.runId,
        input.userId,
        input.conversationId,
        input.assistantMessageId,
        input.lease.leaseOwner,
        input.lease.leaseToken,
      ],
    );
    if (owned.rowCount !== 1) {
      throw new RunLeaseLostError(input.lease.runId);
    }
    const ownedRun = owned.rows[0];
    if (ownedRun.cancel_requested_at !== null) {
      const frozen = await freezeRunInTransaction(
        {
          run: ownedRun,
          reconciliationReason:
            "Agent completion arrived after cancellation was requested",
        },
        client,
      );
      return {
        kind: "reconciliation_required",
        credits: frozen.credits,
      };
    }

    const finalized = await finalizeSuccessfulChatRunInTransaction(
      {
        userId: input.userId,
        conversationId: input.conversationId,
        runId: input.lease.runId,
        assistantMessageId: input.assistantMessageId,
        content: input.content,
        citations: input.citations,
        usage: input.usage,
      },
      client,
    );
    if (finalized.kind === "reconciliation_required") {
      await insertRunEventInTransaction(
        input.lease.runId,
        {
          type: "error",
          error: {
            code: RECONCILIATION_FAILURE.code,
            message: RECONCILIATION_FAILURE.message,
            runId: input.lease.runId,
          },
        },
        client,
      );
      return {
        kind: "reconciliation_required",
        credits: finalized.credits,
      };
    }

    await writeRunSessionSnapshot(
      input.lease.runId,
      "post",
      input.sessionItems,
      client,
    );
    await insertRunEventInTransaction(
      input.lease.runId,
      {
        type: "done",
        message: finalized.value.message,
        credits: finalized.value.credits,
      },
      client,
    );
    return {
      kind: "completed",
      message: finalized.value.message,
      credits: finalized.value.credits,
    };
  }, database);
}

async function recoverOneAbandonedRun(
  database: Pool,
): Promise<boolean> {
  return withTransaction(async (client) => {
    // Recovery is a leaf lock path: after claiming a Run it may lock credits,
    // but it must never acquire a conversation lock (run -> credits only).
    const result = await client.query<RunRow>(
      `
        WITH candidate AS MATERIALIZED (
          SELECT run.id
          FROM runs run
          WHERE
            (
              run.status = 'queued'
              AND (
                run.input_message_id IS NULL
                OR run.assistant_message_id IS NULL
              )
            )
            OR
            (
              run.status = 'running'
              AND (
                run.lease_owner IS NULL
                OR run.lease_expires_at IS NULL
                OR run.lease_expires_at <= clock_timestamp()
              )
            )
          ORDER BY run.created_at, run.id
          FOR UPDATE OF run SKIP LOCKED
          LIMIT 1
        )
        SELECT ${RUN_COLUMNS}
        FROM runs run
        JOIN candidate ON candidate.id = run.id
      `,
    );
    if (result.rowCount === 0) {
      return false;
    }
    const run = result.rows[0];
    const canRequeue =
      run.status === "running" &&
      run.model_started_at === null &&
      run.cancel_requested_at === null &&
      run.input_message_id !== null &&
      run.assistant_message_id !== null;
    if (canRequeue) {
      await client.query(
        `
          UPDATE runs
          SET
            status = 'queued',
            started_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            updated_at = now()
          WHERE id = $1
        `,
        [run.id],
      );
      return true;
    }

    const cancellationRequested = run.cancel_requested_at !== null;
    await freezeRunInTransaction(
      {
        run,
        reconciliationReason:
          cancellationRequested
            ? "Worker lease expired after cancellation was requested"
            : run.status === "queued"
            ? "Legacy queued run cannot be executed because its durable input is missing"
            : "Worker lease expired after the run may have started",
      },
      client,
    );
    return true;
  }, database);
}

export async function recoverAbandonedRuns(
  input: { maxRuns?: number } = {},
  database: Pool = getPool(),
): Promise<number> {
  const maxRuns = input.maxRuns ?? 100;
  validatePositiveInteger(maxRuns, "maxRuns");
  let recovered = 0;
  while (
    recovered < maxRuns &&
    (await recoverOneAbandonedRun(database))
  ) {
    recovered += 1;
  }
  return recovered;
}
