import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration023Filename =
  "023_conversation_context_seed_creation_state.sql";

type MigrationContext = {
  assertion023: string;
  client: PoolClient;
  migration023: string;
};

async function withSchemaBefore023(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_023_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const earlierMigrations = (await readdir(migrationsDirectory))
      .filter(
        (filename) =>
          /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
          filename < migration023Filename,
      )
      .sort();
    for (const filename of earlierMigrations) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      assertion023: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/023_conversation_context_seed_creation_state.sql",
        ),
        "utf8",
      ),
      client,
      migration023: await readFile(
        path.join(migrationsDirectory, migration023Filename),
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

type Fixture = {
  guardedConversationId: string;
  seededConversationId: string;
  sourceAssistantMessageId: string;
  sourceConversationId: string;
  sourceRunId: string;
  userId: string;
};

async function insertFixture(client: PoolClient): Promise<Fixture> {
  const fixture: Fixture = {
    guardedConversationId: randomUUID(),
    seededConversationId: randomUUID(),
    sourceAssistantMessageId: randomUUID(),
    sourceConversationId: randomUUID(),
    sourceRunId: randomUUID(),
    userId: randomUUID(),
  };
  const sourceInputMessageId = randomUUID();

  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO users (id, name, available_credits)
      VALUES ($1, '023 migration user', 1000)
    `,
    [fixture.userId],
  );
  await client.query(
    `
      INSERT INTO conversations (id, user_id, title)
      VALUES
        ($1, $4, '023 completed source'),
        ($2, $4, '023 seeded target'),
        ($3, $4, '023 guarded target')
    `,
    [
      fixture.sourceConversationId,
      fixture.seededConversationId,
      fixture.guardedConversationId,
      fixture.userId,
    ],
  );
  await client.query(
    `
      INSERT INTO messages (
        id,
        conversation_id,
        role,
        content,
        citations
      )
      VALUES ($1, $2, 'user', 'source input', '[]')
    `,
    [sourceInputMessageId, fixture.sourceConversationId],
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
        completed_at,
        finished_at,
        conversation_turn,
        attempt_index
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'completed',
        20,
        3,
        10,
        5,
        1,
        $5,
        $6,
        now(),
        now(),
        1,
        1
      )
    `,
    [
      fixture.sourceRunId,
      randomUUID(),
      fixture.userId,
      fixture.sourceConversationId,
      sourceInputMessageId,
      fixture.sourceAssistantMessageId,
    ],
  );
  await client.query(
    "UPDATE messages SET run_id = $2 WHERE id = $1",
    [sourceInputMessageId, fixture.sourceRunId],
  );
  await client.query(
    `
      INSERT INTO messages (
        id,
        conversation_id,
        run_id,
        role,
        content,
        citations
      )
      VALUES ($1, $2, $3, 'assistant', 'source answer', '[]')
    `,
    [
      fixture.sourceAssistantMessageId,
      fixture.sourceConversationId,
      fixture.sourceRunId,
    ],
  );
  await client.query(
    "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
    [fixture.sourceConversationId, fixture.sourceRunId],
  );
  await client.query(
    `
      INSERT INTO run_session_snapshots (run_id, phase, item_count)
      VALUES ($1, 'post', 2)
    `,
    [fixture.sourceRunId],
  );
  await client.query(
    `
      INSERT INTO run_session_snapshot_items (run_id, phase, position, item)
      VALUES
        ($1, 'post', 1, '{"role":"user","content":"source input"}'),
        (
          $1,
          'post',
          2,
          '{"role":"assistant","status":"completed","content":[{"type":"output_text","text":"source answer"}]}'
        )
    `,
    [fixture.sourceRunId],
  );
  await client.query("COMMIT");

  return fixture;
}

async function insertSeed(
  client: PoolClient,
  fixture: Fixture,
  targetConversationId: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `
        INSERT INTO conversation_context_seeds (
          conversation_id,
          user_id,
          source_conversation_id,
          source_message_id,
          source_run_id,
          item_count
        )
        VALUES ($1, $2, $3, $4, $5, 2)
      `,
      [
        targetConversationId,
        fixture.userId,
        fixture.sourceConversationId,
        fixture.sourceAssistantMessageId,
        fixture.sourceRunId,
      ],
    );
    await client.query(
      `
        INSERT INTO conversation_context_seed_items (
          conversation_id,
          position,
          item
        )
        SELECT $1, position, item
        FROM run_session_snapshot_items
        WHERE run_id = $2 AND phase = 'post'
        ORDER BY position
      `,
      [targetConversationId, fixture.sourceRunId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function insertQueuedRootRun(
  client: PoolClient,
  userId: string,
  conversationId: string,
): Promise<void> {
  const inputMessageId = randomUUID();
  const runId = randomUUID();

  await client.query("BEGIN");
  try {
    await client.query(
      `
        INSERT INTO messages (
          id,
          conversation_id,
          role,
          content,
          citations
        )
        VALUES ($1, $2, 'user', 'continue from seed', '[]')
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
          conversation_turn,
          attempt_index
        )
        VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 1, 1)
      `,
      [
        runId,
        randomUUID(),
        userId,
        conversationId,
        inputMessageId,
        randomUUID(),
      ],
    );
    await client.query(
      "UPDATE messages SET run_id = $2 WHERE id = $1",
      [inputMessageId, runId],
    );
    await client.query(
      "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
      [conversationId, runId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe.runIf(databaseUrl !== undefined)(
  "023 conversation context seed creation-state migration",
  () => {
    it("keeps permanent assertions valid after a root Run while rejecting late seed creation", async () => {
      await withSchemaBefore023(
        async ({ assertion023, client, migration023 }) => {
          await client.query(migration023);
          const fixture = await insertFixture(client);

          await insertSeed(client, fixture, fixture.seededConversationId);
          await insertQueuedRootRun(
            client,
            fixture.userId,
            fixture.seededConversationId,
          );

          await expect(client.query(assertion023)).resolves.toBeDefined();
          await expect(client.query(assertion023)).resolves.toBeDefined();

          await insertQueuedRootRun(
            client,
            fixture.userId,
            fixture.guardedConversationId,
          );
          await expect(
            insertSeed(client, fixture, fixture.guardedConversationId),
          ).rejects.toMatchObject({
            code: "23514",
            message: expect.stringContaining(
              "must be created before the target conversation has Runs",
            ),
          });
          await expect(
            client.query(
              `
                SELECT conversation_id
                FROM conversation_context_seeds
                WHERE conversation_id = $1
              `,
              [fixture.guardedConversationId],
            ),
          ).resolves.toMatchObject({ rowCount: 0 });
        },
      );
    });
  },
);
