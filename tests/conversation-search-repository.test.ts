import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { listConversationPage } from "@/lib/db/conversations";

const userId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const timestamp = new Date("2026-08-28T01:02:03.000Z");

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: conversationId,
    title: "German pump buyers",
    updated_at: timestamp,
    pinned_at: null,
    archived_at: null,
    selected_run_id: null,
    active_run_id: null,
    active_run_status: null,
    active_run_started_at: null,
    waiting_run_count: 0,
    attention_terminal_event_id: null,
    attention_run_id: null,
    attention_run_status: null,
    attention_finished_at: null,
    cursor_pinned_at: null,
    cursor_updated_at: "2026-08-28T01:02:03.000000Z",
    search_match_kind: null,
    search_message_id: null,
    search_message_role: null,
    search_message_created_at: null,
    search_excerpt_before: null,
    search_excerpt_match: null,
    search_excerpt_after: null,
    search_before_truncated: null,
    search_after_truncated: null,
    ...overrides,
  };
}

describe("conversation search repository", () => {
  it("searches only selected-branch messages with literal patterns and the fixed keyset order", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = { query } as unknown as Pool;

    await expect(
      listConversationPage(
        {
          userId,
          view: "active",
          query: "50%_\\ valve",
          cursor: null,
          limit: 30,
        },
        database,
      ),
    ).resolves.toEqual({ items: [], nextCursor: null });

    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    const normalizedSql = sql.replaceAll(/\s+/gu, " ").trim();

    expect(normalizedSql).toContain("conversation.user_id = $1");
    expect(normalizedSql).toContain("conversation.deleted_at IS NULL");
    expect(normalizedSql).toContain("WITH RECURSIVE selected_path AS");
    expect(normalizedSql).toContain(
      "selected_run.id = conversation.selected_run_id",
    );
    expect(normalizedSql).toContain("message.content ILIKE $3");
    expect(normalizedSql).toContain(
      "path_run.input_message_id = message.id",
    );
    expect(normalizedSql).toContain(
      "path_run.id = message.run_id AND path_run.assistant_message_id = message.id",
    );
    expect(normalizedSql).toContain(
      "ORDER BY message.created_at DESC, message.id DESC LIMIT 1",
    );
    expect(normalizedSql).toContain(
      "ORDER BY conversation.pinned_at DESC NULLS LAST, conversation.updated_at DESC, conversation.id DESC LIMIT $10",
    );
    expect(parameters).toEqual([
      userId,
      "active",
      "%50\\%\\_\\\\ valve%",
      "50%_\\ valve",
      "50\\%\\_\\\\ valve",
      null,
      null,
      null,
      false,
      31,
    ]);
  });

  it("maps an empty query to a mandatory null search match", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [conversationRow()] });
    const database = { query } as unknown as Pool;

    const page = await listConversationPage(
      {
        userId,
        view: "active",
        query: "",
        cursor: null,
        limit: 30,
      },
      database,
    );

    expect(page.items).toEqual([
      {
        id: conversationId,
        title: "German pump buyers",
        updatedAt: timestamp.toISOString(),
        pinnedAt: null,
        archivedAt: null,
        selectedRunId: null,
        activeRun: null,
        waitingRunCount: 0,
        attention: null,
        searchMatch: null,
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toEqual([
      userId,
      "active",
      null,
      null,
      null,
      null,
      null,
      null,
      false,
      31,
    ]);
  });

  it("maps exact title and message excerpts without deriving client-side matches", async () => {
    const messageCreatedAt = new Date("2026-08-28T01:01:00.000Z");
    const query = vi.fn().mockResolvedValue({
      rows: [
        conversationRow({
          search_match_kind: "title",
          search_excerpt_before: "German ",
          search_excerpt_match: "pump",
          search_excerpt_after: " buyers",
          search_before_truncated: false,
          search_after_truncated: false,
        }),
        conversationRow({
          id: "44444444-4444-4444-8444-444444444444",
          title: "Sourcing research",
          search_match_kind: "message",
          search_message_id: messageId,
          search_message_role: "assistant",
          search_message_created_at: messageCreatedAt,
          search_excerpt_before: "not an inserted ellipsis ",
          search_excerpt_match: "pump",
          search_excerpt_after: " distributors",
          search_before_truncated: true,
          search_after_truncated: false,
        }),
      ],
    });
    const database = { query } as unknown as Pool;

    const page = await listConversationPage(
      {
        userId,
        view: "active",
        query: "pump",
        cursor: null,
        limit: 30,
      },
      database,
    );

    expect(page.items[0]?.searchMatch).toEqual({
      kind: "title",
      excerpt: {
        before: "German ",
        match: "pump",
        after: " buyers",
        beforeTruncated: false,
        afterTruncated: false,
      },
    });
    expect(page.items[1]?.searchMatch).toEqual({
      kind: "message",
      messageId,
      role: "assistant",
      createdAt: messageCreatedAt.toISOString(),
      excerpt: {
        before: "not an inserted ellipsis ",
        match: "pump",
        after: " distributors",
        beforeTruncated: true,
        afterTruncated: false,
      },
    });
  });

  it("fails closed when search metadata is internally incomplete", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        conversationRow({
          search_match_kind: "message",
          search_message_id: messageId,
        }),
      ],
    });
    const database = { query } as unknown as Pool;

    await expect(
      listConversationPage(
        {
          userId,
          view: "active",
          query: "pump",
          cursor: null,
          limit: 30,
        },
        database,
      ),
    ).rejects.toThrow("Conversation search excerpt is incomplete");
  });
});
