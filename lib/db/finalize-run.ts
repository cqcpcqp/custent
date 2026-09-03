import type { Pool, PoolClient } from "pg";

import { attachRunArtifactsInTransaction } from "@/lib/artifacts/repository";
import type {
  ArtifactSummary,
  ChatMessage,
  Citation,
  CreditBalance,
  MessageFeedback,
} from "@/lib/contracts";
import { CitationSchema, MessageFeedbackSchema } from "@/lib/contracts";
import {
  settleRunInTransaction,
  type RunUsage,
} from "@/lib/credits";
import { AppError } from "@/lib/errors";

import { getPool, withTransaction } from "./pool";

type FinalMessageRow = {
  id: string;
  run_id: string;
  role: "assistant";
  content: string;
  citations: unknown;
  feedback: MessageFeedback | null;
  created_at: Date;
};

export type FinalizeSuccessfulChatRunInput = {
  userId: string;
  conversationId: string;
  runId: string;
  assistantMessageId: string;
  content: string;
  citations: Citation[];
  usage: RunUsage;
};

export type FinalizeSuccessfulChatRunResult = {
  message: ChatMessage;
  artifacts: ArtifactSummary[];
  credits: CreditBalance;
};

export type FinalizeSuccessfulChatRunInTransactionResult =
  | {
      kind: "completed";
      value: FinalizeSuccessfulChatRunResult;
    }
  | {
      kind: "reconciliation_required";
      credits: CreditBalance;
    };

export async function finalizeSuccessfulChatRunInTransaction(
  input: FinalizeSuccessfulChatRunInput,
  client: PoolClient,
): Promise<FinalizeSuccessfulChatRunInTransactionResult> {
  const citations = CitationSchema.array().parse(input.citations);
  const settlement = await settleRunInTransaction(
    { userId: input.userId, runId: input.runId, usage: input.usage },
    client,
  );
  if (settlement.kind === "reconciliation_required") {
    return {
      kind: "reconciliation_required",
      credits: settlement.credits,
    };
  }

  let message: FinalMessageRow;
  if (settlement.alreadyCompleted) {
    const existing = await client.query<FinalMessageRow>(
      `
        SELECT id, run_id, role, content, citations, feedback, created_at
        FROM messages
        WHERE
          id = $1
          AND run_id = $2
          AND conversation_id = $3
          AND role = 'assistant'
          AND content = $4
          AND citations = $5::jsonb
      `,
      [
        input.assistantMessageId,
        input.runId,
        input.conversationId,
        input.content,
        JSON.stringify(citations),
      ],
    );
    if (existing.rowCount !== 1) {
      throw new AppError(
        "RUN_ALREADY_EXISTS",
        "Run was settled without the matching final assistant message",
        409,
      );
    }
    message = existing.rows[0];
  } else {
    const inserted = await client.query<FinalMessageRow>(
      `
        INSERT INTO messages (
          id,
          conversation_id,
          run_id,
          role,
          content,
          citations
        )
        SELECT $1, run.conversation_id, run.id, 'assistant', $4, $5::jsonb
        FROM runs run
        WHERE
          run.id = $2
          AND run.conversation_id = $3
          AND run.user_id = $6
          AND run.status = 'completed'
        RETURNING id, run_id, role, content, citations, feedback, created_at
      `,
      [
        input.assistantMessageId,
        input.runId,
        input.conversationId,
        input.content,
        JSON.stringify(citations),
        input.userId,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Run was not found", 404);
    }
    message = inserted.rows[0];
    await client.query(
      `
        UPDATE conversations
        SET updated_at = $2
        WHERE id = $1 AND user_id = $3 AND deleted_at IS NULL
      `,
      [input.conversationId, message.created_at, input.userId],
    );
  }

  const artifacts = await attachRunArtifactsInTransaction(
    {
      userId: input.userId,
      runId: input.runId,
      messageId: input.assistantMessageId,
    },
    client,
  );
  const chatMessage: ChatMessage = {
    id: message.id,
    runId: message.run_id,
    role: message.role,
    content: message.content,
    citations: CitationSchema.array().parse(message.citations),
    artifacts,
    attachments: [],
    feedback: MessageFeedbackSchema.nullable().parse(message.feedback),
    createdAt: message.created_at.toISOString(),
  };

  return {
    kind: "completed",
    value: {
      message: chatMessage,
      artifacts,
      credits: settlement.value.credits,
    },
  };
}

export async function finalizeSuccessfulChatRun(
  input: FinalizeSuccessfulChatRunInput,
  database: Pool = getPool(),
): Promise<FinalizeSuccessfulChatRunResult> {
  const result = await withTransaction(
    (client) => finalizeSuccessfulChatRunInTransaction(input, client),
    database,
  );

  if (result.kind === "reconciliation_required") {
    throw new AppError(
      "RUN_REQUIRES_RECONCILIATION",
      "Calculated charge exceeded the reserved credits; the reservation was frozen",
      409,
    );
  }
  return result.value;
}
