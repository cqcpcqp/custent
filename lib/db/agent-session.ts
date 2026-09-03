import type { AgentInputItem, Session } from "@openai/agents";
import type { Pool } from "pg";

import { AppError } from "@/lib/errors";

import { getPool, withTransaction } from "./pool";

type SessionItemRow = {
  item: AgentInputItem;
};

export class AgentSessionStore implements Session {
  constructor(
    readonly conversationId: string,
    private readonly database: Pool = getPool(),
  ) {}

  async getSessionId(): Promise<string> {
    return this.conversationId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit !== undefined && limit <= 0) {
      return [];
    }

    const result =
      limit === undefined
        ? await this.database.query<SessionItemRow>(
            `
              SELECT item
              FROM agent_session_items session_item
              JOIN conversations conversation
                ON conversation.id = session_item.conversation_id
              WHERE
                session_item.conversation_id = $1
                AND conversation.deleted_at IS NULL
              ORDER BY session_item.position
            `,
            [this.conversationId],
          )
        : await this.database.query<SessionItemRow>(
            `
              SELECT item
              FROM (
                SELECT session_item.item, session_item.position
                FROM agent_session_items session_item
                JOIN conversations conversation
                  ON conversation.id = session_item.conversation_id
                WHERE
                  session_item.conversation_id = $1
                  AND conversation.deleted_at IS NULL
                ORDER BY session_item.position DESC
                LIMIT $2
              ) recent
              ORDER BY position
            `,
            [this.conversationId, limit],
          );

    return structuredClone(result.rows.map((row) => row.item));
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const serializedItems = JSON.stringify(structuredClone(items));
    await withTransaction(async (client) => {
      const conversation = await client.query<{ id: string }>(
        `
          SELECT id
          FROM conversations
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE
        `,
        [this.conversationId],
      );
      if (conversation.rowCount !== 1) {
        throw new AppError("NOT_FOUND", "Conversation was not found", 404);
      }

      await client.query(
        `
          WITH current_position AS (
            SELECT COALESCE(MAX(position), 0) AS value
            FROM agent_session_items
            WHERE conversation_id = $1
          )
          INSERT INTO agent_session_items (conversation_id, position, item)
          SELECT
            $1,
            current_position.value + serialized.ordinality,
            serialized.item
          FROM current_position
          CROSS JOIN LATERAL jsonb_array_elements($2::jsonb)
            WITH ORDINALITY AS serialized(item, ordinality)
        `,
        [this.conversationId, serializedItems],
      );
    }, this.database);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return withTransaction(async (client) => {
      const conversation = await client.query<{ id: string }>(
        `
          SELECT id
          FROM conversations
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE
        `,
        [this.conversationId],
      );
      if (conversation.rowCount !== 1) {
        throw new AppError("NOT_FOUND", "Conversation was not found", 404);
      }

      const result = await client.query<SessionItemRow>(
        `
          DELETE FROM agent_session_items
          WHERE id = (
            SELECT id
            FROM agent_session_items
            WHERE conversation_id = $1
            ORDER BY position DESC
            LIMIT 1
          )
          RETURNING item
        `,
        [this.conversationId],
      );

      return result.rowCount === 0
        ? undefined
        : structuredClone(result.rows[0].item);
    }, this.database);
  }

  async clearSession(): Promise<void> {
    await this.database.query(
      "DELETE FROM agent_session_items WHERE conversation_id = $1",
      [this.conversationId],
    );
  }
}
