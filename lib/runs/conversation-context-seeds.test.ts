import type { AgentInputItem } from "@openai/agents";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  ConversationContextSeedIntegrityError,
  readConversationContextSeedItems,
} from "./conversation-context-seeds";

const conversationId = "11111111-1111-4111-8111-111111111111";
const items = [
  { role: "user", content: "Find pump buyers" },
  {
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Three candidates found." }],
  },
] satisfies AgentInputItem[];

function queryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function database(rows: Array<{
  item_count: number;
  position: number | null;
  item: unknown | null;
}>) {
  return {
    query: vi.fn(async () => queryResult(rows)),
  } as unknown as PoolClient;
}

describe("readConversationContextSeedItems", () => {
  it("distinguishes a missing seed from a valid empty seed", async () => {
    await expect(
      readConversationContextSeedItems(conversationId, database([])),
    ).resolves.toBeNull();
    await expect(
      readConversationContextSeedItems(
        conversationId,
        database([{ item_count: 0, position: null, item: null }]),
      ),
    ).resolves.toEqual([]);
  });

  it("returns detached strictly validated AgentInputItems", async () => {
    const rows = items.map((item, index) => ({
      item_count: items.length,
      position: index + 1,
      item,
    }));
    const result = await readConversationContextSeedItems(
      conversationId,
      database(rows),
    );

    expect(result).toEqual(items);
    expect(result?.[0]).not.toBe(rows[0].item);
  });

  it("rejects count, position, and item contract corruption", async () => {
    await expect(
      readConversationContextSeedItems(
        conversationId,
        database([{ item_count: 2, position: 1, item: items[0] }]),
      ),
    ).rejects.toThrow("item_count is 2, but 1 item rows");

    await expect(
      readConversationContextSeedItems(
        conversationId,
        database([
          { item_count: 2, position: 1, item: items[0] },
          { item_count: 2, position: 1, item: items[1] },
        ]),
      ),
    ).rejects.toThrow("expected item position 2, received 1");

    await expect(
      readConversationContextSeedItems(
        conversationId,
        database([
          {
            item_count: 1,
            position: 1,
            item: { role: "bogus", content: "x" },
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(ConversationContextSeedIntegrityError);
  });
});
