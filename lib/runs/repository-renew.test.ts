import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { renewRunLease } from "./repository";

describe("renewRunLease", () => {
  it("requires the existing lease to still be unexpired before renewing it", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const database = { query } as unknown as Pool;

    await expect(
      renewRunLease(
        {
          runId: "20000000-0000-4000-8000-000000000001",
          leaseOwner: "90000000-0000-4000-8000-000000000001",
          leaseToken: "7",
        },
        30_000,
        database,
      ),
    ).resolves.toEqual({ owned: false, cancelRequested: false });

    expect(query).toHaveBeenCalledOnce();
    const [statement, parameters] = query.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(statement).toContain("clock_timestamp()");
    expect(statement).toContain("FOR UPDATE");
    expect(statement).toContain(
      "run.lease_expires_at > wall_clock.current_time",
    );
    expect(parameters).toEqual([
      "20000000-0000-4000-8000-000000000001",
      "90000000-0000-4000-8000-000000000001",
      "7",
      30_000,
    ]);
  });
});
