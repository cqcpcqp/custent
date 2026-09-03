import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  BranchConversationRequestSchema,
  BranchConversationResponseSchema,
  type BranchConversationRequest,
  type BranchConversationResponse,
} from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { bindInputAttachmentsToMessage } from "@/lib/input-attachments";

import { createConversation, getConversation } from "./conversations";
import { getPool, withTransaction } from "./pool";

type ExistingBranchRow = {
  user_id: string;
  source_conversation_id: string;
  source_message_id: string;
  target_conversation_id: string;
};

type SourceRunRow = {
  run_id: string;
  conversation_turn: string;
  predecessor_run_id: string | null;
  status: string;
  input_message_id: string;
  assistant_message_id: string;
};

type SourceMessageRow = {
  source_message_id: string;
  source_run_id: string | null;
  role: "user" | "assistant";
  content: string;
  citations: unknown;
  input_attachment_ids: string[];
};

type SnapshotMetadataRow = {
  item_count: number;
};

function normalizeRequest(request: BranchConversationRequest) {
  const parsed = BranchConversationRequestSchema.parse(request);
  return {
    requestId: parsed.requestId.toLowerCase(),
    sourceMessageId: parsed.sourceMessageId.toLowerCase(),
  };
}

async function lockBranchRequestId(
  client: PoolClient,
  requestId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [requestId],
  );
}

async function existingBranchResponse(
  client: PoolClient,
  input: {
    userId: string;
    sourceConversationId: string;
    sourceMessageId: string;
    requestId: string;
  },
): Promise<BranchConversationResponse | null> {
  const result = await client.query<ExistingBranchRow>(
    `
      SELECT
        user_id,
        source_conversation_id,
        source_message_id,
        target_conversation_id
      FROM conversation_branch_requests
      WHERE request_id = $1
    `,
    [input.requestId],
  );
  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  if (
    row.user_id !== input.userId ||
    row.source_conversation_id !== input.sourceConversationId ||
    row.source_message_id !== input.sourceMessageId
  ) {
    throw new AppError(
      "BRANCH_ALREADY_EXISTS",
      "请求 ID 已用于创建另一个对话分支。",
      409,
    );
  }

  const conversation = await getConversation(
    input.userId,
    row.target_conversation_id,
    client,
  );
  if (conversation === null) {
    throw new AppError("NOT_FOUND", "分支对话不存在。", 404);
  }
  return BranchConversationResponseSchema.parse({ conversation });
}

async function lockSourceConversation(
  client: PoolClient,
  userId: string,
  conversationId: string,
): Promise<{ id: string; title: string; selected_run_id: string | null }> {
  const result = await client.query<{
    id: string;
    title: string;
    selected_run_id: string | null;
  }>(
    `
      SELECT id, title, selected_run_id
      FROM conversations
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `,
    [conversationId, userId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "源对话不存在。", 404);
  }
  return result.rows[0];
}

async function readSourcePath(
  client: PoolClient,
  input: {
    userId: string;
    conversationId: string;
    selectedRunId: string;
    sourceMessageId: string;
  },
): Promise<SourceRunRow[]> {
  const result = await client.query<SourceRunRow>(
    `
      WITH RECURSIVE selected_path AS (
        SELECT
          selected_run.id,
          selected_run.conversation_turn,
          selected_run.predecessor_run_id,
          selected_run.status,
          selected_run.input_message_id,
          selected_run.assistant_message_id
        FROM runs selected_run
        WHERE
          selected_run.id = $3
          AND selected_run.user_id = $1
          AND selected_run.conversation_id = $2
        UNION ALL
        SELECT
          predecessor.id,
          predecessor.conversation_turn,
          predecessor.predecessor_run_id,
          predecessor.status,
          predecessor.input_message_id,
          predecessor.assistant_message_id
        FROM runs predecessor
        JOIN selected_path child ON child.predecessor_run_id = predecessor.id
        WHERE
          predecessor.user_id = $1
          AND predecessor.conversation_id = $2
      )
      SELECT
        path_run.id AS run_id,
        path_run.conversation_turn::text AS conversation_turn,
        path_run.predecessor_run_id,
        path_run.status,
        path_run.input_message_id,
        path_run.assistant_message_id
      FROM selected_path path_run
      ORDER BY path_run.conversation_turn
    `,
    [input.userId, input.conversationId, input.selectedRunId],
  );

  if (result.rows.length === 0) {
    throw new TypeError("Selected conversation branch could not be read");
  }

  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    const expectedTurn = BigInt(index + 1);
    if (BigInt(row.conversation_turn) !== expectedTurn) {
      throw new TypeError("Source branch conversation turns are not contiguous");
    }
    const expectedPredecessor = index === 0 ? null : result.rows[index - 1].run_id;
    if (row.predecessor_run_id !== expectedPredecessor) {
      throw new TypeError("Source branch predecessor chain is inconsistent");
    }
  }

  const targetIndex = result.rows.findIndex(
    (row) => row.assistant_message_id === input.sourceMessageId,
  );
  if (targetIndex === -1 || result.rows[targetIndex].status !== "completed") {
    throw new AppError(
      "INVALID_BRANCH_TARGET",
      "只能从当前选中分支中已完成的助手回答创建新对话。",
      409,
    );
  }
  return result.rows.slice(0, targetIndex + 1);
}

async function readSourceMessages(
  client: PoolClient,
  input: {
    conversationId: string;
    sourceMessageId: string;
    sourceRuns: SourceRunRow[];
  },
): Promise<SourceMessageRow[]> {
  const runIds = input.sourceRuns.map((run) => run.run_id);
  const inputMessageIds = input.sourceRuns.map((run) => run.input_message_id);
  const assistantMessageIds = input.sourceRuns.map(
    (run) => run.assistant_message_id,
  );
  const targetRunId = input.sourceRuns[input.sourceRuns.length - 1].run_id;
  const result = await client.query<SourceMessageRow>(
    `
      WITH source_path AS (
        SELECT *
        FROM unnest(
          $2::uuid[],
          $3::uuid[],
          $4::uuid[]
        ) AS path_run(run_id, input_message_id, assistant_message_id)
      ), target_message AS (
        SELECT message.id, message.created_at
        FROM messages message
        WHERE
          message.id = $5
          AND message.conversation_id = $1
          AND message.run_id = $6
          AND message.role = 'assistant'
      )
      SELECT
        source_message.id AS source_message_id,
        source_message.run_id AS source_run_id,
        source_message.role,
        source_message.content,
        source_message.citations,
        ARRAY(
          SELECT link.attachment_id
          FROM message_input_attachments link
          WHERE link.message_id = source_message.id
          ORDER BY link.position
        ) AS input_attachment_ids
      FROM messages source_message
      CROSS JOIN target_message
      WHERE
        source_message.conversation_id = $1
        AND source_message.created_at <= target_message.created_at
        AND (
          source_message.run_id IS NULL
          OR (
            source_message.role = 'user'
            AND EXISTS (
              SELECT 1
              FROM source_path path_run
              WHERE
                path_run.run_id = source_message.run_id
                AND path_run.input_message_id = source_message.id
            )
          )
          OR (
            source_message.role = 'assistant'
            AND EXISTS (
              SELECT 1
              FROM source_path path_run
              WHERE
                path_run.run_id = source_message.run_id
                AND path_run.assistant_message_id = source_message.id
            )
          )
        )
      ORDER BY source_message.created_at, source_message.id
    `,
    [
      input.conversationId,
      runIds,
      inputMessageIds,
      assistantMessageIds,
      input.sourceMessageId,
      targetRunId,
    ],
  );

  const sourceMessageIds = new Set(
    result.rows.map((message) => message.source_message_id),
  );
  if (!sourceMessageIds.has(input.sourceMessageId)) {
    throw new AppError(
      "INVALID_BRANCH_TARGET",
      "只能从当前选中分支中已完成的助手回答创建新对话。",
      409,
    );
  }
  for (const run of input.sourceRuns) {
    if (!sourceMessageIds.has(run.input_message_id)) {
      throw new TypeError(
        `Source branch Run ${run.run_id} is missing its input message`,
      );
    }
  }
  return result.rows;
}

async function copyConversationMessages(
  client: PoolClient,
  input: {
    userId: string;
    targetConversationId: string;
    sourceMessages: SourceMessageRow[];
  },
): Promise<void> {
  const messageCount = input.sourceMessages.length;
  let ordinal = 0;

  for (const sourceMessage of input.sourceMessages) {
    const messageId = randomUUID();
    ordinal += 1;
    await client.query(
      `
        INSERT INTO messages (
          id,
          conversation_id,
          role,
          content,
          citations,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5::jsonb,
          now() - (($7::integer - $6::integer + 1) * interval '1 millisecond')
        )
      `,
      [
        messageId,
        input.targetConversationId,
        sourceMessage.role,
        sourceMessage.content,
        JSON.stringify(sourceMessage.citations),
        ordinal,
        messageCount,
      ],
    );
    if (sourceMessage.role === "user") {
      await bindInputAttachmentsToMessage(
        {
          userId: input.userId,
          messageId,
          attachmentIds: sourceMessage.input_attachment_ids,
          sourceMessageId: sourceMessage.source_message_id,
        },
        client,
      );
    }
  }
}

async function copyConversationContextSeed(
  client: PoolClient,
  input: {
    userId: string;
    sourceConversationId: string;
    sourceMessageId: string;
    sourceRunId: string;
    targetConversationId: string;
  },
): Promise<void> {
  const snapshot = await client.query<SnapshotMetadataRow>(
    `
      SELECT item_count
      FROM run_session_snapshots
      WHERE run_id = $1 AND phase = 'post'
    `,
    [input.sourceRunId],
  );
  if (snapshot.rowCount !== 1) {
    throw new AppError(
      "RUN_CONTEXT_UNAVAILABLE",
      "这条回答的完整上下文不可用，暂时不能创建分支。",
      409,
    );
  }

  await client.query(
    `
      INSERT INTO conversation_context_seeds (
        conversation_id,
        user_id,
        source_conversation_id,
        source_message_id,
        source_run_id,
        item_count
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      input.targetConversationId,
      input.userId,
      input.sourceConversationId,
      input.sourceMessageId,
      input.sourceRunId,
      snapshot.rows[0].item_count,
    ],
  );
  await client.query(
    `
      INSERT INTO conversation_context_seed_items (
        conversation_id,
        position,
        item
      )
      SELECT $1, position, item
      FROM run_session_snapshot_items
      WHERE run_id = $2 AND phase = 'post'
      ORDER BY position
    `,
    [input.targetConversationId, input.sourceRunId],
  );
}

export async function branchConversationFromMessage(
  input: {
    userId: string;
    sourceConversationId: string;
    request: BranchConversationRequest;
  },
  database: Pool = getPool(),
): Promise<BranchConversationResponse> {
  const userId = input.userId.toLowerCase();
  const sourceConversationId = input.sourceConversationId.toLowerCase();
  const request = normalizeRequest(input.request);

  return withTransaction(async (client) => {
    await lockBranchRequestId(client, request.requestId);
    const existing = await existingBranchResponse(client, {
      userId,
      sourceConversationId,
      sourceMessageId: request.sourceMessageId,
      requestId: request.requestId,
    });
    if (existing !== null) {
      return existing;
    }

    const sourceConversation = await lockSourceConversation(
      client,
      userId,
      sourceConversationId,
    );
    if (sourceConversation.selected_run_id === null) {
      throw new AppError(
        "INVALID_BRANCH_TARGET",
        "只能从当前选中分支中已完成的助手回答创建新对话。",
        409,
      );
    }
    const sourceRuns = await readSourcePath(client, {
      userId,
      conversationId: sourceConversationId,
      selectedRunId: sourceConversation.selected_run_id,
      sourceMessageId: request.sourceMessageId,
    });
    const sourceRun = sourceRuns[sourceRuns.length - 1];
    const sourceMessages = await readSourceMessages(client, {
      conversationId: sourceConversationId,
      sourceMessageId: request.sourceMessageId,
      sourceRuns,
    });

    const targetConversation = await createConversation(
      userId,
      sourceConversation.title,
      client,
    );
    await copyConversationMessages(client, {
      userId,
      targetConversationId: targetConversation.id,
      sourceMessages,
    });
    await copyConversationContextSeed(client, {
      userId,
      sourceConversationId,
      sourceMessageId: request.sourceMessageId,
      sourceRunId: sourceRun.run_id,
      targetConversationId: targetConversation.id,
    });
    await client.query(
      `
        INSERT INTO conversation_branch_requests (
          request_id,
          user_id,
          source_conversation_id,
          source_message_id,
          target_conversation_id
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        request.requestId,
        userId,
        sourceConversationId,
        request.sourceMessageId,
        targetConversation.id,
      ],
    );

    const conversation = await getConversation(
      userId,
      targetConversation.id,
      client,
    );
    if (conversation === null) {
      throw new TypeError("Created branch conversation could not be read");
    }
    return BranchConversationResponseSchema.parse({ conversation });
  }, database);
}
