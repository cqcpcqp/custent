import { isDeepStrictEqual } from "node:util";

import { protocol, type AgentInputItem } from "@openai/agents";
import type { Pool, PoolClient } from "pg";

import { getPool, withTransaction } from "@/lib/db/pool";
import { isPoolClient, type Queryable } from "@/lib/db/types";

export type RunSessionSnapshotPhase = "pre" | "post";

export type RunSessionSnapshot = {
  runId: string;
  phase: RunSessionSnapshotPhase;
  items: AgentInputItem[];
  createdAt: string;
};

type SnapshotRow = {
  run_id: string;
  phase: string;
  item_count: number;
  created_at: Date;
  position: number | null;
  item: unknown | null;
  item_created_at: Date | null;
};

type InsertedSnapshotRow = {
  run_id: string;
};

const SELECT_SNAPSHOT_SQL = `
  SELECT
    snapshot.run_id,
    snapshot.phase,
    snapshot.item_count,
    snapshot.created_at,
    snapshot_item.position,
    snapshot_item.item,
    snapshot_item.created_at AS item_created_at
  FROM run_session_snapshots snapshot
  LEFT JOIN run_session_snapshot_items snapshot_item
    ON snapshot_item.run_id = snapshot.run_id
    AND snapshot_item.phase = snapshot.phase
  WHERE snapshot.run_id = $1 AND snapshot.phase = $2
  ORDER BY snapshot_item.position
`;

export class RunSessionSnapshotIntegrityError extends Error {
  constructor(
    readonly runId: string,
    readonly phase: RunSessionSnapshotPhase,
    detail: string,
  ) {
    super(`Run session snapshot ${runId}/${phase} is inconsistent: ${detail}`);
    this.name = "RunSessionSnapshotIntegrityError";
  }
}

export class RunSessionSnapshotConflictError extends Error {
  constructor(
    readonly runId: string,
    readonly phase: RunSessionSnapshotPhase,
  ) {
    super(
      `Run session snapshot ${runId}/${phase} already exists with different items`,
    );
    this.name = "RunSessionSnapshotConflictError";
  }
}

function assertRunId(runId: string): void {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("runId must not be empty");
  }
}

function assertPhase(
  phase: RunSessionSnapshotPhase,
): asserts phase is RunSessionSnapshotPhase {
  if (phase !== "pre" && phase !== "post") {
    throw new TypeError('phase must be either "pre" or "post"');
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

function parseAgentInputItem(
  value: unknown,
  invalid: (detail: string) => Error,
): AgentInputItem {
  const parsed = protocol.ModelItem.safeParse(value);
  if (!parsed.success) {
    throw invalid("is not a valid AgentInputItem");
  }
  if (!isDeepStrictEqual(parsed.data, value)) {
    throw invalid("contains fields outside the AgentInputItem contract");
  }
  return parsed.data;
}

function serializeItems(items: readonly AgentInputItem[]): {
  items: AgentInputItem[];
  serialized: string;
} {
  if (!Array.isArray(items)) {
    throw new TypeError("items must be an array");
  }

  let serialized: string;
  let jsonItems: unknown;
  try {
    serialized = JSON.stringify(items);
    jsonItems = JSON.parse(serialized) as unknown;
  } catch {
    throw new TypeError("items must contain JSON-serializable values");
  }

  if (!Array.isArray(jsonItems) || !isDeepStrictEqual(jsonItems, items)) {
    throw new TypeError("items must contain losslessly JSON-serializable values");
  }

  const validated = jsonItems.map((item, index) =>
    parseAgentInputItem(
      item,
      (detail) =>
        new TypeError(`items[${index}] ${detail}`),
    ),
  );
  return {
    items: structuredClone(validated),
    serialized,
  };
}

function integrityError(
  runId: string,
  phase: RunSessionSnapshotPhase,
  detail: string,
): RunSessionSnapshotIntegrityError {
  return new RunSessionSnapshotIntegrityError(runId, phase, detail);
}

function materializeSnapshot(
  runId: string,
  phase: RunSessionSnapshotPhase,
  rows: SnapshotRow[],
): RunSessionSnapshot | null {
  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];
  if (first.run_id !== runId || first.phase !== phase) {
    throw integrityError(runId, phase, "identity does not match the query");
  }
  if (!Number.isSafeInteger(first.item_count) || first.item_count < 0) {
    throw integrityError(runId, phase, "item_count is not a safe non-negative integer");
  }
  if (!validDate(first.created_at)) {
    throw integrityError(runId, phase, "created_at is invalid");
  }

  for (const row of rows) {
    if (
      row.run_id !== first.run_id ||
      row.phase !== first.phase ||
      row.item_count !== first.item_count ||
      !validDate(row.created_at) ||
      row.created_at.valueOf() !== first.created_at.valueOf()
    ) {
      throw integrityError(runId, phase, "metadata differs between item rows");
    }
  }

  if (first.item_count === 0) {
    if (
      rows.length !== 1 ||
      first.position !== null ||
      first.item !== null ||
      first.item_created_at !== null
    ) {
      throw integrityError(runId, phase, "empty snapshot has persisted item rows");
    }
    return {
      runId,
      phase,
      items: [],
      createdAt: first.created_at.toISOString(),
    };
  }

  if (rows.length !== first.item_count) {
    throw integrityError(
      runId,
      phase,
      `item_count is ${first.item_count}, but ${rows.length} item rows were read`,
    );
  }

  const items = rows.map((row, index) => {
    const expectedPosition = index + 1;
    if (row.position !== expectedPosition) {
      throw integrityError(
        runId,
        phase,
        `expected item position ${expectedPosition}, received ${String(row.position)}`,
      );
    }
    if (!validDate(row.item_created_at)) {
      throw integrityError(
        runId,
        phase,
        `item at position ${expectedPosition} has an invalid created_at`,
      );
    }
    return parseAgentInputItem(row.item, (detail) =>
      integrityError(
        runId,
        phase,
        `item at position ${expectedPosition} ${detail}`,
      ),
    );
  });

  return {
    runId,
    phase,
    items: structuredClone(items),
    createdAt: first.created_at.toISOString(),
  };
}

export async function readRunSessionSnapshot(
  runId: string,
  phase: RunSessionSnapshotPhase,
  database: Queryable = getPool(),
): Promise<RunSessionSnapshot | null> {
  assertRunId(runId);
  assertPhase(phase);
  const result = await database.query<SnapshotRow>(SELECT_SNAPSHOT_SQL, [
    runId,
    phase,
  ]);
  return materializeSnapshot(runId, phase, result.rows);
}

async function writeRunSessionSnapshotInTransaction(
  runId: string,
  phase: RunSessionSnapshotPhase,
  items: AgentInputItem[],
  serializedItems: string,
  client: PoolClient,
): Promise<RunSessionSnapshot> {
  const inserted = await client.query<InsertedSnapshotRow>(
    `
      INSERT INTO run_session_snapshots (run_id, phase, item_count)
      VALUES ($1, $2, $3)
      ON CONFLICT (run_id, phase) DO NOTHING
      RETURNING run_id
    `,
    [runId, phase, items.length],
  );
  if (inserted.rows.length > 1) {
    throw integrityError(runId, phase, "snapshot insert returned multiple rows");
  }

  if (inserted.rows.length === 1 && items.length > 0) {
    await client.query(
      `
        INSERT INTO run_session_snapshot_items (
          run_id,
          phase,
          position,
          item
        )
        SELECT
          $1,
          $2,
          serialized.ordinality,
          serialized.item
        FROM jsonb_array_elements($3::jsonb)
          WITH ORDINALITY AS serialized(item, ordinality)
      `,
      [runId, phase, serializedItems],
    );
  }

  const snapshot = await readRunSessionSnapshot(runId, phase, client);
  if (snapshot === null) {
    throw integrityError(runId, phase, "snapshot disappeared after insert");
  }
  if (!isDeepStrictEqual(snapshot.items, items)) {
    if (inserted.rows.length === 0) {
      throw new RunSessionSnapshotConflictError(runId, phase);
    }
    throw integrityError(runId, phase, "persisted items differ from inserted items");
  }
  return snapshot;
}

export async function writeRunSessionSnapshot(
  runId: string,
  phase: RunSessionSnapshotPhase,
  items: readonly AgentInputItem[],
  database: Pool | PoolClient = getPool(),
): Promise<RunSessionSnapshot> {
  assertRunId(runId);
  assertPhase(phase);
  const validated = serializeItems(items);

  if (isPoolClient(database)) {
    return writeRunSessionSnapshotInTransaction(
      runId,
      phase,
      validated.items,
      validated.serialized,
      database,
    );
  }
  return withTransaction(
    (client) =>
      writeRunSessionSnapshotInTransaction(
        runId,
        phase,
        validated.items,
        validated.serialized,
        client,
      ),
    database,
  );
}
