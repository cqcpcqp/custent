import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migrationFilenamesBefore013 = [
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
] as const;

type MigrationContext = {
  client: PoolClient;
  migration013: string;
  assertion013: string;
  migration014: string;
  assertion014: string;
};

async function withSchemaBefore013(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_013_014_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    for (const filename of migrationFilenamesBefore013) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      client,
      migration013: await readFile(
        path.join(migrationsDirectory, "013_message_feedback.sql"),
        "utf8",
      ),
      assertion013: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/013_message_feedback.sql",
        ),
        "utf8",
      ),
      migration014: await readFile(
        path.join(
          migrationsDirectory,
          "014_done_event_message_feedback.sql",
        ),
        "utf8",
      ),
      assertion014: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/014_done_event_message_feedback.sql",
        ),
        "utf8",
      ),
    });
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release();
    await database.end();
  }
}

describe.runIf(databaseUrl !== undefined)(
  "013/014 message feedback migrations",
  () => {
    it("adds constrained message feedback in 013 and backfills done events in 014", async () => {
      await withSchemaBefore013(
        async ({
          client,
          migration013,
          assertion013,
          migration014,
          assertion014,
        }) => {
        const userId = randomUUID();
        const conversationId = randomUUID();
        const userMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        const runId = randomUUID();

        await client.query(
          "INSERT INTO users (id, name, available_credits) VALUES ($1, 'Feedback user', 100)",
          [userId],
        );
        await client.query(
          "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'Feedback')",
          [conversationId, userId],
        );
        await client.query(
          `
            INSERT INTO messages (id, conversation_id, role, content, citations)
            VALUES
              ($1, $2, 'user', 'question', '[]'),
              ($3, $2, 'assistant', 'answer', '[]')
          `,
          [userMessageId, conversationId, assistantMessageId],
        );
        await client.query("BEGIN");
        await client.query(
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
            userId,
            conversationId,
            userMessageId,
            assistantMessageId,
          ],
        );
        await client.query(
          "UPDATE messages SET run_id = $1 WHERE id = ANY($2::uuid[])",
          [runId, [userMessageId, assistantMessageId]],
        );
        await client.query(
          `
            INSERT INTO run_events (run_id, event_type, payload)
            VALUES ($1, 'done', $2::jsonb)
          `,
          [
            runId,
            JSON.stringify({
              type: "done",
              message: {
                id: assistantMessageId,
                runId,
                role: "assistant",
                content: "answer",
                citations: [],
                artifacts: [],
                attachments: [],
                createdAt: "2026-08-25T08:00:00.000Z",
              },
              credits: { available: 99, reserved: 1 },
            }),
          ],
        );
        await client.query("COMMIT");

        await client.query(migration013);

        await expect(
          client.query<{ id: string; feedback: string | null }>(
            `
              SELECT id, feedback
              FROM messages
              WHERE id = ANY($1::uuid[])
              ORDER BY id
            `,
            [[userMessageId, assistantMessageId]],
          ),
        ).resolves.toMatchObject({
          rows: expect.arrayContaining([
            { id: userMessageId, feedback: null },
            { id: assistantMessageId, feedback: null },
          ]),
        });
        await expect(
          client.query<{
            has_feedback: boolean;
            feedback_is_null: boolean | null;
          }>(
            `
              SELECT
                (payload -> 'message') ? 'feedback' AS has_feedback,
                payload -> 'message' -> 'feedback' = 'null'::jsonb
                  AS feedback_is_null
              FROM run_events
              WHERE run_id = $1 AND event_type = 'done'
            `,
            [runId],
          ),
        ).resolves.toMatchObject({
          rows: [{ has_feedback: false, feedback_is_null: null }],
        });

        for (const feedback of ["up", "down", null] as const) {
          await expect(
            client.query(
              "UPDATE messages SET feedback = $2 WHERE id = $1",
              [assistantMessageId, feedback],
            ),
          ).resolves.toMatchObject({ rowCount: 1 });
        }

        await expect(
          client.query("UPDATE messages SET feedback = 'up' WHERE id = $1", [
            userMessageId,
          ]),
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          client.query(
            "UPDATE messages SET feedback = 'sideways' WHERE id = $1",
            [assistantMessageId],
          ),
        ).rejects.toMatchObject({ code: "23514" });

        await expect(client.query(assertion013)).resolves.toBeDefined();

        await client.query(migration014);
        await expect(
          client.query<{
            has_feedback: boolean;
            feedback_is_null: boolean;
          }>(
            `
              SELECT
                (payload -> 'message') ? 'feedback' AS has_feedback,
                payload -> 'message' -> 'feedback' = 'null'::jsonb
                  AS feedback_is_null
              FROM run_events
              WHERE run_id = $1 AND event_type = 'done'
            `,
            [runId],
          ),
        ).resolves.toMatchObject({
          rows: [{ has_feedback: true, feedback_is_null: true }],
        });
        await expect(client.query(assertion014)).resolves.toBeDefined();
        },
      );
    });
  },
);
