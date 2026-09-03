import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "./types";
import { setMessageFeedback } from "./messages";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  message: "22222222-2222-4222-8222-222222222222",
};

function databaseReturning(feedback: "up" | "down" | null) {
  const query = vi.fn().mockResolvedValue({
    rowCount: 1,
    rows: [{ message_id: ids.message, feedback }],
  });
  return {
    database: { query } as unknown as Queryable,
    query,
  };
}

describe("setMessageFeedback", () => {
  it.each(["up", "down", null] as const)(
    "writes and returns exact %s feedback",
    async (feedback) => {
      const { database, query } = databaseReturning(feedback);

      await expect(
        setMessageFeedback(ids.user, ids.message, feedback, database),
      ).resolves.toEqual({ messageId: ids.message, feedback });

      const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
      const normalizedSql = sql.replaceAll(/\s+/gu, " ").trim();
      expect(normalizedSql).toContain("message.id = $1");
      expect(normalizedSql).toContain("conversation.user_id = $2");
      expect(normalizedSql).toContain("conversation.deleted_at IS NULL");
      expect(normalizedSql).toContain("message.role = 'assistant'");
      expect(parameters).toEqual([ids.message, ids.user, feedback]);
    },
  );

  it("is idempotent and allows feedback to be withdrawn", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ message_id: ids.message, feedback: "up" }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ message_id: ids.message, feedback: "up" }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ message_id: ids.message, feedback: null }],
      });
    const database = { query } as unknown as Queryable;

    await expect(
      setMessageFeedback(ids.user, ids.message, "up", database),
    ).resolves.toEqual({ messageId: ids.message, feedback: "up" });
    await expect(
      setMessageFeedback(ids.user, ids.message, "up", database),
    ).resolves.toEqual({ messageId: ids.message, feedback: "up" });
    await expect(
      setMessageFeedback(ids.user, ids.message, null, database),
    ).resolves.toEqual({ messageId: ids.message, feedback: null });
  });

  it("hides missing, cross-user, deleted-conversation, and user messages", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const database = { query } as unknown as Queryable;

    await expect(
      setMessageFeedback(ids.user, ids.message, "down", database),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Message was not found",
      status: 404,
    });
  });

  it("rejects values outside the fixed feedback contract", async () => {
    const query = vi.fn();
    const database = { query } as unknown as Queryable;

    await expect(
      setMessageFeedback(
        ids.user,
        ids.message,
        "sideways" as "up",
        database,
      ),
    ).rejects.toBeDefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an unexpected database feedback value instead of coercing it", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ message_id: ids.message, feedback: "positive" }],
    });
    const database = { query } as unknown as Queryable;

    await expect(
      setMessageFeedback(ids.user, ids.message, "up", database),
    ).rejects.toBeDefined();
  });
});
