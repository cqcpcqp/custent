import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration025Filename = "025_conversation_share_management_index.sql";

type MigrationContext = {
  assertion025: string;
  client: PoolClient;
  migration025: string;
};

async function withSchemaBefore025(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_025_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const earlierMigrations = (await readdir(migrationsDirectory))
      .filter(
        (filename) =>
          /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
          filename < migration025Filename,
      )
      .sort();
    for (const filename of earlierMigrations) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      assertion025: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/025_conversation_share_management_index.sql",
        ),
        "utf8",
      ),
      client,
      migration025: await readFile(
        path.join(migrationsDirectory, migration025Filename),
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
  "025 conversation share management index migration",
  () => {
    it("installs the exact keyset index and passes its repeatable assertion", async () => {
      await withSchemaBefore025(
        async ({ assertion025, client, migration025 }) => {
          await client.query(migration025);

          const indexes = await client.query<{ indexname: string }>(
            `
              SELECT indexname
              FROM pg_indexes
              WHERE
                schemaname = current_schema()
                AND indexname = 'conversation_shares_management_order_idx'
            `,
          );
          expect(indexes.rows.map((row) => row.indexname)).toEqual([
            "conversation_shares_management_order_idx",
          ]);

          await expect(client.query(assertion025)).resolves.toBeDefined();
          await expect(client.query(assertion025)).resolves.toBeDefined();
        },
      );
    });
  },
);
