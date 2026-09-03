import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/db/types";

import { getAccountUsagePage } from "./repository";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  firstRun: "33333333-3333-4333-8333-333333333333",
  secondRun: "33333333-3333-4333-8333-333333333332",
};

const createdAt = new Date("2026-08-28T08:00:00.123Z");
const finishedAt = new Date("2026-08-28T08:02:00.000Z");
const cursorCreatedAt = "2026-08-28T08:00:00.123456Z";
const balanceRow = {
  available_credits: 7_495,
  reserved_credits: 1_500,
  frozen_credits: 500,
};

function usageRow(
  runId: string,
  overrides: Partial<{
    status:
      | "waiting"
      | "queued"
      | "running"
      | "completed"
      | "failed"
      | "cancelled"
      | "reconciliation_required";
    charged_credits: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    web_searches: number | null;
    finished_at: Date | null;
  }> = {},
) {
  return {
    run_id: runId,
    conversation_id: ids.conversation,
    conversation_title: "Soft-deleted buyer research",
    status: "completed" as const,
    reservation_credits: 2_000,
    charged_credits: 37,
    input_tokens: 1_200,
    output_tokens: 320,
    web_searches: 4,
    created_at: createdAt,
    cursor_created_at: cursorCreatedAt,
    finished_at: finishedAt,
    ...overrides,
  };
}

function databaseWithRows(...rowSets: unknown[][]) {
  const query = vi.fn();
  for (const rows of rowSets) {
    query.mockResolvedValueOnce({ rowCount: rows.length, rows });
  }
  return { database: { query } as unknown as Queryable, query };
}

describe("account usage repository", () => {
  it("returns distinct balances and one fixed item per Run", async () => {
    const mock = databaseWithRows(
      [balanceRow],
      [
        usageRow(ids.firstRun),
        usageRow(ids.secondRun, {
          status: "reconciliation_required",
          charged_credits: null,
          input_tokens: null,
          output_tokens: null,
          web_searches: null,
        }),
      ],
    );

    const page = await getAccountUsagePage(
      { userId: ids.user, cursor: null, limit: 30 },
      mock.database,
    );

    expect(page).toEqual({
      balance: { available: 7_495, reserved: 1_500, frozen: 500 },
      items: [
        {
          runId: ids.firstRun,
          conversationId: ids.conversation,
          conversationTitle: "Soft-deleted buyer research",
          status: "completed",
          reservationCredits: 2_000,
          chargedCredits: 37,
          inputTokens: 1_200,
          outputTokens: 320,
          webSearches: 4,
          createdAt: createdAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        },
        {
          runId: ids.secondRun,
          conversationId: ids.conversation,
          conversationTitle: "Soft-deleted buyer research",
          status: "reconciliation_required",
          reservationCredits: 2_000,
          chargedCredits: null,
          inputTokens: null,
          outputTokens: null,
          webSearches: null,
          createdAt: createdAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        },
      ],
      nextCursor: null,
    });

    const sql = String(mock.query.mock.calls[1]?.[0]);
    expect(sql).toContain("JOIN conversations conversation");
    expect(sql).toContain("conversation.user_id = run.user_id");
    expect(sql).toContain("run.user_id = $1");
    expect(sql).toContain("conversation.user_id = $1");
    expect(sql).toContain("ORDER BY run.created_at DESC, run.id DESC");
    expect(sql).not.toContain("conversation.deleted_at");
    expect(sql).not.toContain("credit_ledger");
  });

  it("uses a canonical microsecond keyset cursor without gaps at equal times", async () => {
    const mock = databaseWithRows(
      [balanceRow],
      [usageRow(ids.firstRun), usageRow(ids.secondRun)],
      [balanceRow],
      [usageRow(ids.secondRun)],
    );

    const firstPage = await getAccountUsagePage(
      { userId: ids.user, cursor: null, limit: 1 },
      mock.database,
    );
    expect(firstPage.items.map((item) => item.runId)).toEqual([ids.firstRun]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await getAccountUsagePage(
      { userId: ids.user, cursor: firstPage.nextCursor, limit: 1 },
      mock.database,
    );
    expect(secondPage.items.map((item) => item.runId)).toEqual([ids.secondRun]);
    expect(secondPage.nextCursor).toBeNull();
    expect(mock.query.mock.calls[3]?.[1]).toEqual([
      ids.user,
      cursorCreatedAt,
      ids.firstRun,
      2,
    ]);
  });

  it("rejects a non-usage cursor before reading account data", async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "research",
        createdAt: cursorCreatedAt,
        runId: ids.firstRun,
      }),
      "utf8",
    ).toString("base64url");
    const mock = databaseWithRows();

    await expect(
      getAccountUsagePage(
        { userId: ids.user, cursor, limit: 30 },
        mock.database,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "用量明细分页游标无效。",
      status: 400,
    });
    expect(mock.query).not.toHaveBeenCalled();
  });

  it("fails closed when the current user does not exist", async () => {
    const mock = databaseWithRows([]);

    await expect(
      getAccountUsagePage(
        { userId: ids.user, cursor: null, limit: 30 },
        mock.database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(mock.query).toHaveBeenCalledOnce();
  });
});
