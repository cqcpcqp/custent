import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/db/types";

import { listBackgroundRunHistoryPage } from "./history";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  firstRun: "33333333-3333-4333-8333-333333333333",
  secondRun: "33333333-3333-4333-8333-333333333332",
};

const finishedAt = new Date("2026-08-28T08:02:00.123Z");
const cursorFinishedAt = "2026-08-28T08:02:00.123456Z";

function historyRow(
  runId: string,
  overrides: Partial<{
    status: "completed" | "failed" | "cancelled" | "reconciliation_required";
    finished_at: Date;
    cursor_finished_at: string;
  }> = {},
) {
  return {
    run_id: runId,
    conversation_id: ids.conversation,
    conversation_title: "German pump buyers",
    status: "completed" as const,
    finished_at: finishedAt,
    cursor_finished_at: cursorFinishedAt,
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

describe("background Run history repository", () => {
  it("returns only the fixed terminal activity fields from owned, undeleted conversations", async () => {
    const mock = databaseWithRows([
      historyRow(ids.firstRun),
      historyRow(ids.secondRun, { status: "failed" }),
    ]);

    const page = await listBackgroundRunHistoryPage(
      { userId: ids.user, status: "all", cursor: null, limit: 20 },
      mock.database,
    );

    expect(page).toEqual({
      items: [
        {
          runId: ids.firstRun,
          conversationId: ids.conversation,
          conversationTitle: "German pump buyers",
          status: "completed",
          finishedAt: finishedAt.toISOString(),
        },
        {
          runId: ids.secondRun,
          conversationId: ids.conversation,
          conversationTitle: "German pump buyers",
          status: "failed",
          finishedAt: finishedAt.toISOString(),
        },
      ],
      nextCursor: null,
    });

    const sql = String(mock.query.mock.calls[0]?.[0]);
    expect(sql).toContain("conversation.user_id = run.user_id");
    expect(sql).toContain("run.user_id = $1");
    expect(sql).toContain("conversation.user_id = $1");
    expect(sql).toContain("conversation.deleted_at IS NULL");
    expect(sql).toContain("run.status IN");
    expect(sql).toContain("run.finished_at IS NOT NULL");
    expect(sql).toContain("ORDER BY run.finished_at DESC, run.id DESC");
    expect(sql).not.toContain("credit_ledger");
    expect(mock.query.mock.calls[0]?.[1]).toEqual([
      ids.user,
      "all",
      null,
      null,
      21,
    ]);
  });

  it("applies one exact terminal status at the repository boundary", async () => {
    const mock = databaseWithRows([historyRow(ids.secondRun, { status: "failed" })]);

    await listBackgroundRunHistoryPage(
      { userId: ids.user, status: "failed", cursor: null, limit: 7 },
      mock.database,
    );

    expect(String(mock.query.mock.calls[0]?.[0])).toContain(
      "$2::text = 'all' OR run.status = $2::text",
    );
    expect(mock.query.mock.calls[0]?.[1]).toEqual([
      ids.user,
      "failed",
      null,
      null,
      8,
    ]);
  });

  it("uses a canonical microsecond finishedAt keyset cursor without equal-time gaps", async () => {
    const mock = databaseWithRows(
      [historyRow(ids.firstRun), historyRow(ids.secondRun)],
      [historyRow(ids.secondRun)],
    );

    const firstPage = await listBackgroundRunHistoryPage(
      { userId: ids.user, status: "all", cursor: null, limit: 1 },
      mock.database,
    );
    expect(firstPage.items.map((item) => item.runId)).toEqual([ids.firstRun]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listBackgroundRunHistoryPage(
      {
        userId: ids.user,
        status: "all",
        cursor: firstPage.nextCursor,
        limit: 1,
      },
      mock.database,
    );
    expect(secondPage.items.map((item) => item.runId)).toEqual([
      ids.secondRun,
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(mock.query.mock.calls[1]?.[1]).toEqual([
      ids.user,
      "all",
      cursorFinishedAt,
      ids.firstRun,
      2,
    ]);
  });

  it("rejects a cursor from another status filter before querying", async () => {
    const source = databaseWithRows([
      historyRow(ids.firstRun),
      historyRow(ids.secondRun),
    ]);
    const firstPage = await listBackgroundRunHistoryPage(
      { userId: ids.user, status: "all", cursor: null, limit: 1 },
      source.database,
    );
    const target = databaseWithRows();

    await expect(
      listBackgroundRunHistoryPage(
        {
          userId: ids.user,
          status: "completed",
          cursor: firstPage.nextCursor,
          limit: 1,
        },
        target.database,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "后台任务历史分页游标无效。",
      status: 400,
    });
    expect(target.query).not.toHaveBeenCalled();
  });
});
