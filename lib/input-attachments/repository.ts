import type { Pool, PoolClient } from "pg";

import {
  InputAttachmentSummarySchema,
  type InputAttachmentKind,
  type InputAttachmentMimeType,
  type InputAttachmentSummary,
  type UploadInputAttachmentResponse,
} from "@/lib/contracts";
import { getPool, withTransaction } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";
import { AppError } from "@/lib/errors";

import type {
  InputAttachmentContentRecord,
  InputAttachmentDeletionJob,
  InputAttachmentRecord,
  MessageInputAttachmentRecord,
  StoredInputAttachment,
} from "./types";
import { isInputAttachmentStoragePath } from "./naming";

type InputAttachmentRow = {
  id: string;
  user_id: string;
  kind: InputAttachmentKind;
  original_name: string;
  mime_type: InputAttachmentMimeType;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: Date;
  attached_at: Date | null;
  expires_at: Date | null;
};

type LockedInputAttachmentRow = InputAttachmentRow & {
  is_expired: boolean | null;
  is_source_attachment?: boolean;
};

type MessageInputAttachmentRow = InputAttachmentRow & {
  message_id: string;
  position: number;
};

type InputAttachmentDeletionRow = {
  attachment_id: string;
  user_id: string;
  storage_path: string;
  deleted_at: Date;
  completed_at: Date | null;
  attempt_count: number;
};

const INPUT_ATTACHMENT_COLUMNS = `
  attachment.id,
  attachment.user_id,
  attachment.kind,
  attachment.original_name,
  attachment.mime_type,
  attachment.size_bytes,
  attachment.sha256,
  attachment.storage_path,
  attachment.created_at,
  attachment.attached_at,
  attachment.expires_at
`;

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

export async function listKnownInputAttachmentStoragePaths(
  storagePaths: string[],
  database: Queryable = getPool(),
): Promise<Set<string>> {
  if (new Set(storagePaths).size !== storagePaths.length) {
    throw new TypeError("Input attachment storage paths must be unique");
  }
  for (const storagePath of storagePaths) {
    if (!isInputAttachmentStoragePath(storagePath)) {
      throw new TypeError("Input attachment storage path must be a UUID");
    }
  }
  if (storagePaths.length === 0) {
    return new Set();
  }

  const result = await database.query<{ storage_path: string }>(
    `
      SELECT attachment.storage_path
      FROM input_attachments attachment
      WHERE attachment.storage_path = ANY($1::text[])
      UNION
      SELECT deletion.storage_path
      FROM input_attachment_deletions deletion
      WHERE deletion.storage_path = ANY($1::text[])
    `,
    [storagePaths],
  );
  const requested = new Set(storagePaths);
  const known = new Set<string>();
  for (const row of result.rows) {
    if (!requested.has(row.storage_path) || known.has(row.storage_path)) {
      throw new TypeError(
        "Input attachment storage reference query returned inconsistent rows",
      );
    }
    known.add(row.storage_path);
  }
  return known;
}

function mapInputAttachmentDeletion(
  row: InputAttachmentDeletionRow,
): InputAttachmentDeletionJob {
  return {
    attachmentId: row.attachment_id,
    userId: row.user_id,
    storagePath: row.storage_path,
    deletedAt: row.deleted_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    attemptCount: row.attempt_count,
  };
}

function mapInputAttachmentRecord(
  row: InputAttachmentRow,
): InputAttachmentRecord {
  const isStaged = row.attached_at === null;
  if (
    (isStaged && row.expires_at === null) ||
    (!isStaged && row.expires_at !== null)
  ) {
    throw new TypeError("Input attachment state is inconsistent");
  }

  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at.toISOString(),
    attachedAt: row.attached_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}

function mapMessageInputAttachmentRecord(
  row: MessageInputAttachmentRow,
): MessageInputAttachmentRecord {
  if (!Number.isSafeInteger(row.position) || row.position < 0) {
    throw new TypeError("Input attachment message position is invalid");
  }
  return {
    ...mapInputAttachmentRecord(row),
    messageId: row.message_id,
    position: row.position,
  };
}

export function toInputAttachmentSummary(
  attachment: InputAttachmentRecord,
): InputAttachmentSummary {
  return InputAttachmentSummarySchema.parse({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    downloadUrl: `/api/input-attachments/${attachment.id}/content`,
    createdAt: attachment.createdAt,
  });
}

function toStagedInputAttachmentResponse(
  attachment: InputAttachmentRecord,
): UploadInputAttachmentResponse {
  if (attachment.attachedAt !== null || attachment.expiresAt === null) {
    throw new TypeError("Input attachment is not staged");
  }
  return {
    attachment: toInputAttachmentSummary(attachment),
    expiresAt: attachment.expiresAt,
  };
}

export async function createInputAttachment(
  input: {
    userId: string;
    stored: StoredInputAttachment;
    expiresAt: Date;
  },
  database: Queryable = getPool(),
): Promise<UploadInputAttachmentResponse> {
  if (
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= Date.now()
  ) {
    throw new TypeError("expiresAt must be a future date");
  }
  if (input.stored.storagePath !== input.stored.id) {
    throw new TypeError("Input attachment storage path must equal its UUID");
  }

  const result = await database.query<InputAttachmentRow>(
    `
      INSERT INTO input_attachments (
        id,
        user_id,
        kind,
        original_name,
        mime_type,
        size_bytes,
        sha256,
        storage_path,
        expires_at
      )
      SELECT $2, user_account.id, $3, $4, $5, $6, $7, $8, $9
      FROM users user_account
      WHERE user_account.id = $1
      RETURNING
        id,
        user_id,
        kind,
        original_name,
        mime_type,
        size_bytes,
        sha256,
        storage_path,
        created_at,
        attached_at,
        expires_at
    `,
    [
      input.userId,
      input.stored.id,
      input.stored.kind,
      input.stored.originalName,
      input.stored.mimeType,
      input.stored.sizeBytes,
      input.stored.sha256,
      input.stored.storagePath,
      input.expiresAt,
    ],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "用户不存在。", 404);
  }
  return toStagedInputAttachmentResponse(
    mapInputAttachmentRecord(result.rows[0]),
  );
}

export async function getStagedInputAttachment(
  userId: string,
  attachmentId: string,
  database: Queryable = getPool(),
): Promise<UploadInputAttachmentResponse | null> {
  const result = await database.query<InputAttachmentRow>(
    `
      SELECT ${INPUT_ATTACHMENT_COLUMNS}
      FROM input_attachments attachment
      WHERE
        attachment.id = $1
        AND attachment.user_id = $2
        AND attachment.attached_at IS NULL
        AND attachment.expires_at > now()
    `,
    [attachmentId, userId],
  );
  if (result.rowCount === 0) {
    return null;
  }
  return toStagedInputAttachmentResponse(
    mapInputAttachmentRecord(result.rows[0]),
  );
}

export async function getInputAttachmentContentRecord(
  userId: string,
  attachmentId: string,
  database: Queryable = getPool(),
): Promise<InputAttachmentContentRecord | null> {
  const result = await database.query<InputAttachmentRow>(
    `
      SELECT ${INPUT_ATTACHMENT_COLUMNS}
      FROM input_attachments attachment
      WHERE
        attachment.id = $1
        AND attachment.user_id = $2
        AND (
          (
            attachment.attached_at IS NULL
            AND attachment.expires_at > now()
          )
          OR
          EXISTS (
            SELECT 1
            FROM message_input_attachments message_attachment
            JOIN messages message ON message.id = message_attachment.message_id
            JOIN conversations conversation
              ON conversation.id = message.conversation_id
            WHERE
              message_attachment.attachment_id = attachment.id
              AND conversation.user_id = $2
              AND conversation.deleted_at IS NULL
          )
        )
    `,
    [attachmentId, userId],
  );
  if (result.rowCount === 0) {
    return null;
  }
  const record = mapInputAttachmentRecord(result.rows[0]);
  return {
    id: record.id,
    userId: record.userId,
    kind: record.kind,
    originalName: record.originalName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
    storagePath: record.storagePath,
  };
}

export async function getConversationBoundInputAttachmentRecord(
  input: {
    userId: string;
    conversationId: string;
    attachmentId: string;
  },
  database: Queryable = getPool(),
): Promise<InputAttachmentRecord | null> {
  const result = await database.query<InputAttachmentRow>(
    `
      SELECT ${INPUT_ATTACHMENT_COLUMNS}
      FROM input_attachments attachment
      WHERE
        attachment.id = $1
        AND attachment.user_id = $2
        AND EXISTS (
          SELECT 1
          FROM message_input_attachments message_attachment
          JOIN messages message ON message.id = message_attachment.message_id
          JOIN conversations conversation
            ON conversation.id = message.conversation_id
          WHERE
            message_attachment.attachment_id = attachment.id
            AND message.conversation_id = $3
            AND conversation.id = $3
            AND conversation.user_id = $2
            AND conversation.deleted_at IS NULL
        )
    `,
    [input.attachmentId, input.userId, input.conversationId],
  );
  return result.rowCount === 0
    ? null
    : mapInputAttachmentRecord(result.rows[0]);
}

export async function getMessageBoundInputAttachmentRecord(
  input: {
    userId: string;
    conversationId: string;
    messageId: string;
    attachmentId: string;
  },
  database: Queryable = getPool(),
): Promise<MessageInputAttachmentRecord | null> {
  const result = await database.query<MessageInputAttachmentRow>(
    `
      SELECT
        ${INPUT_ATTACHMENT_COLUMNS},
        message_attachment.message_id,
        message_attachment.position
      FROM message_input_attachments message_attachment
      JOIN input_attachments attachment
        ON attachment.id = message_attachment.attachment_id
      JOIN messages message ON message.id = message_attachment.message_id
      JOIN conversations conversation
        ON conversation.id = message.conversation_id
      WHERE
        message_attachment.message_id = $1
        AND message_attachment.attachment_id = $2
        AND message.conversation_id = $3
        AND attachment.user_id = $4
        AND conversation.user_id = $4
        AND conversation.deleted_at IS NULL
    `,
    [
      input.messageId,
      input.attachmentId,
      input.conversationId,
      input.userId,
    ],
  );
  return result.rowCount === 0
    ? null
    : mapMessageInputAttachmentRecord(result.rows[0]);
}

export async function deleteStagedInputAttachment(
  userId: string,
  attachmentId: string,
  database: Pool = getPool(),
): Promise<{
  deletion: { attachmentId: string; deletedAt: string };
  storagePath: string;
  completedAt: string | null;
}> {
  return withTransaction(async (client) => {
    const selected = await client.query<InputAttachmentRow>(
      `
        SELECT ${INPUT_ATTACHMENT_COLUMNS}
        FROM input_attachments attachment
        WHERE attachment.id = $1 AND attachment.user_id = $2
        FOR UPDATE OF attachment
      `,
      [attachmentId, userId],
    );
    if (selected.rowCount !== 1) {
      const existingDeletion =
        await client.query<InputAttachmentDeletionRow>(
          `
            SELECT
              attachment_id,
              user_id,
              storage_path,
              deleted_at,
              completed_at,
              attempt_count
            FROM input_attachment_deletions
            WHERE attachment_id = $1 AND user_id = $2
          `,
          [attachmentId, userId],
        );
      if (existingDeletion.rowCount !== 1) {
        throw new AppError("NOT_FOUND", "附件不存在。", 404);
      }
      const job = mapInputAttachmentDeletion(existingDeletion.rows[0]);
      return {
        deletion: {
          attachmentId: job.attachmentId,
          deletedAt: job.deletedAt,
        },
        storagePath: job.storagePath,
        completedAt: job.completedAt,
      };
    }
    const attachment = mapInputAttachmentRecord(selected.rows[0]);
    if (attachment.attachedAt !== null) {
      throw new AppError(
        "INVALID_REQUEST",
        "已发送的附件不能单独删除。",
        409,
      );
    }

    const queued = await client.query<InputAttachmentDeletionRow>(
      `
        INSERT INTO input_attachment_deletions (
          attachment_id,
          user_id,
          storage_path
        )
        VALUES ($1, $2, $3)
        RETURNING
          attachment_id,
          user_id,
          storage_path,
          deleted_at,
          completed_at,
          attempt_count
      `,
      [attachment.id, attachment.userId, attachment.storagePath],
    );
    const deleted = await client.query<{ id: string }>(
      `
        DELETE FROM input_attachments
        WHERE id = $1 AND user_id = $2 AND attached_at IS NULL
        RETURNING id
      `,
      [attachmentId, userId],
    );
    if (queued.rowCount !== 1 || deleted.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "附件不存在。", 404);
    }
    const job = mapInputAttachmentDeletion(queued.rows[0]);
    return {
      deletion: {
        attachmentId: job.attachmentId,
        deletedAt: job.deletedAt,
      },
      storagePath: job.storagePath,
      completedAt: job.completedAt,
    };
  }, database);
}

export async function completeInputAttachmentDeletion(
  attachmentId: string,
  database: Queryable = getPool(),
): Promise<void> {
  const result = await database.query<{ attachment_id: string }>(
    `
      UPDATE input_attachment_deletions
      SET completed_at = COALESCE(completed_at, now()), last_error = NULL
      WHERE attachment_id = $1
      RETURNING attachment_id
    `,
    [attachmentId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "附件删除任务不存在。", 404);
  }
}

export async function recordInputAttachmentDeletionFailure(
  input: { attachmentId: string; errorMessage: string; retryDelayMs: number },
  database: Queryable = getPool(),
): Promise<void> {
  validatePositiveInteger(input.retryDelayMs, "retryDelayMs");
  if (input.errorMessage.length === 0 || input.errorMessage.length > 2_000) {
    throw new TypeError("errorMessage must contain 1 to 2000 characters");
  }
  const result = await database.query<{ attachment_id: string }>(
    `
      UPDATE input_attachment_deletions
      SET
        last_error = $2,
        next_attempt_at = now() + ($3 * interval '1 millisecond')
      WHERE attachment_id = $1 AND completed_at IS NULL
      RETURNING attachment_id
    `,
    [input.attachmentId, input.errorMessage, input.retryDelayMs],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "附件删除任务不存在。", 404);
  }
}

export async function queueExpiredInputAttachmentDeletions(
  limit: number,
  database: Pool = getPool(),
): Promise<number> {
  validatePositiveInteger(limit, "limit");
  return withTransaction(async (client) => {
    const result = await client.query<{ queued_count: number }>(
      `
        WITH expired AS (
          SELECT attachment.id, attachment.user_id, attachment.storage_path
          FROM input_attachments attachment
          WHERE
            attachment.attached_at IS NULL
            AND attachment.expires_at <= now()
          ORDER BY attachment.expires_at, attachment.id
          FOR UPDATE OF attachment SKIP LOCKED
          LIMIT $1
        ), queued AS (
          INSERT INTO input_attachment_deletions (
            attachment_id,
            user_id,
            storage_path
          )
          SELECT id, user_id, storage_path
          FROM expired
          RETURNING attachment_id
        ), deleted AS (
          DELETE FROM input_attachments attachment
          USING queued
          WHERE attachment.id = queued.attachment_id
          RETURNING attachment.id
        )
        SELECT COUNT(*)::integer AS queued_count
        FROM deleted
      `,
      [limit],
    );
    return result.rows[0].queued_count;
  }, database);
}

export async function claimPendingInputAttachmentDeletions(
  input: { limit: number; retryDelayMs: number },
  database: Pool = getPool(),
): Promise<InputAttachmentDeletionJob[]> {
  validatePositiveInteger(input.limit, "limit");
  validatePositiveInteger(input.retryDelayMs, "retryDelayMs");
  return withTransaction(async (client) => {
    const result = await client.query<InputAttachmentDeletionRow>(
      `
        WITH candidate AS (
          SELECT deletion.attachment_id
          FROM input_attachment_deletions deletion
          WHERE
            deletion.completed_at IS NULL
            AND deletion.next_attempt_at <= now()
          ORDER BY
            deletion.next_attempt_at,
            deletion.deleted_at,
            deletion.attachment_id
          FOR UPDATE OF deletion SKIP LOCKED
          LIMIT $1
        )
        UPDATE input_attachment_deletions deletion
        SET
          attempt_count = deletion.attempt_count + 1,
          next_attempt_at = now() + ($2 * interval '1 millisecond')
        FROM candidate
        WHERE deletion.attachment_id = candidate.attachment_id
        RETURNING
          deletion.attachment_id,
          deletion.user_id,
          deletion.storage_path,
          deletion.deleted_at,
          deletion.completed_at,
          deletion.attempt_count
      `,
      [input.limit, input.retryDelayMs],
    );
    return result.rows.map(mapInputAttachmentDeletion);
  }, database);
}

export async function lockInputAttachmentsForNewMessage(
  input: {
    userId: string;
    attachmentIds: string[];
    sourceMessageId: string | null;
    maxCount: number;
    maxTotalBytes: number;
  },
  client: PoolClient,
): Promise<InputAttachmentRecord[]> {
  validatePositiveInteger(input.maxCount, "maxCount");
  validatePositiveInteger(input.maxTotalBytes, "maxTotalBytes");
  if (new Set(input.attachmentIds).size !== input.attachmentIds.length) {
    throw new AppError("INVALID_REQUEST", "附件 ID 不能重复。", 400);
  }
  if (input.attachmentIds.length > input.maxCount) {
    throw new AppError("INVALID_REQUEST", "单条消息的附件数量过多。", 413);
  }
  if (input.attachmentIds.length === 0) {
    return [];
  }

  const result = await client.query<LockedInputAttachmentRow>(
    `
      SELECT
        ${INPUT_ATTACHMENT_COLUMNS},
        attachment.expires_at <= now() AS is_expired,
        EXISTS (
          SELECT 1
          FROM message_input_attachments source_attachment
          JOIN messages source_message
            ON source_message.id = source_attachment.message_id
          JOIN conversations source_conversation
            ON source_conversation.id = source_message.conversation_id
          WHERE
            source_attachment.message_id = $3::uuid
            AND source_attachment.attachment_id = attachment.id
            AND source_conversation.user_id = $2
            AND source_conversation.deleted_at IS NULL
        ) AS is_source_attachment
      FROM input_attachments attachment
      WHERE
        attachment.id = ANY($1::uuid[])
        AND attachment.user_id = $2
      ORDER BY array_position($1::uuid[], attachment.id)
      FOR UPDATE OF attachment
    `,
    [input.attachmentIds, input.userId, input.sourceMessageId],
  );
  if (result.rowCount !== input.attachmentIds.length) {
    throw new AppError("NOT_FOUND", "一个或多个附件不存在。", 404);
  }

  const records: InputAttachmentRecord[] = [];
  let totalBytes = 0;
  for (const row of result.rows) {
    const attachment = mapInputAttachmentRecord(row);
    if (
      attachment.attachedAt !== null &&
      row.is_source_attachment !== true
    ) {
      throw new AppError(
        "INVALID_REQUEST",
        "一个或多个附件不属于被编辑的消息。",
        409,
      );
    }
    if (attachment.attachedAt === null && row.is_expired !== false) {
      throw new AppError(
        "INVALID_REQUEST",
        "一个或多个附件已经过期。",
        409,
      );
    }
    records.push(attachment);
    totalBytes += attachment.sizeBytes;
  }
  if (totalBytes > input.maxTotalBytes) {
    throw new AppError("INVALID_REQUEST", "单条消息的附件总大小过大。", 413);
  }
  return records;
}

export async function lockStagedInputAttachments(
  input: {
    userId: string;
    attachmentIds: string[];
    maxCount: number;
    maxTotalBytes: number;
  },
  client: PoolClient,
): Promise<InputAttachmentRecord[]> {
  return lockInputAttachmentsForNewMessage(
    { ...input, sourceMessageId: null },
    client,
  );
}

export async function bindInputAttachmentsToMessage(
  input: {
    userId: string;
    messageId: string;
    attachmentIds: string[];
    sourceMessageId?: string | null;
  },
  client: PoolClient,
): Promise<InputAttachmentSummary[]> {
  if (input.attachmentIds.length === 0) {
    return [];
  }
  const result = await client.query<MessageInputAttachmentRow>(
    `
      WITH ordered AS (
        SELECT id, (ordinality - 1)::integer AS position
        FROM unnest($1::uuid[]) WITH ORDINALITY AS requested(id, ordinality)
      ), eligible AS MATERIALIZED (
        SELECT
          attachment.id,
          ordered.position,
          (
            attachment.attached_at IS NULL
            AND attachment.expires_at > now()
          ) AS is_staged,
          EXISTS (
            SELECT 1
            FROM message_input_attachments source_attachment
            JOIN messages source_message
              ON source_message.id = source_attachment.message_id
            JOIN conversations source_conversation
              ON source_conversation.id = source_message.conversation_id
            WHERE
              source_attachment.message_id = $4::uuid
              AND source_attachment.attachment_id = attachment.id
              AND source_conversation.user_id = $3
              AND source_conversation.deleted_at IS NULL
          ) AS is_source_attachment
        FROM ordered
        JOIN input_attachments attachment ON attachment.id = ordered.id
        WHERE attachment.user_id = $3
        FOR UPDATE OF attachment
      ), activated AS (
        UPDATE input_attachments attachment
        SET attached_at = COALESCE(attachment.attached_at, now()), expires_at = NULL
        FROM eligible
        WHERE
          attachment.id = eligible.id
          AND (eligible.is_staged OR eligible.is_source_attachment)
        RETURNING attachment.id
      ), linked AS (
        INSERT INTO message_input_attachments (
          message_id,
          attachment_id,
          position
        )
        SELECT $2, eligible.id, eligible.position
        FROM eligible
        WHERE
          (eligible.is_staged OR eligible.is_source_attachment)
          AND EXISTS (
          SELECT 1
          FROM messages message
          JOIN conversations conversation
            ON conversation.id = message.conversation_id
          WHERE
            message.id = $2
            AND conversation.user_id = $3
            AND conversation.deleted_at IS NULL
          )
        RETURNING message_id, attachment_id, position
      )
      SELECT
        attachment.id,
        attachment.user_id,
        attachment.kind,
        attachment.original_name,
        attachment.mime_type,
        attachment.size_bytes,
        attachment.sha256,
        attachment.storage_path,
        attachment.created_at,
        attachment.attached_at,
        attachment.expires_at,
        linked.message_id,
        linked.position
      FROM linked
      JOIN activated ON activated.id = linked.attachment_id
      JOIN input_attachments attachment ON attachment.id = linked.attachment_id
      ORDER BY linked.position
    `,
    [
      input.attachmentIds,
      input.messageId,
      input.userId,
      input.sourceMessageId ?? null,
    ],
  );
  if (result.rowCount !== input.attachmentIds.length) {
    throw new AppError(
      "INVALID_REQUEST",
      "附件状态已变化，请重新选择附件。",
      409,
    );
  }

  const byId = new Map(
    result.rows.map((row) => {
      const record = mapMessageInputAttachmentRecord(row);
      return [record.id, toInputAttachmentSummary(record)] as const;
    }),
  );
  return input.attachmentIds.map((attachmentId) => {
    const attachment = byId.get(attachmentId);
    if (attachment === undefined) {
      throw new TypeError("Bound input attachment result is incomplete");
    }
    return attachment;
  });
}

export async function listInputAttachmentSummariesForMessages(
  input: { userId: string; messageIds: string[] },
  database: Queryable = getPool(),
): Promise<Map<string, InputAttachmentSummary[]>> {
  const attachmentsByMessage = new Map<string, InputAttachmentSummary[]>(
    input.messageIds.map((messageId) => [messageId, []]),
  );
  if (input.messageIds.length === 0) {
    return attachmentsByMessage;
  }

  const result = await database.query<MessageInputAttachmentRow>(
    `
      SELECT
        ${INPUT_ATTACHMENT_COLUMNS},
        message_attachment.message_id,
        message_attachment.position
      FROM message_input_attachments message_attachment
      JOIN input_attachments attachment
        ON attachment.id = message_attachment.attachment_id
      JOIN messages message ON message.id = message_attachment.message_id
      JOIN conversations conversation
        ON conversation.id = message.conversation_id
      WHERE
        message_attachment.message_id = ANY($1::uuid[])
        AND attachment.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
      ORDER BY message_attachment.message_id, message_attachment.position
    `,
    [input.messageIds, input.userId],
  );

  for (const row of result.rows) {
    const attachments = attachmentsByMessage.get(row.message_id);
    if (attachments === undefined) {
      throw new TypeError("Input attachment references an unexpected message");
    }
    attachments.push(toInputAttachmentSummary(mapInputAttachmentRecord(row)));
  }
  return attachmentsByMessage;
}

export async function listBoundInputAttachmentRecords(
  userId: string,
  messageId: string,
  database: Queryable = getPool(),
): Promise<MessageInputAttachmentRecord[]> {
  const result = await database.query<MessageInputAttachmentRow>(
    `
      SELECT
        ${INPUT_ATTACHMENT_COLUMNS},
        message_attachment.message_id,
        message_attachment.position
      FROM message_input_attachments message_attachment
      JOIN input_attachments attachment
        ON attachment.id = message_attachment.attachment_id
      JOIN messages message ON message.id = message_attachment.message_id
      JOIN conversations conversation
        ON conversation.id = message.conversation_id
      WHERE
        message_attachment.message_id = $1
        AND attachment.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
      ORDER BY message_attachment.position
    `,
    [messageId, userId],
  );
  return result.rows.map(mapMessageInputAttachmentRecord);
}
