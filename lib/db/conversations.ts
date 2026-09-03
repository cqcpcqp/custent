import { Buffer } from "node:buffer";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  BulkConversationMutationSchema,
  type BulkConversationMutation,
  ConversationListItemSchema,
  type ActiveRunSummary,
  type ConversationAttention,
  type ConversationListItem,
  type ConversationListView,
  type ConversationSearchMatch,
  type ConversationSummary,
  type ListConversationsResponse,
  type PatchConversationRequest,
} from "@/lib/contracts";
import { AppError } from "@/lib/errors";

import { getPool, withTransaction } from "./pool";
import { type Queryable, toIsoString } from "./types";

type ConversationRow = {
  id: string;
  title: string;
  updated_at: Date;
  pinned_at: Date | null;
  archived_at: Date | null;
  selected_run_id: string | null;
  active_run_id: string | null;
  active_run_status: ActiveRunSummary["status"] | null;
  active_run_started_at: Date | null;
  waiting_run_count: number;
  attention_terminal_event_id: string | null;
  attention_run_id: string | null;
  attention_run_status: ConversationAttention["status"] | null;
  attention_finished_at: Date | null;
};

type ConversationPageRow = ConversationRow & {
  cursor_pinned_at: string | null;
  cursor_updated_at: string;
  search_match_kind: ConversationSearchMatch["kind"] | null;
  search_message_id: string | null;
  search_message_role: "user" | "assistant" | null;
  search_message_created_at: Date | null;
  search_excerpt_before: string | null;
  search_excerpt_match: string | null;
  search_excerpt_after: string | null;
  search_before_truncated: boolean | null;
  search_after_truncated: boolean | null;
};

type ConversationCursor = {
  pinnedAt: string | null;
  updatedAt: string;
  id: string;
};

export type ConversationDeletion = {
  conversationId: string;
  deletedAt: string;
};

const ConversationCursorSchema = z
  .object({
    version: z.literal(1),
    pinnedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

const EncodedConversationCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);

const conversationRunColumns = `
  active_run.id AS active_run_id,
  active_run.status AS active_run_status,
  active_run.started_at AS active_run_started_at,
  waiting_runs.waiting_run_count,
  attention.event_id AS attention_terminal_event_id,
  attention.run_id AS attention_run_id,
  attention.status AS attention_run_status,
  attention.finished_at AS attention_finished_at
`;

const conversationRunJoins = `
  LEFT JOIN LATERAL (
    SELECT run.id, run.status, run.started_at
    FROM runs run
    WHERE
      run.conversation_id = conversation.id
      AND run.status IN ('queued', 'running')
    ORDER BY run.created_at DESC, run.id DESC
    LIMIT 1
  ) active_run ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::integer AS waiting_run_count
    FROM runs run
    WHERE
      run.conversation_id = conversation.id
      AND run.status = 'waiting'
  ) waiting_runs ON true
  LEFT JOIN LATERAL (
    SELECT
      event.id AS event_id,
      run.id AS run_id,
      run.status,
      run.finished_at
    FROM runs run
    JOIN run_events event ON event.run_id = run.id
    WHERE
      run.conversation_id = conversation.id
      AND run.status IN (
        'completed',
        'failed',
        'cancelled',
        'reconciliation_required'
      )
      AND event.event_type IN ('done', 'error')
      AND event.id > conversation.read_through_terminal_event_id
    ORDER BY event.id DESC
    LIMIT 1
  ) attention ON true
`;

function mapConversation(row: ConversationRow): ConversationSummary {
  if (
    !Number.isSafeInteger(row.waiting_run_count) ||
    row.waiting_run_count < 0
  ) {
    throw new TypeError("Waiting run count is invalid");
  }

  let activeRun: ActiveRunSummary | null = null;
  if (row.active_run_id !== null) {
    if (row.active_run_status === null) {
      throw new TypeError("Active run status is missing");
    }
    activeRun = {
      id: row.active_run_id,
      status: row.active_run_status,
      startedAt: row.active_run_started_at?.toISOString() ?? null,
    };
  } else if (
    row.active_run_status !== null ||
    row.active_run_started_at !== null
  ) {
    throw new TypeError("Active run fields are inconsistent");
  }

  const attentionFieldCount = [
    row.attention_terminal_event_id,
    row.attention_run_id,
    row.attention_run_status,
    row.attention_finished_at,
  ].filter((field) => field !== null).length;
  if (attentionFieldCount !== 0 && attentionFieldCount !== 4) {
    throw new TypeError("Conversation attention fields are inconsistent");
  }
  const attention: ConversationAttention | null =
    attentionFieldCount === 0
      ? null
      : {
          terminalEventId: row.attention_terminal_event_id as string,
          runId: row.attention_run_id as string,
          status: row.attention_run_status as ConversationAttention["status"],
          finishedAt: (row.attention_finished_at as Date).toISOString(),
        };

  return {
    id: row.id,
    title: row.title,
    updatedAt: toIsoString(row.updated_at),
    pinnedAt: row.pinned_at === null ? null : toIsoString(row.pinned_at),
    archivedAt:
      row.archived_at === null ? null : toIsoString(row.archived_at),
    selectedRunId: row.selected_run_id,
    activeRun,
    waitingRunCount: row.waiting_run_count,
    attention,
  };
}

function mapConversationListItem(
  row: ConversationPageRow,
): ConversationListItem {
  const excerptFields = [
    row.search_excerpt_before,
    row.search_excerpt_match,
    row.search_excerpt_after,
    row.search_before_truncated,
    row.search_after_truncated,
  ];
  const messageFields = [
    row.search_message_id,
    row.search_message_role,
    row.search_message_created_at,
  ];

  let searchMatch: ConversationSearchMatch | null;
  if (row.search_match_kind === null) {
    if (
      [...excerptFields, ...messageFields].some((field) => field !== null)
    ) {
      throw new TypeError("Empty conversation search match has populated fields");
    }
    searchMatch = null;
  } else {
    if (excerptFields.some((field) => field === null)) {
      throw new TypeError("Conversation search excerpt is incomplete");
    }
    const excerpt = {
      before: row.search_excerpt_before as string,
      match: row.search_excerpt_match as string,
      after: row.search_excerpt_after as string,
      beforeTruncated: row.search_before_truncated as boolean,
      afterTruncated: row.search_after_truncated as boolean,
    };
    if (row.search_match_kind === "title") {
      if (messageFields.some((field) => field !== null)) {
        throw new TypeError("Title search match has message fields");
      }
      searchMatch = { kind: "title", excerpt };
    } else {
      if (messageFields.some((field) => field === null)) {
        throw new TypeError("Message search match is incomplete");
      }
      searchMatch = {
        kind: "message",
        messageId: row.search_message_id as string,
        role: row.search_message_role as "user" | "assistant",
        createdAt: (row.search_message_created_at as Date).toISOString(),
        excerpt,
      };
    }
  }

  return ConversationListItemSchema.parse({
    ...mapConversation(row),
    searchMatch,
  });
}

function encodeConversationCursor(row: ConversationPageRow): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      pinnedAt: row.cursor_pinned_at,
      updatedAt: row.cursor_updated_at,
      id: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeConversationCursor(cursor: string): ConversationCursor {
  const encoded = EncodedConversationCursorSchema.parse(cursor);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new AppError(
      "INVALID_REQUEST",
      "Conversation cursor is invalid",
      400,
    );
  }
  const parsed = ConversationCursorSchema.parse(
    JSON.parse(decoded.toString("utf8")),
  );
  return {
    pinnedAt: parsed.pinnedAt,
    updatedAt: parsed.updatedAt,
    id: parsed.id,
  };
}

function searchPatterns(query: string): {
  contains: string;
  literal: string;
} | null {
  if (query.length === 0) {
    return null;
  }
  const escaped = query
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return { contains: `%${escaped}%`, literal: escaped };
}

async function selectConversationRows(
  input: {
    userId: string;
    view: ConversationListView;
    query: string;
    cursor: ConversationCursor | null;
    limit: number | null;
  },
  database: Queryable,
): Promise<ConversationPageRow[]> {
  const patterns = searchPatterns(input.query);
  const result = await database.query<ConversationPageRow>(
    `
      SELECT
        conversation.id,
        conversation.title,
        conversation.updated_at,
        conversation.pinned_at,
        conversation.archived_at,
        conversation.selected_run_id,
        to_char(
          conversation.pinned_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_pinned_at,
        to_char(
          conversation.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_updated_at,
        search_source.kind AS search_match_kind,
        CASE
          WHEN search_source.kind = 'message' THEN search_message.id
          ELSE NULL
        END AS search_message_id,
        CASE
          WHEN search_source.kind = 'message' THEN search_message.role
          ELSE NULL
        END AS search_message_role,
        CASE
          WHEN search_source.kind = 'message' THEN search_message.created_at
          ELSE NULL
        END AS search_message_created_at,
        CASE
          WHEN search_source.kind IS NULL THEN NULL
          WHEN search_source.kind = 'title' THEN substring(
            search_source.content
            FROM 1
            FOR search_location.character_position - 1
          )
          ELSE substring(
            search_source.content
            FROM greatest(search_location.character_position - 80, 1)
            FOR search_location.character_position
              - greatest(search_location.character_position - 80, 1)
          )
        END AS search_excerpt_before,
        CASE
          WHEN search_source.kind IS NULL THEN NULL
          ELSE substring(
            search_source.content
            FROM search_location.character_position
            FOR char_length($4::text)
          )
        END AS search_excerpt_match,
        CASE
          WHEN search_source.kind IS NULL THEN NULL
          WHEN search_source.kind = 'title' THEN substring(
            search_source.content
            FROM search_location.character_position + char_length($4::text)
          )
          ELSE substring(
            search_source.content
            FROM search_location.character_position + char_length($4::text)
            FOR 80
          )
        END AS search_excerpt_after,
        CASE
          WHEN search_source.kind IS NULL THEN NULL
          WHEN search_source.kind = 'title' THEN false
          ELSE search_location.character_position > 81
        END AS search_before_truncated,
        CASE
          WHEN search_source.kind IS NULL THEN NULL
          WHEN search_source.kind = 'title' THEN false
          ELSE char_length(search_source.content) >
            search_location.character_position - 1
              + char_length($4::text) + 80
        END AS search_after_truncated,
        ${conversationRunColumns}
      FROM conversations conversation
      ${conversationRunJoins}
      LEFT JOIN LATERAL (
        WITH RECURSIVE selected_path AS (
          SELECT
            selected_run.id,
            selected_run.input_message_id,
            selected_run.assistant_message_id,
            selected_run.predecessor_run_id
          FROM runs selected_run
          WHERE
            selected_run.id = conversation.selected_run_id
            AND selected_run.conversation_id = conversation.id
            AND selected_run.user_id = conversation.user_id
          UNION ALL
          SELECT
            predecessor.id,
            predecessor.input_message_id,
            predecessor.assistant_message_id,
            predecessor.predecessor_run_id
          FROM runs predecessor
          JOIN selected_path child
            ON child.predecessor_run_id = predecessor.id
          WHERE
            predecessor.conversation_id = conversation.id
            AND predecessor.user_id = conversation.user_id
        )
        SELECT
          message.id,
          message.run_id,
          message.role,
          message.content,
          message.created_at
        FROM messages message
        WHERE
          message.conversation_id = conversation.id
          AND message.content ILIKE $3 ESCAPE E'\\\\'
          AND (
            message.run_id IS NULL
            OR (
              message.role = 'user'
              AND EXISTS (
                SELECT 1
                FROM selected_path path_run
                WHERE path_run.input_message_id = message.id
              )
            )
            OR (
              message.role = 'assistant'
              AND EXISTS (
                SELECT 1
                FROM selected_path path_run
                WHERE
                  path_run.id = message.run_id
                  AND path_run.assistant_message_id = message.id
              )
            )
          )
        ORDER BY message.created_at DESC, message.id DESC
        LIMIT 1
      ) search_message ON
        $3::text IS NOT NULL
        AND conversation.title NOT ILIKE $3 ESCAPE E'\\\\'
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN conversation.title ILIKE $3 ESCAPE E'\\\\' THEN 'title'
            WHEN search_message.id IS NOT NULL THEN 'message'
            ELSE NULL
          END AS kind,
          CASE
            WHEN conversation.title ILIKE $3 ESCAPE E'\\\\'
              THEN conversation.title
            WHEN search_message.id IS NOT NULL THEN search_message.content
            ELSE NULL
          END AS content
      ) search_source ON true
      LEFT JOIN LATERAL (
        SELECT candidate_position AS character_position
        FROM generate_series(
          1,
          char_length(search_source.content) - char_length($4::text) + 1
        ) candidate_position
        WHERE
          substring(
            search_source.content
            FROM candidate_position
            FOR char_length($4::text)
          ) ILIKE $5 ESCAPE E'\\\\'
        ORDER BY candidate_position
        LIMIT 1
      ) search_location ON search_source.kind IS NOT NULL
      WHERE
        conversation.user_id = $1
        AND conversation.deleted_at IS NULL
        AND (
          ($2 = 'active' AND conversation.archived_at IS NULL)
          OR ($2 = 'archived' AND conversation.archived_at IS NOT NULL)
        )
        AND (
          $3::text IS NULL
          OR (
            search_source.kind IS NOT NULL
            AND search_location.character_position IS NOT NULL
          )
        )
        AND (
          NOT $9::boolean
          OR (
            $6::timestamptz IS NOT NULL
            AND (
              conversation.pinned_at < $6::timestamptz
              OR conversation.pinned_at IS NULL
              OR (
                conversation.pinned_at = $6::timestamptz
                AND (
                  conversation.updated_at < $7::timestamptz
                  OR (
                    conversation.updated_at = $7::timestamptz
                    AND conversation.id < $8::uuid
                  )
                )
              )
            )
          )
          OR (
            $6::timestamptz IS NULL
            AND conversation.pinned_at IS NULL
            AND (
              conversation.updated_at < $7::timestamptz
              OR (
                conversation.updated_at = $7::timestamptz
                AND conversation.id < $8::uuid
              )
            )
          )
        )
      ORDER BY
        conversation.pinned_at DESC NULLS LAST,
        conversation.updated_at DESC,
        conversation.id DESC
      LIMIT $10
    `,
    [
      input.userId,
      input.view,
      patterns?.contains ?? null,
      patterns === null ? null : input.query,
      patterns?.literal ?? null,
      input.cursor?.pinnedAt ?? null,
      input.cursor?.updatedAt ?? null,
      input.cursor?.id ?? null,
      input.cursor !== null,
      input.limit,
    ],
  );

  return result.rows;
}

export async function listConversations(
  userId: string,
  database: Queryable = getPool(),
): Promise<ConversationSummary[]> {
  const rows = await selectConversationRows(
    {
      userId,
      view: "active",
      query: "",
      cursor: null,
      limit: null,
    },
    database,
  );
  return rows.map(mapConversation);
}

export async function listConversationPage(
  input: {
    userId: string;
    view: ConversationListView;
    query: string;
    cursor: string | null;
    limit: number;
  },
  database: Queryable = getPool(),
): Promise<ListConversationsResponse> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new TypeError("limit must be an integer between 1 and 50");
  }
  const cursor = input.cursor === null
    ? null
    : decodeConversationCursor(input.cursor);
  const rows = await selectConversationRows(
    {
      userId: input.userId,
      view: input.view,
      query: input.query,
      cursor,
      limit: input.limit + 1,
    },
    database,
  );
  const hasNextPage = rows.length > input.limit;
  const pageRows = hasNextPage ? rows.slice(0, input.limit) : rows;

  return {
    items: pageRows.map(mapConversationListItem),
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? encodeConversationCursor(pageRows[pageRows.length - 1])
        : null,
  };
}

export async function listTrackedConversations(
  userId: string,
  database: Queryable = getPool(),
): Promise<ConversationSummary[]> {
  const result = await database.query<ConversationRow>(
    `
      WITH pending_run_state AS MATERIALIZED (
        SELECT
          run.conversation_id,
          (
            ARRAY_AGG(run.id ORDER BY run.created_at DESC, run.id DESC)
            FILTER (WHERE run.status IN ('queued', 'running'))
          )[1] AS active_run_id,
          (
            ARRAY_AGG(run.status ORDER BY run.created_at DESC, run.id DESC)
            FILTER (WHERE run.status IN ('queued', 'running'))
          )[1] AS active_run_status,
          (
            ARRAY_AGG(run.started_at ORDER BY run.created_at DESC, run.id DESC)
            FILTER (WHERE run.status IN ('queued', 'running'))
          )[1] AS active_run_started_at,
          COUNT(*) FILTER (WHERE run.status = 'waiting')::integer
            AS waiting_run_count
        FROM runs run
        JOIN conversations owned_conversation
          ON owned_conversation.id = run.conversation_id
        WHERE
          run.user_id = $1
          AND run.status IN ('waiting', 'queued', 'running')
          AND owned_conversation.user_id = $1
          AND owned_conversation.deleted_at IS NULL
          AND owned_conversation.archived_at IS NULL
        GROUP BY run.conversation_id
      ),
      unread_attention AS MATERIALIZED (
        SELECT DISTINCT ON (run.conversation_id)
          run.conversation_id,
          event.id AS event_id,
          run.id AS run_id,
          run.status,
          run.finished_at
        FROM runs run
        JOIN conversations owned_conversation
          ON owned_conversation.id = run.conversation_id
        JOIN run_events event ON event.run_id = run.id
        WHERE
          run.user_id = $1
          AND run.status IN (
            'completed',
            'failed',
            'cancelled',
            'reconciliation_required'
          )
          AND owned_conversation.user_id = $1
          AND owned_conversation.deleted_at IS NULL
          AND owned_conversation.archived_at IS NULL
          AND event.event_type IN ('done', 'error')
          AND event.id > owned_conversation.read_through_terminal_event_id
        ORDER BY run.conversation_id, event.id DESC
      ),
      candidate_conversations AS (
        SELECT pending_run_state.conversation_id
        FROM pending_run_state
        UNION
        SELECT unread_attention.conversation_id
        FROM unread_attention
      )
      SELECT
        conversation.id,
        conversation.title,
        conversation.updated_at,
        conversation.pinned_at,
        conversation.archived_at,
        conversation.selected_run_id,
        pending_run_state.active_run_id,
        pending_run_state.active_run_status,
        pending_run_state.active_run_started_at,
        COALESCE(pending_run_state.waiting_run_count, 0)::integer
          AS waiting_run_count,
        unread_attention.event_id AS attention_terminal_event_id,
        unread_attention.run_id AS attention_run_id,
        unread_attention.status AS attention_run_status,
        unread_attention.finished_at AS attention_finished_at
      FROM candidate_conversations candidate
      JOIN conversations conversation
        ON conversation.id = candidate.conversation_id
      LEFT JOIN pending_run_state
        ON pending_run_state.conversation_id = conversation.id
      LEFT JOIN unread_attention
        ON unread_attention.conversation_id = conversation.id
      WHERE
        conversation.user_id = $1
        AND conversation.deleted_at IS NULL
        AND conversation.archived_at IS NULL
      ORDER BY
        conversation.pinned_at DESC NULLS LAST,
        conversation.updated_at DESC,
        conversation.id DESC
    `,
    [userId],
  );

  return result.rows.map(mapConversation);
}

export async function createConversation(
  userId: string,
  title: string,
  database: Queryable = getPool(),
): Promise<ConversationSummary> {
  const result = await database.query<ConversationRow>(
    `
      INSERT INTO conversations (
        user_id,
        title,
        custom_instructions_snapshot,
        custom_instructions_snapshot_revision
      )
      SELECT
        account.id,
        $2,
        CASE
          WHEN account.custom_instructions_enabled
            THEN account.custom_instructions_content
          ELSE NULL
        END,
        CASE
          WHEN account.custom_instructions_enabled
            THEN account.custom_instructions_revision
          ELSE 0
        END
      FROM users account
      WHERE account.id = $1
      RETURNING
        id,
        title,
        updated_at,
        pinned_at,
        archived_at,
        selected_run_id,
        NULL::uuid AS active_run_id,
        NULL::text AS active_run_status,
        NULL::timestamptz AS active_run_started_at,
        0::integer AS waiting_run_count,
        NULL::bigint AS attention_terminal_event_id,
        NULL::uuid AS attention_run_id,
        NULL::text AS attention_run_status,
        NULL::timestamptz AS attention_finished_at
    `,
    [userId, title],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }

  return mapConversation(result.rows[0]);
}

export async function getConversation(
  userId: string,
  conversationId: string,
  database: Queryable = getPool(),
): Promise<ConversationSummary | null> {
  const result = await database.query<ConversationRow>(
    `
      SELECT
        conversation.id,
        conversation.title,
        conversation.updated_at,
        conversation.pinned_at,
        conversation.archived_at,
        conversation.selected_run_id,
        ${conversationRunColumns}
      FROM conversations conversation
      ${conversationRunJoins}
      WHERE
        conversation.id = $1
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
    `,
    [conversationId, userId],
  );

  return result.rowCount === 0 ? null : mapConversation(result.rows[0]);
}

export async function updateConversationTitle(
  conversationId: string,
  userId: string,
  title: string,
  database: Queryable = getPool(),
): Promise<ConversationSummary> {
  const result = await database.query<ConversationRow>(
    `
      WITH updated AS (
        UPDATE conversations
        SET title = $3, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING
          id,
          title,
          updated_at,
          pinned_at,
          archived_at,
          selected_run_id,
          read_through_terminal_event_id
      )
      SELECT
        conversation.id,
        conversation.title,
        conversation.updated_at,
        conversation.pinned_at,
        conversation.archived_at,
        conversation.selected_run_id,
        ${conversationRunColumns}
      FROM updated conversation
      ${conversationRunJoins}
    `,
    [conversationId, userId, title],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Conversation was not found", 404);
  }
  return mapConversation(result.rows[0]);
}

async function lockOwnedConversation(
  userId: string,
  conversationId: string,
  client: PoolClient,
): Promise<void> {
  const target = await client.query<{ id: string }>(
    `
      SELECT id
      FROM conversations
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `,
    [conversationId, userId],
  );
  if (target.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Conversation was not found", 404);
  }
}

async function rejectActiveRun(
  conversationId: string,
  client: PoolClient,
): Promise<void> {
  const activeRun = await client.query<{ id: string }>(
    `
      SELECT id
      FROM runs
      WHERE
        conversation_id = $1
        AND status IN ('waiting', 'queued', 'running')
      LIMIT 1
    `,
    [conversationId],
  );
  if (activeRun.rowCount !== 0) {
    throw new AppError(
      "ACTIVE_RUN",
      "Conversation has an active run",
      409,
    );
  }
}

async function lockBulkConversationIds(
  userId: string,
  action: BulkConversationMutation["action"],
  client: PoolClient,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    action === "archive_all"
      ? `
          SELECT id
          FROM conversations
          WHERE
            user_id = $1
            AND deleted_at IS NULL
            AND archived_at IS NULL
          ORDER BY id
          FOR UPDATE
        `
      : `
          SELECT id
          FROM conversations
          WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY id
          FOR UPDATE
        `,
    [userId],
  );
  return result.rows.map((row) => row.id);
}

async function rejectBulkActiveRun(
  conversationIds: string[],
  client: PoolClient,
): Promise<void> {
  if (conversationIds.length === 0) {
    return;
  }
  const activeRun = await client.query<{ id: string }>(
    `
      SELECT id
      FROM runs
      WHERE
        conversation_id = ANY($1::uuid[])
        AND status IN ('waiting', 'queued', 'running')
      ORDER BY conversation_id, id
      LIMIT 1
    `,
    [conversationIds],
  );
  if (activeRun.rowCount !== 0) {
    throw new AppError(
      "ACTIVE_RUN",
      "Conversation has an active run",
      409,
    );
  }
}

async function bulkMutationCompletion(
  action: BulkConversationMutation["action"],
  conversationCount: number,
  client: PoolClient,
): Promise<BulkConversationMutation> {
  const result = await client.query<{ completed_at: Date }>(
    "SELECT clock_timestamp() AS completed_at",
  );
  if (result.rowCount !== 1) {
    throw new TypeError("Bulk conversation completion time is missing");
  }
  return BulkConversationMutationSchema.parse({
    action,
    conversationCount,
    completedAt: toIsoString(result.rows[0].completed_at),
  });
}

export async function archiveAllConversations(
  userId: string,
  database: Pool = getPool(),
): Promise<BulkConversationMutation> {
  return withTransaction(async (client) => {
    const conversationIds = await lockBulkConversationIds(
      userId,
      "archive_all",
      client,
    );
    await rejectBulkActiveRun(conversationIds, client);

    if (conversationIds.length !== 0) {
      const archived = await client.query<{ id: string }>(
        `
          UPDATE conversations
          SET archived_at = now()
          WHERE
            id = ANY($1::uuid[])
            AND user_id = $2
            AND deleted_at IS NULL
            AND archived_at IS NULL
          RETURNING id
        `,
        [conversationIds, userId],
      );
      if (archived.rowCount !== conversationIds.length) {
        throw new TypeError("Bulk conversation archive changed unexpectedly");
      }
    }

    return bulkMutationCompletion(
      "archive_all",
      conversationIds.length,
      client,
    );
  }, database);
}

export async function softDeleteAllConversations(
  userId: string,
  database: Pool = getPool(),
): Promise<BulkConversationMutation> {
  return withTransaction(async (client) => {
    const conversationIds = await lockBulkConversationIds(
      userId,
      "delete_all",
      client,
    );
    await rejectBulkActiveRun(conversationIds, client);

    if (conversationIds.length !== 0) {
      await client.query(
        `
          DELETE FROM conversation_shares
          WHERE conversation_id = ANY($1::uuid[])
        `,
        [conversationIds],
      );
      const deleted = await client.query<{ id: string }>(
        `
          UPDATE conversations
          SET deleted_at = now()
          WHERE
            id = ANY($1::uuid[])
            AND user_id = $2
            AND deleted_at IS NULL
          RETURNING id
        `,
        [conversationIds, userId],
      );
      if (deleted.rowCount !== conversationIds.length) {
        throw new TypeError("Bulk conversation deletion changed unexpectedly");
      }
    }

    return bulkMutationCompletion(
      "delete_all",
      conversationIds.length,
      client,
    );
  }, database);
}

export async function patchConversation(
  userId: string,
  conversationId: string,
  request: PatchConversationRequest,
  database: Pool = getPool(),
): Promise<ConversationSummary> {
  return withTransaction(async (client) => {
    await lockOwnedConversation(userId, conversationId, client);

    if (
      (request.action === "set_archived" && request.archived) ||
      request.action === "select_run"
    ) {
      await rejectActiveRun(conversationId, client);
    }

    if (request.action === "rename") {
      await client.query(
        `
          UPDATE conversations
          SET title = $3, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        `,
        [conversationId, userId, request.title],
      );
    } else if (request.action === "set_pinned") {
      await client.query(
        `
          UPDATE conversations
          SET pinned_at = CASE
            WHEN $3::boolean THEN COALESCE(pinned_at, now())
            ELSE NULL
          END
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        `,
        [conversationId, userId, request.pinned],
      );
    } else if (request.action === "set_archived") {
      await client.query(
        `
          UPDATE conversations
          SET archived_at = CASE
            WHEN $3::boolean THEN COALESCE(archived_at, now())
            ELSE NULL
          END
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        `,
        [conversationId, userId, request.archived],
      );
    } else if (request.action === "mark_read") {
      const marked = await client.query<{ id: string }>(
        `
          UPDATE conversations conversation
          SET read_through_terminal_event_id = GREATEST(
            conversation.read_through_terminal_event_id,
            $3::bigint
          )
          WHERE
            conversation.id = $1
            AND conversation.user_id = $2
            AND conversation.deleted_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM run_events event
              JOIN runs run ON run.id = event.run_id
              WHERE
                event.id = $3::bigint
                AND event.event_type IN ('done', 'error')
                AND run.conversation_id = conversation.id
                AND run.user_id = conversation.user_id
                AND run.status IN (
                  'completed',
                  'failed',
                  'cancelled',
                  'reconciliation_required'
                )
            )
          RETURNING conversation.id
        `,
        [conversationId, userId, request.throughEventId],
      );
      if (marked.rowCount !== 1) {
        throw new AppError("NOT_FOUND", "Terminal run event was not found", 404);
      }
    } else {
      const selected = await client.query<{ id: string }>(
        `
          UPDATE conversations conversation
          SET selected_run_id = run.id, updated_at = now()
          FROM runs run
          WHERE
            conversation.id = $1
            AND conversation.user_id = $2
            AND conversation.deleted_at IS NULL
            AND run.id = $3
            AND run.conversation_id = conversation.id
            AND run.user_id = conversation.user_id
          RETURNING conversation.id
        `,
        [conversationId, userId, request.runId],
      );
      if (selected.rowCount !== 1) {
        throw new AppError("NOT_FOUND", "Run was not found", 404);
      }
    }

    const conversation = await getConversation(userId, conversationId, client);
    if (conversation === null) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }
    return conversation;
  }, database);
}

export async function softDeleteConversation(
  userId: string,
  conversationId: string,
  database: Pool = getPool(),
): Promise<ConversationDeletion> {
  return withTransaction(async (client) => {
    await lockOwnedConversation(userId, conversationId, client);
    await rejectActiveRun(conversationId, client);

    const result = await client.query<{
      id: string;
      deleted_at: Date;
    }>(
      `
        UPDATE conversations
        SET deleted_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id, deleted_at
      `,
      [conversationId, userId],
    );
    if (result.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }
    await client.query(
      `
        DELETE FROM conversation_shares
        WHERE conversation_id = $1
      `,
      [conversationId],
    );
    return {
      conversationId: result.rows[0].id,
      deletedAt: toIsoString(result.rows[0].deleted_at),
    };
  }, database);
}
