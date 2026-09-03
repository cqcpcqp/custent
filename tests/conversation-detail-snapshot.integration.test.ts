import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConversationResponse } from "@/lib/contracts";
import {
  createConversation,
  getConversation,
  listMessages,
  withReadOnlyRepeatableReadTransaction,
  withTransaction,
} from "@/lib/db";
import { listConversationRuns } from "@/lib/runs";
import { insertCapturedRunExecutionConfig } from "@/lib/run-config";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(databaseUrl !== undefined)(
  "conversation detail snapshot",
  () => {
    const userId = randomUUID();
    let database: Pool;

    beforeAll(async () => {
      database = new Pool({ connectionString: databaseUrl });
      await database.query(
        `
          INSERT INTO users (id, name, available_credits)
          VALUES ($1, 'Conversation snapshot user', 1000)
        `,
        [userId],
      );
    });

    afterAll(async () => {
      await database.query("DELETE FROM conversations WHERE user_id = $1", [
        userId,
      ]);
      await database.query("DELETE FROM users WHERE id = $1", [userId]);
      await database.end();
    });

    it("keeps summary, messages, and runs on the snapshot established before a concurrent Run insert", async () => {
      const conversation = await createConversation(
        userId,
        "Snapshot consistency fixture",
        database,
      );
      const runId = randomUUID();

      const detail = await withReadOnlyRepeatableReadTransaction(
        async (client): Promise<ConversationResponse> => {
          const snapshotConversation = await getConversation(
            userId,
            conversation.id,
            client,
          );
          if (snapshotConversation === null) {
            throw new Error("Snapshot conversation was not found");
          }
          expect(snapshotConversation.activeRun).toBeNull();

          await withTransaction(
            async (writer) => {
              await writer.query(
                `
                  INSERT INTO runs (
                    id,
                    request_id,
                    user_id,
                    conversation_id,
                    status,
                    reservation_credits,
                    conversation_turn,
                    attempt_index
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, 1, 1)
                `,
                [runId, randomUUID(), userId, conversation.id],
              );
              await insertCapturedRunExecutionConfig(
                runId,
                {
                  ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
                  billing: {
                    ...TEST_CAPTURED_RUN_EXECUTION_CONFIG.billing,
                    reservationCredits: 20,
                  },
                },
                writer,
              );
              await writer.query(
                `
                  UPDATE conversations
                  SET selected_run_id = $2
                  WHERE id = $1 AND user_id = $3
                `,
                [conversation.id, runId, userId],
              );
            },
            database,
          );

          const messages = await listMessages(userId, conversation.id, client);
          const runs = await listConversationRuns(
            userId,
            conversation.id,
            client,
          );
          return { conversation: snapshotConversation, messages, runs };
        },
        database,
      );

      expect(detail).toMatchObject({
        conversation: { id: conversation.id, activeRun: null },
        messages: [],
        runs: [],
      });

      const currentConversation = await getConversation(
        userId,
        conversation.id,
        database,
      );
      expect(currentConversation?.activeRun).toMatchObject({
        id: runId,
        status: "queued",
      });
      await expect(
        listConversationRuns(userId, conversation.id, database),
      ).resolves.toHaveLength(1);
    });
  },
);
