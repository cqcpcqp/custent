import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration018Filename = "018_tracked_conversation_indexes.sql";

type MigrationContext = {
  assertion018: string;
  client: PoolClient;
  migration018: string;
};

async function withSchemaBefore018(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_018_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const earlierMigrations = (await readdir(migrationsDirectory))
      .filter(
        (filename) =>
          /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
          filename < migration018Filename,
      )
      .sort();
    for (const filename of earlierMigrations) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      assertion018: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/018_tracked_conversation_indexes.sql",
        ),
        "utf8",
      ),
      client,
      migration018: await readFile(
        path.join(migrationsDirectory, migration018Filename),
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

describe.runIf(databaseUrl !== undefined)(
  "018 tracked conversation indexes migration",
  () => {
    it("installs the exact candidate-discovery indexes and passes its repeatable assertion", async () => {
      await withSchemaBefore018(
        async ({ assertion018, client, migration018 }) => {
          await client.query(migration018);

          const indexes = await client.query<{
            indexname: string;
          }>(
            `
              SELECT indexname
              FROM pg_indexes
              WHERE
                schemaname = current_schema()
                AND indexname IN (
                  'runs_user_pending_conversation_order_idx',
                  'runs_user_terminal_conversation_idx',
                  'run_events_terminal_run_id_id_idx'
                )
              ORDER BY indexname
            `,
          );
          expect(indexes.rows.map((row) => row.indexname)).toEqual([
            "run_events_terminal_run_id_id_idx",
            "runs_user_pending_conversation_order_idx",
            "runs_user_terminal_conversation_idx",
          ]);

          await expect(client.query(assertion018)).resolves.toBeDefined();
          await expect(client.query(assertion018)).resolves.toBeDefined();
        },
      );
    });
  },
);
