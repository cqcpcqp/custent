import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { failClaimedRun, RunLeaseLostError } from "./repository";

describe("failClaimedRun lease fence", () => {
  it("requires an unexpired lease before locking or finalizing a failed run", async () => {
    const query = vi.fn(async (statement: string) => {
      if (statement === "BEGIN" || statement === "ROLLBACK") {
        return { rowCount: null, rows: [] };
      }
      if (statement.includes("SELECT conversation.id")) {
        return {
          rowCount: 1,
          rows: [{ id: "30000000-0000-4000-8000-000000000001" }],
        };
      }
      if (statement.includes("FROM runs run")) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${statement}`);
    });
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient;
    const database = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;

    await expect(
      failClaimedRun(
        {
          lease: {
            runId: "20000000-0000-4000-8000-000000000001",
            leaseOwner: "90000000-0000-4000-8000-000000000001",
            leaseToken: "7",
          },
          errorName: "AbortError",
        },
        database,
      ),
    ).rejects.toBeInstanceOf(RunLeaseLostError);

    const statements = query.mock.calls.map(([statement]) => statement);
    const conversationLock = statements.find((statement) =>
      statement.includes("SELECT conversation.id"),
    );
    const runLock = statements.find(
      (statement) =>
        statement.includes("FROM runs run") &&
        statement.includes("FOR UPDATE OF run"),
    );
    expect(conversationLock).not.toContain("lease_expires_at >");
    expect(runLock).toContain("lease_expires_at > clock_timestamp()");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
