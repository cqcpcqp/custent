import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;

type MigrationContext = {
  client: PoolClient;
  migration012: string;
  assertion012: string;
};

async function withInitialSchema(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_012_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await client.query(
      await readFile(
        path.resolve(process.cwd(), "db/migrations/001_initial.sql"),
        "utf8",
      ),
    );

    await test({
      client,
      migration012: await readFile(
        path.resolve(
          process.cwd(),
          "db/migrations/012_generic_artifacts.sql",
        ),
        "utf8",
      ),
      assertion012: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/012_generic_artifacts.sql",
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

describe.runIf(databaseUrl !== undefined)("generic artifact migration", () => {
  it("allows a generic artifact while retaining the snapshot foreign key", async () => {
    await withInitialSchema(async ({ client, migration012, assertion012 }) => {
      await client.query(migration012);

      const userId = randomUUID();
      const conversationId = randomUUID();
      const runId = randomUUID();
      await client.query(
        "INSERT INTO users (id, name, available_credits) VALUES ($1, 'Migration user', 100)",
        [userId],
      );
      await client.query(
        "INSERT INTO conversations (id, user_id, title) VALUES ($1, $2, 'Generic files')",
        [conversationId, userId],
      );
      await client.query(
        `
          INSERT INTO runs (
            id,
            request_id,
            user_id,
            conversation_id,
            status,
            reservation_credits
          )
          VALUES ($1, $2, $3, $4, 'running', 1)
        `,
        [runId, randomUUID(), userId, conversationId],
      );
      await client.query(
        `
          INSERT INTO artifacts (
            id,
            user_id,
            conversation_id,
            message_id,
            run_id,
            research_snapshot_id,
            name,
            mime_type,
            size_bytes,
            sha256,
            storage_path
          )
          VALUES ($1, $2, $3, NULL, $4, NULL, 'table.csv', 'text/csv', 1, $5, $6)
        `,
        [
          randomUUID(),
          userId,
          conversationId,
          runId,
          "0".repeat(64),
          `migration-012-${randomUUID()}.csv`,
        ],
      );

      await expect(
        client.query(
          `
            INSERT INTO artifacts (
              id,
              user_id,
              conversation_id,
              message_id,
              run_id,
              research_snapshot_id,
              name,
              mime_type,
              size_bytes,
              sha256,
              storage_path
            )
            VALUES ($1, $2, $3, NULL, $4, $5, 'bad.csv', 'text/csv', 1, $6, $7)
          `,
          [
            randomUUID(),
            userId,
            conversationId,
            runId,
            randomUUID(),
            "1".repeat(64),
            `migration-012-invalid-${randomUUID()}.csv`,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await expect(client.query(assertion012)).resolves.toBeDefined();
    });
  });
});
