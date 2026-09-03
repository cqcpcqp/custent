import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration019Filename = "019_conversation_search_indexes.sql";

type MigrationContext = {
  assertion019: string;
  client: PoolClient;
  migration019: string;
};

async function withSchemaBefore019(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_019_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    const earlierMigrations = (await readdir(migrationsDirectory))
      .filter(
        (filename) =>
          /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
          filename < migration019Filename,
      )
      .sort();
    for (const filename of earlierMigrations) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      assertion019: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/019_conversation_search_indexes.sql",
        ),
        "utf8",
      ),
      client,
      migration019: await readFile(
        path.join(migrationsDirectory, migration019Filename),
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
  "019 conversation search indexes migration",
  () => {
    it("installs exact trigram title and message indexes and passes its repeatable assertion", async () => {
      await withSchemaBefore019(
        async ({ assertion019, client, migration019 }) => {
          await client.query(migration019);

          const indexes = await client.query<{
            indexname: string;
          }>(
            `
              SELECT indexname
              FROM pg_indexes
              WHERE
                schemaname = current_schema()
                AND indexname IN (
                  'conversations_title_search_trgm_idx',
                  'messages_content_search_trgm_idx'
                )
              ORDER BY indexname
            `,
          );
          expect(indexes.rows.map((row) => row.indexname)).toEqual([
            "conversations_title_search_trgm_idx",
            "messages_content_search_trgm_idx",
          ]);

          await expect(client.query(assertion019)).resolves.toBeDefined();
          await expect(client.query(assertion019)).resolves.toBeDefined();
        },
      );
    });
  },
);
