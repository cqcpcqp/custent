import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { getArtifact } from "@/lib/artifacts";
import {
  getResearchSnapshot,
  listResearchSnapshots,
  listResearchSnapshotsForRun,
} from "@/lib/research";
import {
  cancelAgentRun,
  getAgentRun,
  listConversationRuns,
  readRunEventBatch,
} from "@/lib/runs";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
  artifact: "44444444-4444-4444-8444-444444444444",
  snapshot: "55555555-5555-4555-8555-555555555555",
};

function emptyResult() {
  return {
    command: "SELECT",
    rowCount: 0,
    oid: 0,
    fields: [],
    rows: [],
  };
}

function readOnlyPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    void sql;
    void params;
    return emptyResult();
  });
  return { database: { query } as unknown as Pool, query };
}

function expectDeletedConversationGuard(sql: unknown): void {
  expect(sql).toEqual(expect.any(String));
  expect(sql as string).toMatch(/(?:FROM|JOIN) conversations conversation/u);
  expect(sql as string).toContain("conversation.deleted_at IS NULL");
}

describe("soft-delete repository reachability guards", () => {
  it("guards every public run read with the owning conversation", async () => {
    const getRun = readOnlyPool();
    await expect(
      getAgentRun(ids.user, ids.run, getRun.database),
    ).resolves.toBeNull();
    expectDeletedConversationGuard(getRun.query.mock.calls[0][0]);

    const listRuns = readOnlyPool();
    await expect(
      listConversationRuns(
        ids.user,
        ids.conversation,
        listRuns.database,
      ),
    ).resolves.toEqual([]);
    expectDeletedConversationGuard(listRuns.query.mock.calls[0][0]);

    const readEvents = readOnlyPool();
    await expect(
      readRunEventBatch(
        {
          userId: ids.user,
          runId: ids.run,
          afterEventId: "0",
        },
        readEvents.database,
      ),
    ).resolves.toBeNull();
    expectDeletedConversationGuard(readEvents.query.mock.calls[0][0]);
  });

  it("guards cancellation before locking or mutating an old run", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") {
        return emptyResult();
      }
      expectDeletedConversationGuard(sql);
      return emptyResult();
    });
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient;
    const database = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;

    await expect(
      cancelAgentRun(ids.user, ids.run, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("guards artifact and research reads with the owning conversation", async () => {
    const artifact = readOnlyPool();
    await expect(
      getArtifact(ids.user, ids.artifact, artifact.database),
    ).resolves.toBeNull();
    expectDeletedConversationGuard(artifact.query.mock.calls[0][0]);

    const snapshot = readOnlyPool();
    await expect(
      getResearchSnapshot(ids.user, ids.snapshot, snapshot.database),
    ).resolves.toBeNull();
    expectDeletedConversationGuard(snapshot.query.mock.calls[0][0]);

    const list = readOnlyPool();
    await expect(
      listResearchSnapshots(ids.user, ids.conversation, list.database),
    ).resolves.toEqual([]);
    expectDeletedConversationGuard(list.query.mock.calls[0][0]);

    const listForRun = readOnlyPool();
    await expect(
      listResearchSnapshotsForRun(
        ids.user,
        ids.conversation,
        ids.run,
        listForRun.database,
      ),
    ).resolves.toEqual([]);
    expectDeletedConversationGuard(listForRun.query.mock.calls[0][0]);
  });
});
