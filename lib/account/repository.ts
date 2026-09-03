import { z } from "zod";

import {
  AccountUsageItemSchema,
  AccountUsageResponseSchema,
  type AccountUsageItem,
  type AccountUsageResponse,
  type AgentRunStatus,
} from "@/lib/contracts";
import { getPool } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";
import { AppError } from "@/lib/errors";

type AccountUsageCursor = {
  createdAt: string;
  runId: string;
};

type AccountUsagePageInput = {
  userId: string;
  cursor: string | null;
  limit: number;
};

type AccountBalanceRow = {
  available_credits: number;
  reserved_credits: number;
  frozen_credits: number;
};

type AccountUsageRow = {
  run_id: string;
  conversation_id: string;
  conversation_title: string;
  status: AgentRunStatus;
  reservation_credits: number;
  charged_credits: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  web_searches: number | null;
  created_at: Date;
  cursor_created_at: string;
  finished_at: Date | null;
};

const AccountUsagePageInputSchema = z
  .object({
    userId: z.string().uuid(),
    cursor: z.string().min(1).max(1_024).nullable(),
    limit: z.number().int().min(1).max(50).safe(),
  })
  .strict();

const EncodedAccountUsageCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);

const AccountUsageCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("account_usage"),
    createdAt: z.string().datetime(),
    runId: z.string().uuid(),
  })
  .strict();

function invalidCursor(): AppError {
  return new AppError("INVALID_REQUEST", "用量明细分页游标无效。", 400);
}

function decodeAccountUsageCursor(
  encodedValue: string | null,
): AccountUsageCursor | null {
  if (encodedValue === null) {
    return null;
  }

  try {
    const encoded = EncodedAccountUsageCursorSchema.parse(encodedValue);
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw invalidCursor();
    }
    const parsed = AccountUsageCursorSchema.parse(
      JSON.parse(decoded.toString("utf8")),
    );
    return { createdAt: parsed.createdAt, runId: parsed.runId };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidCursor();
  }
}

function encodeAccountUsageCursor(
  row: Pick<AccountUsageRow, "cursor_created_at" | "run_id">,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "account_usage",
      createdAt: row.cursor_created_at,
      runId: row.run_id,
    }),
    "utf8",
  ).toString("base64url");
}

function mapAccountUsageItem(row: AccountUsageRow): AccountUsageItem {
  return AccountUsageItemSchema.parse({
    runId: row.run_id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    status: row.status,
    reservationCredits: row.reservation_credits,
    chargedCredits: row.charged_credits,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    webSearches: row.web_searches,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  });
}

export async function getAccountUsagePage(
  rawInput: AccountUsagePageInput,
  database: Queryable = getPool(),
): Promise<AccountUsageResponse> {
  const input = AccountUsagePageInputSchema.parse(rawInput);
  const cursor = decodeAccountUsageCursor(input.cursor);
  const balanceResult = await database.query<AccountBalanceRow>(
    `
      SELECT available_credits, reserved_credits, frozen_credits
      FROM users
      WHERE id = $1
    `,
    [input.userId],
  );
  if (balanceResult.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }

  const usageResult = await database.query<AccountUsageRow>(
    `
      SELECT
        run.id AS run_id,
        run.conversation_id,
        conversation.title AS conversation_title,
        run.status,
        run.reservation_credits,
        run.charged_credits,
        run.input_tokens,
        run.output_tokens,
        run.web_searches,
        run.created_at,
        to_char(
          run.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_created_at,
        run.finished_at
      FROM runs run
      JOIN conversations conversation
        ON conversation.id = run.conversation_id
        AND conversation.user_id = run.user_id
      WHERE
        run.user_id = $1
        AND conversation.user_id = $1
        AND (
          $2::timestamptz IS NULL
          OR run.created_at < $2::timestamptz
          OR (
            run.created_at = $2::timestamptz
            AND run.id < $3::uuid
          )
        )
      ORDER BY run.created_at DESC, run.id DESC
      LIMIT $4
    `,
    [
      input.userId,
      cursor?.createdAt ?? null,
      cursor?.runId ?? null,
      input.limit + 1,
    ],
  );
  const hasNextPage = usageResult.rows.length > input.limit;
  const pageRows = hasNextPage
    ? usageResult.rows.slice(0, input.limit)
    : usageResult.rows;

  return AccountUsageResponseSchema.parse({
    balance: {
      available: balanceResult.rows[0].available_credits,
      reserved: balanceResult.rows[0].reserved_credits,
      frozen: balanceResult.rows[0].frozen_credits,
    },
    items: pageRows.map(mapAccountUsageItem),
    nextCursor:
      hasNextPage && pageRows.length > 0
        ? encodeAccountUsageCursor(pageRows[pageRows.length - 1])
        : null,
  });
}
