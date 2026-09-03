import type { AgentInputItem } from "@openai/agents";
import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  readRunSessionSnapshot,
  RunSessionSnapshotConflictError,
  RunSessionSnapshotIntegrityError,
  writeRunSessionSnapshot,
} from "./session-snapshots";

const runId = "11111111-1111-4111-8111-111111111111";
const createdAt = new Date("2026-08-26T08:00:00.000Z");
const itemCreatedAt = new Date("2026-08-26T08:00:01.000Z");
const items = [
  { role: "user", content: "Find pump buyers" },
  {
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "I found three candidates." }],
  },
] satisfies AgentInputItem[];

type SnapshotRowFixture = {
  run_id: string;
  phase: string;
  item_count: number;
  created_at: Date;
  position: number | null;
  item: unknown | null;
  item_created_at: Date | null;
};

function queryResult<T extends QueryResultRow>(
  rows: T[],
  command = "SELECT",
): QueryResult<T> {
  return {
    command,
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function snapshotRows(
  snapshotItems: unknown[] = items,
  overrides: Partial<{
    run_id: string;
    phase: string;
    item_count: number;
    created_at: Date;
  }> = {},
): SnapshotRowFixture[] {
  const metadata = {
    run_id: runId,
    phase: "pre",
    item_count: snapshotItems.length,
    created_at: createdAt,
    ...overrides,
  };
  if (snapshotItems.length === 0) {
    return [
      {
        ...metadata,
        position: null,
        item: null,
        item_created_at: null,
      },
    ];
  }
  return snapshotItems.map((item, index) => ({
    ...metadata,
    position: index + 1,
    item,
    item_created_at: itemCreatedAt,
  }));
}

function readDatabase(rows: ReturnType<typeof snapshotRows>) {
  const query = vi.fn(async () => queryResult(rows));
  return { database: { query } as unknown as PoolClient, query };
}

function transactionClient(
  query: PoolClient["query"],
): PoolClient {
  return {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
}

describe("readRunSessionSnapshot", () => {
  it("distinguishes a missing snapshot from a valid empty snapshot", async () => {
    const missing = readDatabase([]);
    await expect(
      readRunSessionSnapshot(runId, "pre", missing.database),
    ).resolves.toBeNull();

    const empty = readDatabase(snapshotRows([]));
    await expect(
      readRunSessionSnapshot(runId, "pre", empty.database),
    ).resolves.toEqual({
      runId,
      phase: "pre",
      items: [],
      createdAt: createdAt.toISOString(),
    });
  });

  it("returns a detached, strictly validated AgentInputItem array", async () => {
    const rows = snapshotRows();
    const { database } = readDatabase(rows);

    const snapshot = await readRunSessionSnapshot(runId, "pre", database);

    expect(snapshot?.items).toEqual(items);
    expect(snapshot?.items).not.toBe(rows);
    expect(snapshot?.items[0]).not.toBe(rows[0].item);
  });

  it("rejects an item_count that differs from the persisted rows", async () => {
    const { database } = readDatabase(snapshotRows(items, { item_count: 3 }));

    await expect(
      readRunSessionSnapshot(runId, "pre", database),
    ).rejects.toMatchObject({
      name: "RunSessionSnapshotIntegrityError",
      message: expect.stringContaining("item_count is 3, but 2 item rows"),
    });
  });

  it("rejects missing and duplicate positions", async () => {
    const rows = snapshotRows();
    rows[1].position = 1;
    const { database } = readDatabase(rows);

    await expect(
      readRunSessionSnapshot(runId, "pre", database),
    ).rejects.toMatchObject({
      name: "RunSessionSnapshotIntegrityError",
      message: expect.stringContaining("expected item position 2, received 1"),
    });
  });

  it("rejects invalid AgentInputItem JSON and unknown contract fields", async () => {
    const malformed = readDatabase(snapshotRows([{ role: "bogus", content: "x" }]));
    await expect(
      readRunSessionSnapshot(runId, "pre", malformed.database),
    ).rejects.toBeInstanceOf(RunSessionSnapshotIntegrityError);

    const unknownField = readDatabase(
      snapshotRows([{ role: "user", content: "x", unexpected: true }]),
    );
    await expect(
      readRunSessionSnapshot(runId, "pre", unknownField.database),
    ).rejects.toThrow("fields outside the AgentInputItem contract");
  });

  it("rejects malformed empty snapshots and inconsistent metadata", async () => {
    const malformedEmptyRows = snapshotRows([]);
    malformedEmptyRows[0].position = 1;
    const malformedEmpty = readDatabase(malformedEmptyRows);
    await expect(
      readRunSessionSnapshot(runId, "pre", malformedEmpty.database),
    ).rejects.toThrow("empty snapshot has persisted item rows");

    const inconsistentRows = snapshotRows();
    inconsistentRows[1].created_at = new Date("2026-08-26T09:00:00.000Z");
    const inconsistent = readDatabase(inconsistentRows);
    await expect(
      readRunSessionSnapshot(runId, "pre", inconsistent.database),
    ).rejects.toThrow("metadata differs between item rows");
  });
});

describe("writeRunSessionSnapshot", () => {
  it("writes a new non-empty snapshot through an existing PoolClient transaction", async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("INSERT INTO run_session_snapshots")) {
        expect(parameters).toEqual([runId, "pre", items.length]);
        return queryResult([{ run_id: runId }], "INSERT");
      }
      if (sql.includes("INSERT INTO run_session_snapshot_items")) {
        expect(parameters).toEqual([runId, "pre", JSON.stringify(items)]);
        return queryResult([], "INSERT");
      }
      if (sql.includes("FROM run_session_snapshots snapshot")) {
        return queryResult(snapshotRows());
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as unknown as PoolClient["query"];
    const client = transactionClient(query);

    await expect(
      writeRunSessionSnapshot(runId, "pre", items, client),
    ).resolves.toEqual({
      runId,
      phase: "pre",
      items,
      createdAt: createdAt.toISOString(),
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).not.toHaveBeenCalledWith("BEGIN");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("persists an empty snapshot header without inventing an item row", async () => {
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      if (sql.includes("INSERT INTO run_session_snapshots")) {
        expect(parameters).toEqual([runId, "post", 0]);
        return queryResult([{ run_id: runId }], "INSERT");
      }
      if (sql.includes("FROM run_session_snapshots snapshot")) {
        return queryResult(snapshotRows([], { phase: "post" }));
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as unknown as PoolClient["query"];

    await expect(
      writeRunSessionSnapshot(runId, "post", [], transactionClient(query)),
    ).resolves.toMatchObject({ items: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("is idempotent when an existing snapshot contains the same items", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO run_session_snapshots")) {
        return queryResult([], "INSERT");
      }
      if (sql.includes("FROM run_session_snapshots snapshot")) {
        return queryResult(snapshotRows());
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as unknown as PoolClient["query"];

    await expect(
      writeRunSessionSnapshot(runId, "pre", structuredClone(items), transactionClient(query)),
    ).resolves.toMatchObject({ items });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("rejects attempts to replace an existing snapshot with different items", async () => {
    const existingItems = [{ role: "user", content: "Original" }] satisfies AgentInputItem[];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO run_session_snapshots")) {
        return queryResult([], "INSERT");
      }
      if (sql.includes("FROM run_session_snapshots snapshot")) {
        return queryResult(snapshotRows(existingItems));
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as unknown as PoolClient["query"];

    await expect(
      writeRunSessionSnapshot(runId, "pre", items, transactionClient(query)),
    ).rejects.toBeInstanceOf(RunSessionSnapshotConflictError);
  });

  it("rejects lossy JSON and invalid AgentInputItem values before querying", async () => {
    const query = vi.fn();
    const client = transactionClient(query as unknown as PoolClient["query"]);

    await expect(
      writeRunSessionSnapshot(
        runId,
        "pre",
        [{ role: "user", content: "x", extra: undefined } as unknown as AgentInputItem],
        client,
      ),
    ).rejects.toThrow("losslessly JSON-serializable");
    await expect(
      writeRunSessionSnapshot(
        runId,
        "pre",
        [{ role: "invalid", content: "x" } as unknown as AgentInputItem],
        client,
      ),
    ).rejects.toThrow("is not a valid AgentInputItem");
    expect(query).not.toHaveBeenCalled();
  });

  it("owns BEGIN/COMMIT for a Pool and leaves transaction control to PoolClient callers", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") {
        return queryResult([], sql);
      }
      if (sql.includes("INSERT INTO run_session_snapshots")) {
        return queryResult([{ run_id: runId }], "INSERT");
      }
      if (sql.includes("FROM run_session_snapshots snapshot")) {
        return queryResult(snapshotRows([]));
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as unknown as PoolClient["query"];
    const client = transactionClient(query);
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;

    await writeRunSessionSnapshot(runId, "pre", [], pool);

    expect(query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
