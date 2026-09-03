import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  BackgroundRunHistoryItemSchema,
  BackgroundRunHistoryResponseSchema,
  BackgroundRunHistoryStatusFilterSchema,
  type BackgroundRunHistoryItem,
  type BackgroundRunHistoryResponse,
  type BackgroundRunHistoryStatusFilter,
  type TerminalAgentRunStatus,
} from "@/lib/contracts";
import { getPool } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";
import { AppError } from "@/lib/errors";

type BackgroundRunHistoryPageInput = Readonly<{
  userId: string;
  status: BackgroundRunHistoryStatusFilter;
  cursor: string | null;
  limit: number;
}>;

type BackgroundRunHistoryCursor = Readonly<{
  finishedAt: string;
  runId: string;
}>;

type BackgroundRunHistoryRow = {
  run_id: string;
  conversation_id: string;
  conversation_title: string;
  status: TerminalAgentRunStatus;
  finished_at: Date;
  cursor_finished_at: string;
};

const BackgroundRunHistoryPageInputSchema = z
  .object({
    userId: z.string().uuid(),
    status: BackgroundRunHistoryStatusFilterSchema,
    cursor: z.string().min(1).max(1_024).nullable(),
    limit: z.number().int().min(1).max(50).safe(),
  })
  .strict();

const EncodedBackgroundRunHistoryCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);

const BackgroundRunHistoryCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("background_run_history"),
    status: BackgroundRunHistoryStatusFilterSchema,
    finishedAt: z.string().datetime(),
    runId: z.string().uuid(),
  })
  .strict();

function invalidBackgroundRunHistoryCursor(): AppError {
  return new AppError(
    "INVALID_REQUEST",
    "后台任务历史分页游标无效。",
    400,
  );
}

function decodeBackgroundRunHistoryCursor(
  encodedValue: string | null,
  status: BackgroundRunHistoryStatusFilter,
): BackgroundRunHistoryCursor | null {
  if (encodedValue === null) {
    return null;
  }

  try {
    const encoded = EncodedBackgroundRunHistoryCursorSchema.parse(encodedValue);
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw invalidBackgroundRunHistoryCursor();
    }
    const parsed = BackgroundRunHistoryCursorSchema.parse(
      JSON.parse(decoded.toString("utf8")),
    );
    if (parsed.status !== status) {
      throw invalidBackgroundRunHistoryCursor();
    }
    return { finishedAt: parsed.finishedAt, runId: parsed.runId };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidBackgroundRunHistoryCursor();
  }
}

function encodeBackgroundRunHistoryCursor(
  row: Pick<BackgroundRunHistoryRow, "cursor_finished_at" | "run_id">,
  status: BackgroundRunHistoryStatusFilter,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "background_run_history",
      status,
      finishedAt: row.cursor_finished_at,
      runId: row.run_id,
    }),
    "utf8",
  ).toString("base64url");
}

function mapBackgroundRunHistoryItem(
  row: BackgroundRunHistoryRow,
): BackgroundRunHistoryItem {
  return BackgroundRunHistoryItemSchema.parse({
    runId: row.run_id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    status: row.status,
    finishedAt: row.finished_at.toISOString(),
  });
}

export async function listBackgroundRunHistoryPage(
  rawInput: BackgroundRunHistoryPageInput,
  database: Queryable = getPool(),
): Promise<BackgroundRunHistoryResponse> {
  const input = BackgroundRunHistoryPageInputSchema.parse(rawInput);
  const cursor = decodeBackgroundRunHistoryCursor(input.cursor, input.status);
  const result = await database.query<BackgroundRunHistoryRow>(
    `
      SELECT
        run.id AS run_id,
        run.conversation_id,
        conversation.title AS conversation_title,
        run.status,
        run.finished_at,
        to_char(
          run.finished_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_finished_at
      FROM runs run
      JOIN conversations conversation
        ON conversation.id = run.conversation_id
        AND conversation.user_id = run.user_id
      WHERE
        run.user_id = $1
        AND conversation.user_id = $1
        AND conversation.deleted_at IS NULL
        AND run.status IN (
          'completed',
          'failed',
          'cancelled',
          'reconciliation_required'
        )
        AND ($2::text = 'all' OR run.status = $2::text)
        AND run.finished_at IS NOT NULL
        AND (
          $3::timestamptz IS NULL
          OR run.finished_at < $3::timestamptz
          OR (
            run.finished_at = $3::timestamptz
            AND run.id < $4::uuid
          )
        )
      ORDER BY run.finished_at DESC, run.id DESC
      LIMIT $5
    `,
    [
      input.userId,
      input.status,
      cursor?.finishedAt ?? null,
      cursor?.runId ?? null,
      input.limit + 1,
    ],
  );
  const hasNextPage = result.rows.length > input.limit;
  const pageRows = hasNextPage
    ? result.rows.slice(0, input.limit)
    : result.rows;

  return BackgroundRunHistoryResponseSchema.parse({
    items: pageRows.map(mapBackgroundRunHistoryItem),
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? encodeBackgroundRunHistoryCursor(
            pageRows[pageRows.length - 1],
            input.status,
          )
        : null,
  });
}
