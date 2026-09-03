import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migrationFilenamesBefore015 = [
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
] as const;

type MigrationContext = {
  client: PoolClient;
  migration015: string;
  assertion015: string;
};

async function withSchemaBefore015(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_015_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);

    for (const filename of migrationFilenamesBefore015) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      client,
      migration015: await readFile(
        path.join(migrationsDirectory, "015_run_regeneration_snapshots.sql"),
        "utf8",
      ),
      assertion015: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/015_run_regeneration_snapshots.sql",
        ),
        "utf8",
      ),
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release();
    await database.end();
  }
}

type HistoricalFixture = {
  userId: string;
  conversationId: string;
  firstRunId: string;
  secondRunId: string;
  firstInputMessageId: string;
  secondInputMessageId: string;
  wrongInputMessageId: string;
  sessionItemIds: [string, string];
};

async function insertHistoricalFixture(
  client: PoolClient,
): Promise<HistoricalFixture> {
  const fixture: HistoricalFixture = {
    userId: randomUUID(),
    conversationId: randomUUID(),
    firstRunId: randomUUID(),
    secondRunId: randomUUID(),
    firstInputMessageId: randomUUID(),
    secondInputMessageId: randomUUID(),
    wrongInputMessageId: randomUUID(),
    sessionItemIds: [randomUUID(), randomUUID()],
  };
  const firstAssistantMessageId = randomUUID();
  const secondAssistantMessageId = randomUUID();

  await client.query("BEGIN");
  await client.query(
    "INSERT INTO users (id, name, available_credits) VALUES ($1, '015 migration user', 1000)",
    [fixture.userId],
  );
  await client.query(
    `
      INSERT INTO conversations (id, user_id, title)
      VALUES ($1, $2, 'historical regeneration boundary')
    `,
    [fixture.conversationId, fixture.userId],
  );
  await client.query(
    `
      INSERT INTO messages (id, conversation_id, role, content, citations, created_at)
      VALUES
        ($1, $4, 'user', 'first input', '[]', '2026-08-25T00:00:01.000Z'),
        ($2, $4, 'assistant', 'first answer', '[]', '2026-08-25T00:00:02.000Z'),
        ($3, $4, 'user', 'second input', '[]', '2026-08-25T00:01:01.000Z'),
        ($5, $4, 'assistant', 'second answer', '[]', '2026-08-25T00:01:02.000Z'),
        ($6, $4, 'user', 'wrong regeneration input', '[]', '2026-08-25T00:02:00.000Z')
    `,
    [
      fixture.firstInputMessageId,
      firstAssistantMessageId,
      fixture.secondInputMessageId,
      fixture.conversationId,
      secondAssistantMessageId,
      fixture.wrongInputMessageId,
    ],
  );
  await client.query(
    `
      INSERT INTO runs (
        id,
        request_id,
        user_id,
        conversation_id,
        status,
        reservation_credits,
        charged_credits,
        input_tokens,
        output_tokens,
        web_searches,
        input_message_id,
        assistant_message_id,
        created_at,
        completed_at,
        finished_at,
        updated_at,
        conversation_turn,
        attempt_index,
        predecessor_run_id
      )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'completed',
          20,
          1,
          1,
          1,
          0,
          $5,
          $6,
          '2026-08-25T00:00:00.000Z',
          '2026-08-25T00:00:03.000Z',
          '2026-08-25T00:00:03.000Z',
          '2026-08-25T00:00:03.000Z',
          1,
          1,
          NULL
        ),
        (
          $7,
          $8,
          $3,
          $4,
          'completed',
          20,
          1,
          1,
          1,
          0,
          $9,
          $10,
          '2026-08-25T00:01:00.000Z',
          '2026-08-25T00:01:03.000Z',
          '2026-08-25T00:01:03.000Z',
          '2026-08-25T00:01:03.000Z',
          2,
          1,
          $1
        )
    `,
    [
      fixture.firstRunId,
      randomUUID(),
      fixture.userId,
      fixture.conversationId,
      fixture.firstInputMessageId,
      firstAssistantMessageId,
      fixture.secondRunId,
      randomUUID(),
      fixture.secondInputMessageId,
      secondAssistantMessageId,
    ],
  );
  await client.query(
    `
      UPDATE messages
      SET run_id = CASE
        WHEN id = ANY($2::uuid[]) THEN $1::uuid
        WHEN id = ANY($4::uuid[]) THEN $3::uuid
      END
      WHERE id = ANY($5::uuid[])
    `,
    [
      fixture.firstRunId,
      [fixture.firstInputMessageId, firstAssistantMessageId],
      fixture.secondRunId,
      [fixture.secondInputMessageId, secondAssistantMessageId],
      [
        fixture.firstInputMessageId,
        firstAssistantMessageId,
        fixture.secondInputMessageId,
        secondAssistantMessageId,
      ],
    ],
  );
  await client.query(
    `
      INSERT INTO agent_session_items (
        id,
        conversation_id,
        position,
        item,
        created_at
      )
      VALUES
        (
          $1,
          $3,
          1,
          '{"role":"user","content":"preserved one"}',
          '2026-08-25T00:02:01.000Z'
        ),
        (
          $2,
          $3,
          2,
          '{"role":"assistant","content":"preserved two"}',
          '2026-08-25T00:02:02.000Z'
        )
    `,
    [
      fixture.sessionItemIds[0],
      fixture.sessionItemIds[1],
      fixture.conversationId,
    ],
  );
  await client.query("COMMIT");

  return fixture;
}

async function insertFailedSource(
  client: PoolClient,
  input: { userId: string },
): Promise<{
  conversationId: string;
  inputMessageId: string;
  runId: string;
}> {
  const conversationId = randomUUID();
  const inputMessageId = randomUUID();
  const runId = randomUUID();

  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO conversations (id, user_id, title)
      VALUES ($1, $2, 'failed regeneration source')
    `,
    [conversationId, input.userId],
  );
  await client.query(
    `
      INSERT INTO messages (id, conversation_id, role, content, citations)
      VALUES ($1, $2, 'user', 'failed source input', '[]')
    `,
    [inputMessageId, conversationId],
  );
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
        failure_code,
        failure_message,
        finished_at,
        conversation_turn,
        attempt_index
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'failed',
        20,
        $5,
        $6,
        'PROVIDER_ERROR',
        'provider failed',
        now(),
        1,
        1
      )
    `,
    [
      runId,
      randomUUID(),
      input.userId,
      conversationId,
      inputMessageId,
      randomUUID(),
    ],
  );
  await client.query("UPDATE messages SET run_id = $2 WHERE id = $1", [
    inputMessageId,
    runId,
  ]);
  await client.query("COMMIT");

  return { conversationId, inputMessageId, runId };
}

describe.runIf(databaseUrl !== undefined)(
  "015 Run regeneration and session snapshot migration",
  () => {
    it(
      "backfills only provable history and enforces regeneration and immutable snapshot boundaries",
      async () => {
        await withSchemaBefore015(
          async ({ client, migration015, assertion015 }) => {
            const fixture = await insertHistoricalFixture(client);
            const sessionItemsBefore = await client.query<{
              id: string;
              position: string;
              item: unknown;
              created_at: Date;
            }>(
              `
                SELECT id, position, item, created_at
                FROM agent_session_items
                WHERE conversation_id = $1
                ORDER BY position
              `,
              [fixture.conversationId],
            );

            await client.query(migration015);

            await expect(
              client.query<{
                column_name: string;
                data_type: string;
              }>(
                `
                  SELECT column_name, data_type
                  FROM information_schema.columns
                  WHERE
                    table_schema = current_schema()
                    AND (
                      (table_name = 'runs' AND column_name = 'regenerate_of_run_id')
                      OR (
                        table_name = 'run_session_snapshots'
                        AND column_name = 'item_count'
                      )
                      OR (
                        table_name = 'run_session_snapshot_items'
                        AND column_name = 'position'
                      )
                    )
                  ORDER BY column_name
                `,
              ),
            ).resolves.toMatchObject({
              rows: [
                { column_name: "item_count", data_type: "integer" },
                { column_name: "position", data_type: "integer" },
                { column_name: "regenerate_of_run_id", data_type: "uuid" },
              ],
            });

            await expect(
              client.query<{
                run_id: string;
                phase: string;
                item_count: number;
              }>(
                `
                  SELECT run_id, phase, item_count
                  FROM run_session_snapshots
                  WHERE run_id = ANY($1::uuid[])
                  ORDER BY run_id, phase
                `,
                [[fixture.firstRunId, fixture.secondRunId]],
              ),
            ).resolves.toMatchObject({
              rows: [
                {
                  run_id: fixture.firstRunId,
                  phase: "pre",
                  item_count: 0,
                },
              ],
            });
            await expect(
              client.query(
                `
                  SELECT 1
                  FROM run_session_snapshot_items
                  WHERE run_id = ANY($1::uuid[])
                `,
                [[fixture.firstRunId, fixture.secondRunId]],
              ),
            ).resolves.toMatchObject({ rowCount: 0 });

            const sessionItemsAfter = await client.query<{
              id: string;
              position: string;
              item: unknown;
              created_at: Date;
            }>(
              `
                SELECT id, position, item, created_at
                FROM agent_session_items
                WHERE conversation_id = $1
                ORDER BY position
              `,
              [fixture.conversationId],
            );
            expect(sessionItemsAfter.rows).toEqual(sessionItemsBefore.rows);

            const failedSource = await insertFailedSource(client, {
              userId: fixture.userId,
            });

            await expect(
              client.query(
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
                    conversation_turn,
                    attempt_index,
                    regenerate_of_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 1, 2, $7)
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  failedSource.conversationId,
                  failedSource.inputMessageId,
                  randomUUID(),
                  failedSource.runId,
                ],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "only a completed Run can be regenerated",
              ),
            });

            await expect(
              client.query(
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
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    retry_of_run_id,
                    regenerate_of_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 2, 2, $7, $8, $8)
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.conversationId,
                  fixture.secondInputMessageId,
                  randomUUID(),
                  fixture.firstRunId,
                  fixture.secondRunId,
                ],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              constraint: "runs_attempt_source_shape_check",
            });

            await expect(
              client.query(
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
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 2, 2, $7, $8)
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.conversationId,
                  fixture.wrongInputMessageId,
                  randomUUID(),
                  fixture.firstRunId,
                  fixture.secondRunId,
                ],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "regenerate Run must reuse its source input message",
              ),
            });

            await expect(
              client.query(
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
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 2, 2, NULL, $7)
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.conversationId,
                  fixture.secondInputMessageId,
                  randomUUID(),
                  fixture.secondRunId,
                ],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "conversation turn 2 requires a predecessor",
              ),
            });

            await expect(
              client.query(
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
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 2, 3, $7, $8)
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.conversationId,
                  fixture.secondInputMessageId,
                  randomUUID(),
                  fixture.firstRunId,
                  fixture.secondRunId,
                ],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "regenerate attempt must immediately follow its source attempt",
              ),
            });

            await expect(
              client.query(
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
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 1, 2, NULL, $7)
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.conversationId,
                  fixture.firstInputMessageId,
                  randomUUID(),
                  fixture.firstRunId,
                ],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "Run cannot be regenerated after a successor has been created",
              ),
            });

            const regenerateRunId = randomUUID();
            await expect(
              client.query(
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
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 2, 2, $7, $8)
                `,
                [
                  regenerateRunId,
                  randomUUID(),
                  fixture.userId,
                  fixture.conversationId,
                  fixture.secondInputMessageId,
                  randomUUID(),
                  fixture.firstRunId,
                  fixture.secondRunId,
                ],
              ),
            ).resolves.toMatchObject({ rowCount: 1 });
            await expect(
              client.query<{
                attempt_index: number;
                predecessor_run_id: string;
                regenerate_of_run_id: string;
                retry_of_run_id: string | null;
                status: string;
              }>(
                `
                  SELECT
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id,
                    retry_of_run_id,
                    status
                  FROM runs
                  WHERE id = $1
                `,
                [regenerateRunId],
              ),
            ).resolves.toMatchObject({
              rows: [
                {
                  attempt_index: 2,
                  predecessor_run_id: fixture.firstRunId,
                  regenerate_of_run_id: fixture.secondRunId,
                  retry_of_run_id: null,
                  status: "queued",
                },
              ],
            });

            await client.query("BEGIN");
            await client.query(
              `
                INSERT INTO run_session_snapshots (run_id, phase, item_count)
                VALUES ($1, 'pre', 2), ($1, 'post', 3)
              `,
              [fixture.secondRunId],
            );
            await client.query(
              `
                INSERT INTO run_session_snapshot_items (
                  run_id,
                  phase,
                  position,
                  item
                )
                VALUES
                  ($1, 'pre', 1, '{"type":"message","role":"user"}'),
                  ($1, 'pre', 2, '{"type":"message","role":"assistant"}'),
                  ($1, 'post', 1, '{"type":"message","role":"user"}'),
                  ($1, 'post', 2, '{"type":"message","role":"assistant"}'),
                  ($1, 'post', 3, '{"type":"message","role":"assistant","current":true}')
              `,
              [fixture.secondRunId],
            );
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            await client.query("COMMIT");

            await expect(
              client.query<{
                phase: string;
                item_count: number;
              }>(
                `
                  SELECT phase, item_count
                  FROM run_session_snapshots
                  WHERE run_id = $1
                  ORDER BY phase
                `,
                [fixture.secondRunId],
              ),
            ).resolves.toMatchObject({
              rows: [
                { phase: "post", item_count: 3 },
                { phase: "pre", item_count: 2 },
              ],
            });
            await expect(
              client.query<{
                phase: string;
                position: number;
              }>(
                `
                  SELECT phase, position
                  FROM run_session_snapshot_items
                  WHERE run_id = $1
                  ORDER BY phase, position
                `,
                [fixture.secondRunId],
              ),
            ).resolves.toMatchObject({
              rows: [
                { phase: "post", position: 1 },
                { phase: "post", position: 2 },
                { phase: "post", position: 3 },
                { phase: "pre", position: 1 },
                { phase: "pre", position: 2 },
              ],
            });

            await client.query("BEGIN");
            await client.query(
              `
                INSERT INTO run_session_snapshots (run_id, phase, item_count)
                VALUES ($1, 'pre', 2)
              `,
              [failedSource.runId],
            );
            await client.query(
              `
                INSERT INTO run_session_snapshot_items (
                  run_id,
                  phase,
                  position,
                  item
                )
                VALUES
                  ($1, 'pre', 1, '{"type":"message"}'),
                  ($1, 'pre', 3, '{"type":"message"}')
              `,
              [failedSource.runId],
            );
            await expect(
              client.query("SET CONSTRAINTS ALL IMMEDIATE"),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "session snapshot item positions/count are inconsistent",
              ),
            });
            await client.query("ROLLBACK");

            await expect(
              client.query(
                `
                  INSERT INTO run_session_snapshots (run_id, phase, item_count)
                  VALUES ($1, 'post', 0)
                `,
                [regenerateRunId],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "post session snapshot requires a completed Run",
              ),
            });

            const immutableMutations = [
              () =>
                client.query(
                `
                  UPDATE run_session_snapshots
                  SET item_count = item_count
                  WHERE run_id = $1 AND phase = 'pre'
                `,
                [fixture.secondRunId],
                ),
              () =>
                client.query(
                `
                  DELETE FROM run_session_snapshots
                  WHERE run_id = $1 AND phase = 'post'
                `,
                [fixture.secondRunId],
                ),
              () =>
                client.query(
                `
                  UPDATE run_session_snapshot_items
                  SET item = item
                  WHERE run_id = $1 AND phase = 'pre' AND position = 1
                `,
                [fixture.secondRunId],
                ),
              () =>
                client.query(
                `
                  DELETE FROM run_session_snapshot_items
                  WHERE run_id = $1 AND phase = 'post' AND position = 1
                `,
                [fixture.secondRunId],
                ),
            ];
            for (const mutate of immutableMutations) {
              await expect(mutate()).rejects.toMatchObject({
                code: "23514",
                message: "Run session snapshots are immutable",
              });
            }

            await client.query(
              `
                INSERT INTO run_session_snapshots (run_id, phase, item_count)
                VALUES ($1, 'post', 0)
              `,
              [fixture.firstRunId],
            );

            await expect(
              client.query(
                `
                  UPDATE runs
                  SET
                    status = 'failed',
                    charged_credits = NULL,
                    input_tokens = NULL,
                    output_tokens = NULL,
                    web_searches = NULL,
                    completed_at = NULL,
                    failure_code = 'PROVIDER_ERROR',
                    failure_message = 'cannot rewrite completed snapshot history',
                    finished_at = now()
                  WHERE id = $1
                `,
                [fixture.firstRunId],
              ),
            ).rejects.toMatchObject({
              code: "23514",
              message: expect.stringContaining(
                "post session snapshot requires a completed Run",
              ),
            });

            await client.query("BEGIN");
            await client.query(
              `
                INSERT INTO run_session_snapshots (run_id, phase, item_count)
                VALUES ($1, 'pre', 1)
              `,
              [failedSource.runId],
            );
            await client.query(
              `
                INSERT INTO run_session_snapshot_items (
                  run_id,
                  phase,
                  position,
                  item
                )
                VALUES ($1, 'pre', 1, '{"type":"message"}')
              `,
              [failedSource.runId],
            );
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            await client.query("COMMIT");
            await expect(
              client.query("DELETE FROM runs WHERE id = $1", [
                failedSource.runId,
              ]),
            ).resolves.toMatchObject({ rowCount: 1 });
            await expect(
              client.query(
                "SELECT 1 FROM run_session_snapshots WHERE run_id = $1",
                [failedSource.runId],
              ),
            ).resolves.toMatchObject({ rowCount: 0 });
            await expect(
              client.query(
                "SELECT 1 FROM run_session_snapshot_items WHERE run_id = $1",
                [failedSource.runId],
              ),
            ).resolves.toMatchObject({ rowCount: 0 });

            await expect(client.query(assertion015)).resolves.toBeDefined();

            const sessionItemsAfterAssertion = await client.query<{
              id: string;
              position: string;
              item: unknown;
              created_at: Date;
            }>(
              `
                SELECT id, position, item, created_at
                FROM agent_session_items
                WHERE conversation_id = $1
                ORDER BY position
              `,
              [fixture.conversationId],
            );
            expect(sessionItemsAfterAssertion.rows).toEqual(
              sessionItemsBefore.rows,
            );
          },
        );
      },
      30_000,
    );
  },
);
