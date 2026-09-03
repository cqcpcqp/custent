import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { Pool } from "pg";

const environmentFile = path.resolve(process.cwd(), ".env");
if (existsSync(environmentFile)) {
  loadEnvFile(environmentFile);
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migrationFilePattern = /^\d{3}_[a-z0-9_]+\.sql$/u;
const advisoryLockId = 2_024_082_401;
const database = new Pool({ connectionString: databaseUrl, max: 1 });
const client = await database.connect();

try {
  await client.query("SELECT pg_advisory_lock($1)", [advisoryLockId]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => migrationFilePattern.test(filename))
    .sort();

  for (const filename of filenames) {
    const sql = await readFile(path.join(migrationsDirectory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await client.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE filename = $1",
      [filename],
    );

    if (applied.rowCount === 1) {
      if (applied.rows[0].checksum !== checksum) {
        throw new Error(`Applied migration ${filename} has a different checksum`);
      }
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [filename, checksum],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [advisoryLockId]);
  client.release();
  await database.end();
}
