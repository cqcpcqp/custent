import { randomUUID } from "node:crypto";

import {
  ArtifactSummarySchema,
  CitationSchema,
  MessageFeedbackSchema,
  type ChatMessage,
  type Citation,
  type MessageFeedback,
  type PatchMessageFeedbackResponse,
} from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { listInputAttachmentSummariesForMessages } from "@/lib/input-attachments";

import { getPool } from "./pool";
import { isPoolClient, type Queryable, toIsoString } from "./types";

type MessageRow = {
  id: string;
  run_id: string | null;
  role: "user" | "assistant";
  content: string;
  citations: unknown;
  feedback: MessageFeedback | null;
  created_at: Date;
};

type UpdatedMessageRow = MessageRow & {
  user_id: string;
};

type ArtifactRow = {
  id: string;
  message_id: string;
  name: string;
  mime_type: "text/csv" | "application/pdf";
  size_bytes: number;
  created_at: Date;
};

function mapArtifact(row: ArtifactRow) {
  return ArtifactSummarySchema.parse({
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    downloadUrl: `/api/artifacts/${row.id}/download`,
    createdAt: toIsoString(row.created_at),
  });
}

async function readIndependentData<TFirst, TSecond>(
  database: Queryable,
  readFirst: () => Promise<TFirst>,
  readSecond: () => Promise<TSecond>,
): Promise<[TFirst, TSecond]> {
  if (!isPoolClient(database)) {
    return Promise.all([readFirst(), readSecond()]);
  }

  const first = await readFirst();
  const second = await readSecond();
  return [first, second];
}

export async function listMessages(
  userId: string,
  conversationId: string,
  database: Queryable = getPool(),
): Promise<ChatMessage[]> {
  const messagesResult = await database.query<MessageRow>(
    `
      SELECT
        m.id,
        m.run_id,
        m.role,
        m.content,
        m.citations,
        m.feedback,
        m.created_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE
        m.conversation_id = $1
        AND c.user_id = $2
        AND c.deleted_at IS NULL
      ORDER BY m.created_at, m.id
    `,
    [conversationId, userId],
  );

  if (messagesResult.rows.length === 0) {
    const conversation = await database.query<{ id: string }>(
      `
        SELECT id
        FROM conversations
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      `,
      [conversationId, userId],
    );
    if (conversation.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }
    return [];
  }

  const messageIds = messagesResult.rows.map((row) => row.id);
  const [artifactsResult, attachmentsByMessage] = await readIndependentData(
    database,
    () => database.query<ArtifactRow>(
      `
        SELECT id, message_id, name, mime_type, size_bytes, created_at
        FROM artifacts
        WHERE message_id = ANY($1::uuid[])
        ORDER BY created_at, id
      `,
      [messageIds],
    ),
    () => listInputAttachmentSummariesForMessages(
      { userId, messageIds },
      database,
    ),
  );
  const artifactsByMessage = new Map<string, ReturnType<typeof mapArtifact>[]>();

  for (const row of artifactsResult.rows) {
    const artifacts = artifactsByMessage.get(row.message_id) ?? [];
    artifacts.push(mapArtifact(row));
    artifactsByMessage.set(row.message_id, artifacts);
  }

  return messagesResult.rows.map((row) => {
    const attachments = attachmentsByMessage.get(row.id);
    if (attachments === undefined) {
      throw new TypeError("Message attachment result is incomplete");
    }
    return {
      id: row.id,
      runId: row.run_id,
      role: row.role,
      content: row.content,
      citations: CitationSchema.array().parse(row.citations),
      artifacts: artifactsByMessage.get(row.id) ?? [],
      attachments,
      feedback: MessageFeedbackSchema.nullable().parse(row.feedback),
      createdAt: toIsoString(row.created_at),
    };
  });
}

export async function insertMessage(
  input: {
    id?: string;
    runId?: string | null;
    userId: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    citations: Citation[];
  },
  database: Queryable = getPool(),
): Promise<ChatMessage> {
  const citations = CitationSchema.array().parse(input.citations);
  const messageId = input.id ?? randomUUID();
  const result = await database.query<MessageRow>(
    `
      WITH inserted AS (
        INSERT INTO messages (
          id,
          conversation_id,
          run_id,
          role,
          content,
          citations
        )
        SELECT $3, c.id, $4, $5, $6, $7::jsonb
        FROM conversations c
        WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL
        RETURNING
          id,
          conversation_id,
          run_id,
          role,
          content,
          citations,
          feedback,
          created_at
      ), updated AS (
        UPDATE conversations c
        SET updated_at = inserted.created_at
        FROM inserted
        WHERE c.id = inserted.conversation_id
      )
      SELECT id, run_id, role, content, citations, feedback, created_at
      FROM inserted
    `,
    [
      input.conversationId,
      input.userId,
      messageId,
      input.runId ?? null,
      input.role,
      input.content,
      JSON.stringify(citations),
    ],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Conversation was not found", 404);
  }

  const row = result.rows[0];
  return {
    id: row.id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    citations: CitationSchema.array().parse(row.citations),
    artifacts: [],
    attachments: [],
    feedback: MessageFeedbackSchema.nullable().parse(row.feedback),
    createdAt: toIsoString(row.created_at),
  };
}

export async function updateMessage(
  messageId: string,
  conversationId: string,
  content: string,
  citations: Citation[],
  database: Queryable = getPool(),
): Promise<ChatMessage> {
  const parsedCitations = CitationSchema.array().parse(citations);
  const result = await database.query<UpdatedMessageRow>(
    `
      UPDATE messages message
      SET content = $3, citations = $4::jsonb
      FROM conversations conversation
      WHERE
        message.id = $1
        AND message.conversation_id = $2
        AND conversation.id = message.conversation_id
        AND conversation.deleted_at IS NULL
      RETURNING
        message.id,
        message.run_id,
        message.role,
        message.content,
        message.citations,
        message.feedback,
        message.created_at,
        conversation.user_id
    `,
    [messageId, conversationId, content, JSON.stringify(parsedCitations)],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Message was not found", 404);
  }

  const [artifactsResult, attachmentsByMessage] = await readIndependentData(
    database,
    () => database.query<ArtifactRow>(
      `
        SELECT id, message_id, name, mime_type, size_bytes, created_at
        FROM artifacts
        WHERE message_id = $1
        ORDER BY created_at, id
      `,
      [messageId],
    ),
    () => listInputAttachmentSummariesForMessages(
      { userId: result.rows[0].user_id, messageIds: [messageId] },
      database,
    ),
  );
  const row = result.rows[0];
  const attachments = attachmentsByMessage.get(row.id);
  if (attachments === undefined) {
    throw new TypeError("Message attachment result is incomplete");
  }
  return {
    id: row.id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    citations: CitationSchema.array().parse(row.citations),
    artifacts: artifactsResult.rows.map(mapArtifact),
    attachments,
    feedback: MessageFeedbackSchema.nullable().parse(row.feedback),
    createdAt: toIsoString(row.created_at),
  };
}

export async function setMessageFeedback(
  userId: string,
  messageId: string,
  feedback: MessageFeedback | null,
  database: Queryable = getPool(),
): Promise<PatchMessageFeedbackResponse> {
  const parsedFeedback = MessageFeedbackSchema.nullable().parse(feedback);
  const result = await database.query<{
    message_id: string;
    feedback: MessageFeedback | null;
  }>(
    `
      WITH updated_message AS (
        UPDATE messages message
        SET feedback = $3
        FROM conversations conversation
        WHERE
          message.id = $1
          AND conversation.id = message.conversation_id
          AND conversation.user_id = $2
          AND conversation.deleted_at IS NULL
          AND message.role = 'assistant'
        RETURNING message.id, message.feedback
      ), updated_done_events AS (
        UPDATE run_events event
        SET payload = jsonb_set(
          event.payload,
          '{message,feedback}',
          COALESCE(to_jsonb(updated_message.feedback), 'null'::jsonb),
          true
        )
        FROM updated_message
        WHERE
          event.event_type = 'done'
          AND event.payload -> 'message' ->> 'id' = updated_message.id::text
        RETURNING event.id
      )
      SELECT id AS message_id, feedback
      FROM updated_message
    `,
    [messageId, userId, parsedFeedback],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Message was not found", 404);
  }

  return {
    messageId: result.rows[0].message_id,
    feedback: MessageFeedbackSchema.nullable().parse(
      result.rows[0].feedback,
    ),
  };
}
