import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration021Filename = "021_library_indexes.sql";

type MigrationContext = {
  assertion021: string;
  client: PoolClient;
  migration021: string;
};

async function withSchemaBefore021(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_021_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const earlierMigrations = (await readdir(migrationsDirectory))
      .filter(
        (filename) =>
          /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
          filename < migration021Filename,
      )
      .sort();
    for (const filename of earlierMigrations) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      assertion021: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/021_library_indexes.sql",
        ),
        "utf8",
      ),
      client,
      migration021: await readFile(
        path.join(migrationsDirectory, migration021Filename),
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

describe.runIf(databaseUrl !== undefined)("021 Library indexes migration", () => {
  it("installs exact Library keyset indexes and passes its repeatable assertion", async () => {
    await withSchemaBefore021(
      async ({ assertion021, client, migration021 }) => {
        await client.query(migration021);

        const indexes = await client.query<{ indexname: string }>(
          `
            SELECT indexname
            FROM pg_indexes
            WHERE
              schemaname = current_schema()
              AND indexname IN (
                'research_snapshots_user_library_created_idx',
                'artifacts_user_library_created_idx'
              )
            ORDER BY indexname
          `,
        );
        expect(indexes.rows.map((row) => row.indexname)).toEqual([
          "artifacts_user_library_created_idx",
          "research_snapshots_user_library_created_idx",
        ]);

        await expect(client.query(assertion021)).resolves.toBeDefined();
        await expect(client.query(assertion021)).resolves.toBeDefined();
      },
    );
  });
});
