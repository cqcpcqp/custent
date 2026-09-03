import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConversation,
  insertMessage,
  listMessages,
  setMessageFeedback,
} from "@/lib/db";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migrationFilenames = [
  "001_initial.sql",
  "002_run_finalization.sql",
  "003_run_integrity.sql",
  "004_durable_agent_runs.sql",
  "005_conversation_lifecycle.sql",
  "006_input_attachments.sql",
  "007_input_attachment_lifecycle.sql",
  "008_conversation_attention.sql",
  "009_run_turn_queue.sql",
  "010_retry_predecessor_integrity.sql",
  "011_legacy_run_message_links.sql",
  "012_generic_artifacts.sql",
  "013_message_feedback.sql",
  "014_done_event_message_feedback.sql",
  "015_run_regeneration_snapshots.sql",
  "016_conversation_branches.sql",
] as const;

describe.runIf(databaseUrl !== undefined)(
  "message feedback PostgreSQL repository",
  () => {
    const ownerId = randomUUID();
    const otherUserId = randomUUID();
    const schemaName = `feedback_repository_${randomUUID().replaceAll("-", "")}`;
    let adminDatabase: Pool;
    let database: Pool;

    beforeAll(async () => {
      adminDatabase = new Pool({ connectionString: databaseUrl, max: 1 });
      await adminDatabase.query(`CREATE SCHEMA ${schemaName}`);
      database = new Pool({
        connectionString: databaseUrl,
        max: 1,
        options: `-c search_path=${schemaName},public`,
      });
      for (const filename of migrationFilenames) {
        await database.query(
          await readFile(path.join(migrationsDirectory, filename), "utf8"),
        );
      }
      await database.query(
        `
          INSERT INTO users (id, name, available_credits)
          VALUES
            ($1, 'Feedback owner', 100),
            ($2, 'Feedback other user', 100)
        `,
        [ownerId, otherUserId],
      );
    });

    afterAll(async () => {
      await database.query(
        "DELETE FROM conversations WHERE user_id = ANY($1::uuid[])",
        [[ownerId, otherUserId]],
      );
      await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
        [ownerId, otherUserId],
      ]);
      await database.end();
      await adminDatabase.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.end();
    });

    it("rates only an owned assistant message in a visible conversation", async () => {
      const activeConversation = await createConversation(
        ownerId,
        "Active feedback",
        database,
      );
      const deletedConversation = await createConversation(
        ownerId,
        "Deleted feedback",
        database,
      );
      const otherConversation = await createConversation(
        otherUserId,
        "Other feedback",
        database,
      );
      const userMessage = await insertMessage(
        {
          userId: ownerId,
          conversationId: activeConversation.id,
          role: "user",
          content: "question",
          citations: [],
        },
        database,
      );
      const assistantMessage = await insertMessage(
        {
          userId: ownerId,
          conversationId: activeConversation.id,
          role: "assistant",
          content: "answer",
          citations: [],
        },
        database,
      );
      const deletedAssistantMessage = await insertMessage(
        {
          userId: ownerId,
          conversationId: deletedConversation.id,
          role: "assistant",
          content: "deleted answer",
          citations: [],
        },
        database,
      );
      const otherAssistantMessage = await insertMessage(
        {
          userId: otherUserId,
          conversationId: otherConversation.id,
          role: "assistant",
          content: "other answer",
          citations: [],
        },
        database,
      );
      const runId = randomUUID();
      const runClient = await database.connect();
      try {
        await runClient.query("BEGIN");
        await runClient.query(
          `
            INSERT INTO runs (
              id,
              request_id,
              user_id,
              conversation_id,
              status,
              reservation_credits,
              input_message_id,
              assistant_message_id,
              conversation_turn
            )
            VALUES ($1, $2, $3, $4, 'queued', 1, $5, $6, 1)
          `,
          [
            runId,
            randomUUID(),
            ownerId,
            activeConversation.id,
            userMessage.id,
            assistantMessage.id,
          ],
        );
        await runClient.query(
          "UPDATE messages SET run_id = $1 WHERE id = ANY($2::uuid[])",
          [runId, [userMessage.id, assistantMessage.id]],
        );
        await runClient.query(
          "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
          [activeConversation.id, runId],
        );
        await runClient.query(
          `
            INSERT INTO run_events (run_id, event_type, payload)
            VALUES ($1, 'done', $2::jsonb)
          `,
          [
            runId,
            JSON.stringify({
              type: "done",
              message: {
                ...assistantMessage,
                runId,
              },
              credits: { available: 99, reserved: 1 },
            }),
          ],
        );
        await runClient.query("COMMIT");
      } catch (error) {
        await runClient.query("ROLLBACK");
        throw error;
      } finally {
        runClient.release();
      }
      await database.query(
        "UPDATE conversations SET deleted_at = now() WHERE id = $1",
        [deletedConversation.id],
      );

      for (const feedback of ["up", "up", "down", null] as const) {
        await expect(
          setMessageFeedback(
            ownerId,
            assistantMessage.id,
            feedback,
            database,
          ),
        ).resolves.toEqual({ messageId: assistantMessage.id, feedback });
        await expect(
          database.query<{ feedback: "up" | "down" | null }>(
            `
              SELECT payload -> 'message' ->> 'feedback' AS feedback
              FROM run_events
              WHERE run_id = $1 AND event_type = 'done'
            `,
            [runId],
          ),
        ).resolves.toMatchObject({ rows: [{ feedback }] });
      }

      const messages = await listMessages(
        ownerId,
        activeConversation.id,
        database,
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: userMessage.id, feedback: null }),
          expect.objectContaining({
            id: assistantMessage.id,
            feedback: null,
          }),
        ]),
      );

      for (const [userId, messageId] of [
        [otherUserId, assistantMessage.id],
        [ownerId, otherAssistantMessage.id],
        [ownerId, deletedAssistantMessage.id],
        [ownerId, userMessage.id],
      ] as const) {
        await expect(
          setMessageFeedback(userId, messageId, "down", database),
        ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      }
    });
  },
);
