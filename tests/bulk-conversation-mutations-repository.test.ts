import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  archiveAllConversations,
  softDeleteAllConversations,
} from "@/lib/db/conversations";
import {
  enqueueChatRun,
  regenerateAgentRun,
  retryAgentRun,
} from "@/lib/runs";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  firstConversation: "22222222-2222-4222-8222-222222222222",
  secondConversation: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
};

function queryResult<T>(rows: T[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function databaseFixture(
  operation: (sql: string, params: unknown[] | undefined) => Promise<unknown>,
) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return queryResult([]);
    }
    return operation(sql, params);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const database = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { database, query };
}

describe("bulk conversation mutation repository", () => {
  it("locks archive targets in stable ID order before checking Runs and updating", async () => {
    const completedAt = new Date("2026-09-01T08:00:00.000Z");
    const fixture = databaseFixture(async (sql, params) => {
      if (sql.includes("SELECT id") && sql.includes("FROM conversations")) {
        expect(sql).toContain("archived_at IS NULL");
        expect(sql).toMatch(/ORDER BY id\s+FOR UPDATE/u);
        expect(params).toEqual([ids.user]);
        return queryResult([
          { id: ids.firstConversation },
          { id: ids.secondConversation },
        ]);
      }
      if (sql.includes("FROM runs")) {
        expect(sql).toContain("status IN ('waiting', 'queued', 'running')");
        expect(params).toEqual([
          [ids.firstConversation, ids.secondConversation],
        ]);
        return queryResult([]);
      }
      if (sql.includes("UPDATE conversations")) {
        expect(sql).toContain("SET archived_at = now()");
        expect(params).toEqual([
          [ids.firstConversation, ids.secondConversation],
          ids.user,
        ]);
        return queryResult([
          { id: ids.firstConversation },
          { id: ids.secondConversation },
        ]);
      }
      if (sql.includes("clock_timestamp()")) {
        return queryResult([{ completed_at: completedAt }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      archiveAllConversations(ids.user, fixture.database),
    ).resolves.toEqual({
      action: "archive_all",
      conversationCount: 2,
      completedAt: completedAt.toISOString(),
    });
    const statements = fixture.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes("FROM conversations")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("FROM runs")));
    expect(statements.findIndex((sql) => sql.includes("FROM runs")))
      .toBeLessThan(
        statements.findIndex((sql) => sql.includes("UPDATE conversations")),
      );
  });

  it("deletes every target share before soft-deleting active and archived conversations", async () => {
    const completedAt = new Date("2026-09-01T08:01:00.000Z");
    const fixture = databaseFixture(async (sql, params) => {
      if (sql.includes("SELECT id") && sql.includes("FROM conversations")) {
        expect(sql).not.toContain("archived_at IS NULL");
        expect(sql).toMatch(/ORDER BY id\s+FOR UPDATE/u);
        return queryResult([{ id: ids.firstConversation }]);
      }
      if (sql.includes("FROM runs")) {
        return queryResult([]);
      }
      if (sql.includes("DELETE FROM conversation_shares")) {
        expect(params).toEqual([[ids.firstConversation]]);
        return queryResult([]);
      }
      if (sql.includes("UPDATE conversations")) {
        expect(sql).toContain("SET deleted_at = now()");
        expect(params).toEqual([[ids.firstConversation], ids.user]);
        return queryResult([{ id: ids.firstConversation }]);
      }
      if (sql.includes("clock_timestamp()")) {
        return queryResult([{ completed_at: completedAt }]);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(
      softDeleteAllConversations(ids.user, fixture.database),
    ).resolves.toEqual({
      action: "delete_all",
      conversationCount: 1,
      completedAt: completedAt.toISOString(),
    });
    const statements = fixture.query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.findIndex((sql) =>
        sql.includes("DELETE FROM conversation_shares"),
      ),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.includes("UPDATE conversations")),
    );
  });

  it("rolls back without any partial mutation when one target has an outstanding Run", async () => {
    const fixture = databaseFixture(async (sql) => {
      if (sql.includes("SELECT id") && sql.includes("FROM conversations")) {
        return queryResult([
          { id: ids.firstConversation },
          { id: ids.secondConversation },
        ]);
      }
      if (sql.includes("FROM runs")) {
        return queryResult([{ id: ids.run }]);
      }
      throw new Error(`A mutation query ran after ACTIVE_RUN: ${sql}`);
    });

    await expect(
      softDeleteAllConversations(ids.user, fixture.database),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });
    expect(
      fixture.query.mock.calls.some(([sql]) =>
        String(sql).includes("DELETE FROM conversation_shares"),
      ),
    ).toBe(false);
    expect(
      fixture.query.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE conversations"),
      ),
    ).toBe(false);
    expect(fixture.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it("returns strict zero-count receipts without checking Runs or issuing mutations", async () => {
    const completionTimes = [
      new Date("2026-09-01T08:02:00.000Z"),
      new Date("2026-09-01T08:03:00.000Z"),
    ];
    let completionIndex = 0;
    const fixture = databaseFixture(async (sql) => {
      if (sql.includes("SELECT id") && sql.includes("FROM conversations")) {
        return queryResult([]);
      }
      if (sql.includes("clock_timestamp()")) {
        const completedAt = completionTimes[completionIndex];
        completionIndex += 1;
        return queryResult([{ completed_at: completedAt }]);
      }
      throw new Error(`Unexpected empty mutation query: ${sql}`);
    });

    await expect(
      archiveAllConversations(ids.user, fixture.database),
    ).resolves.toEqual({
      action: "archive_all",
      conversationCount: 0,
      completedAt: completionTimes[0].toISOString(),
    });
    await expect(
      softDeleteAllConversations(ids.user, fixture.database),
    ).resolves.toEqual({
      action: "delete_all",
      conversationCount: 0,
      completedAt: completionTimes[1].toISOString(),
    });
  });

  it("refuses to enqueue into an archived conversation at the locking read", async () => {
    const requestId = "55555555-5555-4555-8555-555555555555";
    const fixture = databaseFixture(async (sql) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return queryResult([]);
      }
      if (sql.includes("FROM runs run") && sql.includes("run.request_id")) {
        return queryResult([]);
      }
      if (
        sql.includes("SELECT id, title, selected_run_id") &&
        sql.includes("FROM conversations")
      ) {
        expect(sql).toContain("deleted_at IS NULL");
        expect(sql).toContain("archived_at IS NULL");
        expect(sql).toContain("FOR UPDATE");
        return queryResult([]);
      }
      throw new Error(`Unexpected archived enqueue query: ${sql}`);
    });

    await expect(
      enqueueChatRun(
        {
          userId: ids.user,
          request: {
            kind: "append",
            conversationId: ids.firstConversation,
            parentRunId: null,
            message: "Must remain archived",
            attachmentIds: [],
            requestId,
            executionProfileId: "standard_research",
          },
          executionConfig: TEST_CAPTURED_RUN_EXECUTION_CONFIG,
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        fixture.database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(fixture.query).toHaveBeenLastCalledWith("ROLLBACK");
  });

  it.each([
    ["retry", retryAgentRun] as const,
    ["regenerate", regenerateAgentRun] as const,
  ])("refuses to %s an archived conversation at its locking read", async (_name, mutateRun) => {
    const requestId = "66666666-6666-4666-8666-666666666666";
    const fixture = databaseFixture(async (sql) => {
      if (sql.includes("pg_advisory_xact_lock")) {
        return queryResult([]);
      }
      if (sql.includes("FROM runs run") && sql.includes("run.request_id = $1")) {
        return queryResult([]);
      }
      if (
        sql.includes("FROM conversations conversation") &&
        sql.includes("FOR UPDATE OF conversation")
      ) {
        expect(sql).toContain("conversation.deleted_at IS NULL");
        expect(sql).toContain("conversation.archived_at IS NULL");
        return queryResult([]);
      }
      throw new Error(`Unexpected archived Run mutation query: ${sql}`);
    });

    await expect(
      mutateRun(
        {
          userId: ids.user,
          sourceRunId: ids.run,
          requestId,
        },
        fixture.database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(fixture.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});
