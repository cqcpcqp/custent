import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import type { RunEventPayload } from "@/lib/contracts";
import { appendRunEvent } from "@/lib/runs";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration026Filename = "026_code_interpreter_run_events.sql";

const codeInterpreterEvents = [
  {
    type: "code_interpreter_status",
    callId: "python-1",
    phase: "in_progress",
    outputIndex: 2,
    providerSequence: 20,
  },
  {
    type: "code_interpreter_code",
    callId: "python-1",
    update: "done",
    code: "print(6)",
    outputIndex: 2,
    providerSequence: 21,
  },
  {
    type: "code_interpreter_result",
    callId: "python-1",
    phase: "completed",
    outputIndex: 2,
    providerSequence: 22,
    containerId: "container-1",
    code: "print(6)",
    outputs: [{ type: "logs", logs: "6" }],
  },
] satisfies RunEventPayload[];

describe.runIf(databaseUrl !== undefined)(
  "026 Code Interpreter run events migration",
  () => {
    it("unblocks exact Code Interpreter events and replays them through the durable repository", async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("TEST_DATABASE_URL is required");
      }

      const administration = new Pool({ connectionString: databaseUrl, max: 1 });
      const schemaName = `migration_026_${randomUUID().replaceAll("-", "")}`;
      await administration.query(`CREATE SCHEMA ${schemaName}`);
      const database = new Pool({
        connectionString: databaseUrl,
        max: 1,
        options: `-c search_path=${schemaName},public`,
      });

      try {
        const earlierMigrations = (await readdir(migrationsDirectory))
          .filter(
            (filename) =>
              /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
              filename < migration026Filename,
          )
          .sort();
        for (const filename of earlierMigrations) {
          await database.query(
            await readFile(path.join(migrationsDirectory, filename), "utf8"),
          );
        }

        const userId = randomUUID();
        await database.query(
          `
            INSERT INTO users (id, name, available_credits)
            VALUES ($1, '026 migration integration user', 1000)
          `,
          [userId],
        );
        const conversationId = randomUUID();
        const runId = randomUUID();
        const inputMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        const leaseOwner = randomUUID();
        await database.query("BEGIN");
        await database.query(
          `
            INSERT INTO conversations (id, user_id, title)
            VALUES ($1, $2, 'Run Python')
          `,
          [conversationId, userId],
        );
        await database.query(
          `
            INSERT INTO messages (id, conversation_id, role, content)
            VALUES
              ($1, $3, 'user', 'Run Python'),
              ($2, $3, 'assistant', '')
          `,
          [inputMessageId, assistantMessageId, conversationId],
        );
        await database.query(
          `
            INSERT INTO runs (
              id,
              request_id,
              user_id,
              conversation_id,
              input_message_id,
              assistant_message_id,
              status,
              reservation_credits,
              started_at,
              lease_owner,
              lease_token,
              lease_expires_at,
              heartbeat_at,
              attempt_count,
              conversation_turn,
              attempt_index
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, 'running', 100, now(), $7, 1,
              now() + interval '5 minutes', now(), 1, 1, 1
            )
          `,
          [
            runId,
            randomUUID(),
            userId,
            conversationId,
            inputMessageId,
            assistantMessageId,
            leaseOwner,
          ],
        );
        await database.query(
          "UPDATE messages SET run_id = $1 WHERE id = ANY($2::uuid[])",
          [runId, [inputMessageId, assistantMessageId]],
        );
        await database.query(
          "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
          [conversationId, runId],
        );
        await database.query("COMMIT");
        const lease = {
          runId,
          leaseOwner,
          leaseToken: "1",
        };

        await expect(
          appendRunEvent(lease, codeInterpreterEvents[0], database),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "run_events_event_type_check",
        });

        await database.query(
          await readFile(
            path.join(migrationsDirectory, migration026Filename),
            "utf8",
          ),
        );
        const assertion026 = await readFile(
          path.resolve(
            process.cwd(),
            "db/assertions/026_code_interpreter_run_events.sql",
          ),
          "utf8",
        );
        await expect(database.query(assertion026)).resolves.toBeDefined();
        await expect(database.query(assertion026)).resolves.toBeDefined();

        for (const payload of codeInterpreterEvents) {
          await appendRunEvent(lease, payload, database);
        }

        const replay = await database.query<{ payload: unknown }>(
          `
            SELECT payload
            FROM run_events
            WHERE run_id = $1
            ORDER BY id
          `,
          [runId],
        );
        expect(replay.rows.map((event) => event.payload)).toEqual(
          codeInterpreterEvents,
        );

        await expect(
          database.query(
            `
              INSERT INTO run_events (run_id, event_type, payload)
              VALUES ($1, 'code_interpreter_unknown', $2::jsonb)
            `,
            [
              runId,
              JSON.stringify({ type: "code_interpreter_unknown" }),
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint: "run_events_event_type_check",
        });
      } finally {
        await database.end();
        await administration.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await administration.end();
      }
    });
  },
);
