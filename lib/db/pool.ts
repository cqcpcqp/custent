import { Pool, type PoolClient } from "pg";

import { getEnv } from "@/lib/env";

let pool: Pool | undefined;

export function getPool(): Pool {
  pool ??= new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  return pool;
}

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  database: Pool = getPool(),
): Promise<T> {
  const client = await database.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function withReadOnlyRepeatableReadTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
  database: Pool = getPool(),
): Promise<T> {
  const client = await database.connect();

  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool === undefined) {
    return;
  }

  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}
