import { describe, expect, it, vi } from "vitest";

import type { Queryable } from "./types";
import { getUserAccount } from "./users";

const userId = "11111111-1111-4111-8111-111111111111";

function databaseWithRows(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rowCount: rows.length, rows });
  return { database: { query } as unknown as Queryable, query };
}

describe("user account repository", () => {
  it("reads the explicitly supplied user and preserves the credit mapping", async () => {
    const fixture = databaseWithRows([
      {
        id: userId,
        name: "测试用户",
        available_credits: 10_000,
        reserved_credits: 400,
        frozen_credits: 100,
      },
    ]);

    await expect(
      getUserAccount(userId, fixture.database),
    ).resolves.toEqual({
      user: { id: userId, name: "测试用户" },
      credits: { available: 10_000, reserved: 500 },
    });
    expect(fixture.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1"),
      [userId],
    );
  });

  it("fails closed when the supplied user does not exist", async () => {
    const fixture = databaseWithRows([]);

    await expect(
      getUserAccount(userId, fixture.database),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Demo user was not found",
      status: 404,
    });
    expect(fixture.query).toHaveBeenCalledOnce();
  });
});
