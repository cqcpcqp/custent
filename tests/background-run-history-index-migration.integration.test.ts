import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration024Filename = "024_background_run_history_index.sql";

type MigrationContext = {
  assertion024: string;
  client: PoolClient;
  migration024: string;
};

async function withSchemaBefore024(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_024_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const earlierMigrations = (await readdir(migrationsDirectory))
      .filter(
        (filename) =>
          /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
          filename < migration024Filename,
      )
      .sort();
    for (const filename of earlierMigrations) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      assertion024: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/024_background_run_history_index.sql",
        ),
        "utf8",
      ),
      client,
      migration024: await readFile(
        path.join(migrationsDirectory, migration024Filename),
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
  "024 background Run history index migration",
  () => {
    it("installs the terminal finishedAt keyset index and passes its repeatable assertion", async () => {
      await withSchemaBefore024(
        async ({ assertion024, client, migration024 }) => {
          await client.query(migration024);

          const indexes = await client.query<{ indexname: string }>(
            `
              SELECT indexname
              FROM pg_indexes
              WHERE
                schemaname = current_schema()
                AND indexname = 'runs_user_terminal_finished_idx'
            `,
          );
          expect(indexes.rows.map((row) => row.indexname)).toEqual([
            "runs_user_terminal_finished_idx",
          ]);

          await expect(client.query(assertion024)).resolves.toBeDefined();
          await expect(client.query(assertion024)).resolves.toBeDefined();
        },
      );
    });
  },
);
