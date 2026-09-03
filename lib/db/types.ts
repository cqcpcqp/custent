import type { Pool, PoolClient } from "pg";

export type Queryable = Pool | PoolClient;

export function isPoolClient(database: Queryable): database is PoolClient {
  return "release" in database && typeof database.release === "function";
}

export function toIsoString(value: Date): string {
  return value.toISOString();
}
