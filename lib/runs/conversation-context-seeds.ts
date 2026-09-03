import { isDeepStrictEqual } from "node:util";

import { protocol, type AgentInputItem } from "@openai/agents";

import { getPool } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";

type ContextSeedRow = {
  item_count: number;
  position: number | null;
  item: unknown | null;
};

export class ConversationContextSeedIntegrityError extends Error {
  constructor(readonly conversationId: string, detail: string) {
    super(`Conversation context seed ${conversationId} is inconsistent: ${detail}`);
    this.name = "ConversationContextSeedIntegrityError";
  }
}

function integrityError(
  conversationId: string,
  detail: string,
): ConversationContextSeedIntegrityError {
  return new ConversationContextSeedIntegrityError(conversationId, detail);
}

function parseAgentInputItem(
  conversationId: string,
  position: number,
  value: unknown,
): AgentInputItem {
  const parsed = protocol.ModelItem.safeParse(value);
  if (!parsed.success) {
    throw integrityError(
      conversationId,
      `item at position ${position} is not a valid AgentInputItem`,
    );
  }
  if (!isDeepStrictEqual(parsed.data, value)) {
    throw integrityError(
      conversationId,
      `item at position ${position} contains fields outside the AgentInputItem contract`,
    );
  }
  return parsed.data;
}

export async function readConversationContextSeedItems(
  conversationId: string,
  database: Queryable = getPool(),
): Promise<AgentInputItem[] | null> {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new TypeError("conversationId must not be empty");
  }

  const result = await database.query<ContextSeedRow>(
    `
      SELECT
        seed.item_count,
        seed_item.position,
        seed_item.item
      FROM conversation_context_seeds seed
      LEFT JOIN conversation_context_seed_items seed_item
        ON seed_item.conversation_id = seed.conversation_id
      WHERE seed.conversation_id = $1
      ORDER BY seed_item.position
    `,
    [conversationId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const itemCount = result.rows[0].item_count;
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw integrityError(conversationId, "item_count is invalid");
  }
  if (result.rows.some((row) => row.item_count !== itemCount)) {
    throw integrityError(conversationId, "item_count differs between item rows");
  }

  if (itemCount === 0) {
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      row.position !== null ||
      row.item !== null
    ) {
      throw integrityError(conversationId, "empty seed has persisted item rows");
    }
    return [];
  }

  if (result.rows.length !== itemCount) {
    throw integrityError(
      conversationId,
      `item_count is ${itemCount}, but ${result.rows.length} item rows were read`,
    );
  }

  return structuredClone(
    result.rows.map((row, index) => {
      const position = index + 1;
      if (row.position !== position) {
        throw integrityError(
          conversationId,
          `expected item position ${position}, received ${String(row.position)}`,
        );
      }
      return parseAgentInputItem(conversationId, position, row.item);
    }),
  );
}
