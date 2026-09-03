import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "@/lib/db/types";

import { listConversationSharePage } from "./conversation-shares";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  firstConversation: "33333333-3333-4333-8333-333333333333",
  secondConversation: "22222222-2222-4222-8222-222222222222",
  firstPublic: "44444444-4444-4444-8444-444444444444",
  secondPublic: "55555555-5555-4555-8555-555555555555",
};

const updatedAt = new Date("2026-08-30T08:00:00.123Z");
const cursorUpdatedAt = "2026-08-30T08:00:00.123456Z";

function shareRow(
  conversationId: string,
  publicId: string,
  title: string,
) {
  return {
    conversation_id: conversationId,
    public_id: publicId,
    title,
    created_at: new Date("2026-08-29T08:00:00.000Z"),
    updated_at: updatedAt,
    cursor_updated_at: cursorUpdatedAt,
  };
}

function databaseWithPages(...pages: unknown[][]) {
  const query = vi.fn();
  for (const rows of pages) {
    query.mockResolvedValueOnce({ rowCount: rows.length, rows });
  }
  return { database: { query } as unknown as Queryable, query };
}

describe("conversation share management repository", () => {
  it("returns owner-visible metadata without loading snapshot messages", async () => {
    const mock = databaseWithPages([
      shareRow(
        ids.firstConversation,
        ids.firstPublic,
        "Archived shared buyers",
      ),
    ]);

    await expect(
      listConversationSharePage(
        { userId: ids.user, cursor: null, limit: 30 },
        mock.database,
      ),
    ).resolves.toEqual({
      items: [
        {
          conversationId: ids.firstConversation,
          publicId: ids.firstPublic,
          publicPath: `/share/${ids.firstPublic}`,
          title: "Archived shared buyers",
          createdAt: "2026-08-29T08:00:00.000Z",
          updatedAt: updatedAt.toISOString(),
        },
      ],
      nextCursor: null,
    });

    const sql = String(mock.query.mock.calls[0]?.[0]);
    expect(sql).toContain("conversation.user_id = $1");
    expect(sql).toContain("conversation.deleted_at IS NULL");
    expect(sql).toContain(
      "ORDER BY share.updated_at DESC, share.conversation_id DESC",
    );
    expect(sql).not.toContain("conversation.archived_at");
    expect(sql).not.toContain("share.messages");
    expect(mock.query.mock.calls[0]?.[1]).toEqual([
      ids.user,
      null,
      null,
      31,
    ]);
  });

  it("uses an exact microsecond keyset cursor at equal update times", async () => {
    const firstRow = shareRow(
      ids.firstConversation,
      ids.firstPublic,
      "First share",
    );
    const secondRow = shareRow(
      ids.secondConversation,
      ids.secondPublic,
      "Second share",
    );
    const mock = databaseWithPages([firstRow, secondRow], [secondRow]);

    const firstPage = await listConversationSharePage(
      { userId: ids.user, cursor: null, limit: 1 },
      mock.database,
    );
    expect(firstPage.items.map((item) => item.publicId)).toEqual([
      ids.firstPublic,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listConversationSharePage(
      { userId: ids.user, cursor: firstPage.nextCursor, limit: 1 },
      mock.database,
    );
    expect(secondPage.items.map((item) => item.publicId)).toEqual([
      ids.secondPublic,
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(mock.query.mock.calls[1]?.[1]).toEqual([
      ids.user,
      cursorUpdatedAt,
      ids.firstConversation,
      2,
    ]);
  });

  it("rejects a cursor for another collection before database access", async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "account_usage",
        updatedAt: cursorUpdatedAt,
        conversationId: ids.firstConversation,
      }),
      "utf8",
    ).toString("base64url");
    const mock = databaseWithPages();

    await expect(
      listConversationSharePage(
        { userId: ids.user, cursor, limit: 30 },
        mock.database,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "共享链接分页游标无效。",
      status: 400,
    });
    expect(mock.query).not.toHaveBeenCalled();
  });
});
