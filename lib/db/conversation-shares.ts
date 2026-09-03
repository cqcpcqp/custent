import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  ConversationShareListItemSchema,
  ConversationShareSummarySchema,
  ListConversationSharesResponseSchema,
  PublicConversationShareSchema,
  RevokeConversationShareResponseSchema,
  SharedConversationMessageSchema,
  type ConversationShareListItem,
  type ConversationShareSummary,
  type ListConversationSharesResponse,
  type PublicConversationShare,
  type RevokeConversationShareResponse,
  type SharedConversationMessage,
} from "@/lib/contracts";
import { sanitizeConversationShareMessages } from "@/lib/conversation-share-safety";
import { AppError } from "@/lib/errors";

import { getPool, withTransaction } from "./pool";
import { type Queryable, toIsoString } from "./types";

type OwnerShareRow = {
  conversation_id: string;
  public_id: string | null;
  created_at: Date | null;
  updated_at: Date | null;
};

type StoredShareRow = {
  conversation_id: string;
  public_id: string;
  title: string;
  messages: unknown;
  created_at: Date;
  updated_at: Date;
};

type ConversationSharePageRow = Pick<
  StoredShareRow,
  | "conversation_id"
  | "public_id"
  | "title"
  | "created_at"
  | "updated_at"
> & { cursor_updated_at: string };

type ConversationShareCursor = {
  updatedAt: string;
  conversationId: string;
};

type ConversationSharePageInput = {
  userId: string;
  cursor: string | null;
  limit: number;
};

type SelectedConversationRow = {
  id: string;
  title: string;
  selected_run_id: string | null;
};

type SharedMessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: unknown;
  created_at: Date;
  files: unknown;
};

type RevokedShareRow = {
  public_id: string;
  revoked_at: Date;
};

const ConversationSharePageInputSchema = z
  .object({
    userId: z.string().uuid(),
    cursor: z.string().min(1).max(1_024).nullable(),
    limit: z.number().int().min(1).max(50).safe(),
  })
  .strict();

const EncodedConversationShareCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);

const ConversationShareCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("conversation_shares"),
    updatedAt: z.string().datetime(),
    conversationId: z.string().uuid(),
  })
  .strict();

function publicPath(publicId: string): string {
  return `/share/${publicId}`;
}

function invalidConversationShareCursor(): AppError {
  return new AppError("INVALID_REQUEST", "共享链接分页游标无效。", 400);
}

function decodeConversationShareCursor(
  encodedValue: string | null,
): ConversationShareCursor | null {
  if (encodedValue === null) {
    return null;
  }

  try {
    const encoded = EncodedConversationShareCursorSchema.parse(encodedValue);
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw invalidConversationShareCursor();
    }
    const parsed = ConversationShareCursorSchema.parse(
      JSON.parse(decoded.toString("utf8")),
    );
    return {
      updatedAt: parsed.updatedAt,
      conversationId: parsed.conversationId,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidConversationShareCursor();
  }
}

function encodeConversationShareCursor(row: ConversationSharePageRow): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "conversation_shares",
      updatedAt: row.cursor_updated_at,
      conversationId: row.conversation_id,
    }),
    "utf8",
  ).toString("base64url");
}

function mapConversationShareSummary(
  row: Pick<
    StoredShareRow,
    "conversation_id" | "public_id" | "created_at" | "updated_at"
  >,
): ConversationShareSummary {
  return ConversationShareSummarySchema.parse({
    conversationId: row.conversation_id,
    publicId: row.public_id,
    publicPath: publicPath(row.public_id),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

function mapConversationShareListItem(
  row: ConversationSharePageRow,
): ConversationShareListItem {
  return ConversationShareListItemSchema.parse({
    ...mapConversationShareSummary(row),
    title: row.title,
  });
}

function mapSharedMessage(row: SharedMessageRow): SharedConversationMessage {
  return SharedConversationMessageSchema.parse({
    id: row.id,
    role: row.role,
    content: row.content,
    citations: row.citations,
    createdAt: toIsoString(row.created_at),
    files: row.files,
  });
}

function mapPublicConversationShare(
  row: StoredShareRow,
): PublicConversationShare {
  const storedShare = PublicConversationShareSchema.parse({
    title: row.title,
    messages: row.messages,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
  return PublicConversationShareSchema.parse({
    ...storedShare,
    messages: sanitizeConversationShareMessages(storedShare.messages),
  });
}

async function lockShareableConversation(
  client: PoolClient,
  userId: string,
  conversationId: string,
): Promise<SelectedConversationRow> {
  const conversation = await client.query<SelectedConversationRow>(
    `
      SELECT id, title, selected_run_id
      FROM conversations
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `,
    [conversationId, userId],
  );
  if (conversation.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "对话不存在。", 404);
  }

  const row = conversation.rows[0];
  if (row.selected_run_id === null) {
    throw new AppError("EMPTY_CONVERSATION", "空对话不能分享。", 409);
  }

  const outstandingRun = await client.query<{ id: string }>(
    `
      SELECT id
      FROM runs
      WHERE
        conversation_id = $1
        AND user_id = $2
        AND status IN ('waiting', 'queued', 'running')
      LIMIT 1
      FOR UPDATE
    `,
    [conversationId, userId],
  );
  if (outstandingRun.rowCount !== 0) {
    throw new AppError(
      "ACTIVE_RUN",
      "对话仍有等待或运行中的任务，暂时不能分享。",
      409,
    );
  }

  return row;
}

async function selectedBranchMessages(
  client: PoolClient,
  input: {
    userId: string;
    conversationId: string;
    selectedRunId: string;
  },
): Promise<SharedConversationMessage[]> {
  const result = await client.query<SharedMessageRow>(
    `
      WITH RECURSIVE selected_path AS (
        SELECT
          selected_run.id,
          selected_run.input_message_id,
          selected_run.assistant_message_id,
          selected_run.predecessor_run_id,
          selected_run.conversation_turn
        FROM runs selected_run
        WHERE
          selected_run.id = $1
          AND selected_run.conversation_id = $2
          AND selected_run.user_id = $3
        UNION ALL
        SELECT
          predecessor.id,
          predecessor.input_message_id,
          predecessor.assistant_message_id,
          predecessor.predecessor_run_id,
          predecessor.conversation_turn
        FROM runs predecessor
        JOIN selected_path child
          ON child.predecessor_run_id = predecessor.id
        WHERE
          predecessor.conversation_id = $2
          AND predecessor.user_id = $3
      ), selected_messages AS (
        SELECT
          path_run.conversation_turn,
          0 AS role_order,
          message.id,
          message.role,
          message.content,
          message.citations,
          message.created_at
        FROM selected_path path_run
        JOIN messages message
          ON message.id = path_run.input_message_id
          AND message.conversation_id = $2
          AND message.role = 'user'
        UNION ALL
        SELECT
          path_run.conversation_turn,
          1 AS role_order,
          message.id,
          message.role,
          message.content,
          message.citations,
          message.created_at
        FROM selected_path path_run
        JOIN messages message
          ON message.id = path_run.assistant_message_id
          AND message.conversation_id = $2
          AND message.role = 'assistant'
          AND message.run_id = path_run.id
      )
      SELECT
        selected_message.id,
        selected_message.role,
        selected_message.content,
        selected_message.citations,
        selected_message.created_at,
        COALESCE(files.items, '[]'::jsonb) AS files
      FROM selected_messages selected_message
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          file_item.value
          ORDER BY
            file_item.source_order,
            file_item.source_position,
            file_item.source_created_at,
            file_item.source_id
        ) AS items
        FROM (
          SELECT
            0 AS source_order,
            link.position AS source_position,
            attachment.created_at AS source_created_at,
            attachment.id AS source_id,
            jsonb_build_object(
              'kind', 'input_attachment',
              'name', attachment.original_name,
              'mimeType', attachment.mime_type,
              'sizeBytes', attachment.size_bytes
            ) AS value
          FROM message_input_attachments link
          JOIN input_attachments attachment
            ON attachment.id = link.attachment_id
          WHERE link.message_id = selected_message.id
          UNION ALL
          SELECT
            1 AS source_order,
            0 AS source_position,
            artifact.created_at AS source_created_at,
            artifact.id AS source_id,
            jsonb_build_object(
              'kind', 'artifact',
              'name', artifact.name,
              'mimeType', artifact.mime_type,
              'sizeBytes', artifact.size_bytes
            ) AS value
          FROM artifacts artifact
          WHERE artifact.message_id = selected_message.id
        ) file_item
      ) files ON true
      ORDER BY selected_message.conversation_turn, selected_message.role_order
    `,
    [input.selectedRunId, input.conversationId, input.userId],
  );

  if (result.rows.length === 0) {
    throw new TypeError("Selected conversation branch produced no messages");
  }
  return result.rows.map(mapSharedMessage);
}

export async function listConversationSharePage(
  rawInput: ConversationSharePageInput,
  database: Queryable = getPool(),
): Promise<ListConversationSharesResponse> {
  const input = ConversationSharePageInputSchema.parse(rawInput);
  const cursor = decodeConversationShareCursor(input.cursor);
  const result = await database.query<ConversationSharePageRow>(
    `
      SELECT
        share.conversation_id,
        share.public_id,
        share.title,
        share.created_at,
        share.updated_at,
        to_char(
          share.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_updated_at
      FROM conversation_shares share
      JOIN conversations conversation
        ON conversation.id = share.conversation_id
      WHERE
        conversation.user_id = $1
        AND conversation.deleted_at IS NULL
        AND (
          $2::timestamptz IS NULL
          OR share.updated_at < $2::timestamptz
          OR (
            share.updated_at = $2::timestamptz
            AND share.conversation_id < $3::uuid
          )
        )
      ORDER BY share.updated_at DESC, share.conversation_id DESC
      LIMIT $4
    `,
    [
      input.userId,
      cursor?.updatedAt ?? null,
      cursor?.conversationId ?? null,
      input.limit + 1,
    ],
  );
  const hasNextPage = result.rows.length > input.limit;
  const pageRows = hasNextPage
    ? result.rows.slice(0, input.limit)
    : result.rows;

  return ListConversationSharesResponseSchema.parse({
    items: pageRows.map(mapConversationShareListItem),
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? encodeConversationShareCursor(pageRows[pageRows.length - 1])
        : null,
  });
}

export async function getConversationShare(
  userId: string,
  conversationId: string,
  database: Pool = getPool(),
): Promise<ConversationShareSummary | null> {
  const result = await database.query<OwnerShareRow>(
    `
      SELECT
        conversation.id AS conversation_id,
        share.public_id,
        share.created_at,
        share.updated_at
      FROM conversations conversation
      LEFT JOIN conversation_shares share
        ON share.conversation_id = conversation.id
      WHERE
        conversation.id = $1
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
    `,
    [conversationId, userId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "对话不存在。", 404);
  }

  const row = result.rows[0];
  if (row.public_id === null) {
    if (row.created_at !== null || row.updated_at !== null) {
      throw new TypeError("Conversation share metadata is incomplete");
    }
    return null;
  }
  if (row.created_at === null || row.updated_at === null) {
    throw new TypeError("Conversation share metadata is incomplete");
  }
  return mapConversationShareSummary({
    conversation_id: row.conversation_id,
    public_id: row.public_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export async function putConversationShare(
  userId: string,
  conversationId: string,
  database: Pool = getPool(),
): Promise<ConversationShareSummary> {
  return withTransaction(async (client) => {
    const conversation = await lockShareableConversation(
      client,
      userId,
      conversationId,
    );
    if (conversation.selected_run_id === null) {
      throw new TypeError("Shareable conversation is missing its selected Run");
    }
    const messages = await selectedBranchMessages(client, {
      userId,
      conversationId,
      selectedRunId: conversation.selected_run_id,
    });
    const parsedMessages = SharedConversationMessageSchema.array()
      .min(1)
      .parse(sanitizeConversationShareMessages(messages));
    const result = await client.query<StoredShareRow>(
      `
        INSERT INTO conversation_shares (
          conversation_id,
          public_id,
          title,
          messages
        )
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (conversation_id) DO UPDATE
        SET
          title = EXCLUDED.title,
          messages = EXCLUDED.messages,
          updated_at = now()
        RETURNING
          conversation_id,
          public_id,
          title,
          messages,
          created_at,
          updated_at
      `,
      [
        conversation.id,
        randomUUID(),
        conversation.title,
        JSON.stringify(parsedMessages),
      ],
    );
    if (result.rowCount !== 1) {
      throw new TypeError("Conversation share upsert returned no row");
    }
    return mapConversationShareSummary(result.rows[0]);
  }, database);
}

export async function revokeConversationShare(
  userId: string,
  conversationId: string,
  expectedPublicId: string,
  database: Pool = getPool(),
): Promise<RevokeConversationShareResponse["revocation"]> {
  return withTransaction(async (client) => {
    const conversation = await client.query<{ id: string }>(
      `
        SELECT id
        FROM conversations
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [conversationId, userId],
    );
    if (conversation.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "对话不存在。", 404);
    }

    const revoked = await client.query<RevokedShareRow>(
      `
        WITH deleted_share AS (
          DELETE FROM conversation_shares
          WHERE conversation_id = $1 AND public_id = $2
          RETURNING public_id
        )
        SELECT public_id, now() AS revoked_at
        FROM deleted_share
      `,
      [conversationId, expectedPublicId],
    );
    if (revoked.rowCount !== 1) {
      throw new AppError(
        "SHARE_NOT_FOUND",
        "分享链接不存在或已发生变化。",
        404,
      );
    }
    return RevokeConversationShareResponseSchema.shape.revocation.parse({
      conversationId,
      publicId: revoked.rows[0].public_id,
      revokedAt: toIsoString(revoked.rows[0].revoked_at),
    });
  }, database);
}

export async function getPublicConversationShare(
  publicId: string,
  database: Pool = getPool(),
): Promise<PublicConversationShare | null> {
  const result = await database.query<StoredShareRow>(
    `
      SELECT
        share.conversation_id,
        share.public_id,
        share.title,
        share.messages,
        share.created_at,
        share.updated_at
      FROM conversation_shares share
      JOIN conversations conversation
        ON conversation.id = share.conversation_id
      WHERE
        share.public_id = $1
        AND conversation.deleted_at IS NULL
    `,
    [publicId],
  );
  if (result.rowCount === 0) {
    return null;
  }
  if (result.rowCount !== 1) {
    throw new TypeError("Public conversation share ID is not unique");
  }
  return mapPublicConversationShare(result.rows[0]);
}
