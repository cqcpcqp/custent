import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { withReadOnlyRepeatableReadTransaction } from "./pool";

function transactionFixture() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const database = { connect } as unknown as Pool;
  return { client, connect, database, query, release };
}

describe("withReadOnlyRepeatableReadTransaction", () => {
  it("commits a repeatable-read read-only transaction and releases its client", async () => {
    const fixture = transactionFixture();
    const operation = vi.fn().mockResolvedValue("snapshot result");

    await expect(
      withReadOnlyRepeatableReadTransaction(operation, fixture.database),
    ).resolves.toBe("snapshot result");

    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledWith(fixture.client);
    expect(fixture.query.mock.calls).toEqual([
      ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"],
      ["COMMIT"],
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rolls back an operation failure and always releases its client", async () => {
    const fixture = transactionFixture();
    const failure = new Error("snapshot query failed");
    const operation = vi.fn().mockRejectedValue(failure);

    await expect(
      withReadOnlyRepeatableReadTransaction(operation, fixture.database),
    ).rejects.toBe(failure);

    expect(fixture.query.mock.calls).toEqual([
      ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"],
      ["ROLLBACK"],
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
