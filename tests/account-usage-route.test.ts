import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountUsageResponse } from "@/lib/contracts";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  getAccountUsagePage: vi.fn(),
  getCurrentUserId: vi.fn(),
  snapshotClient: { query: vi.fn() },
  withReadOnlyRepeatableReadTransaction: vi.fn(),
}));

vi.mock("@/lib/account", () => ({
  getAccountUsagePage: mocks.getAccountUsagePage,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  withReadOnlyRepeatableReadTransaction:
    mocks.withReadOnlyRepeatableReadTransaction,
}));

import { GET } from "@/app/api/account/usage/route";

const responseBody: AccountUsageResponse = {
  balance: { available: 7_495, reserved: 1_500, frozen: 500 },
  items: [
    {
      runId: ids.run,
      conversationId: ids.conversation,
      conversationTitle: "German pump buyers",
      status: "completed",
      reservationCredits: 2_000,
      chargedCredits: 37,
      inputTokens: 1_200,
      outputTokens: 320,
      webSearches: 4,
      createdAt: "2026-08-28T08:00:00.000Z",
      finishedAt: "2026-08-28T08:02:00.000Z",
    },
  ],
  nextCursor: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.getAccountUsagePage.mockResolvedValue(responseBody);
  mocks.withReadOnlyRepeatableReadTransaction.mockImplementation(
    async (operation: (client: unknown) => Promise<unknown>) =>
      operation(mocks.snapshotClient),
  );
});

describe("GET /api/account/usage", () => {
  it("uses the fixed default page in one repeatable-read snapshot", async () => {
    const response = await GET(
      new Request("http://localhost/api/account/usage"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(mocks.withReadOnlyRepeatableReadTransaction).toHaveBeenCalledOnce();
    expect(mocks.getAccountUsagePage).toHaveBeenCalledWith(
      { userId: ids.user, cursor: null, limit: 30 },
      mocks.snapshotClient,
    );
  });

  it("passes an opaque cursor and explicit limit without interpreting it", async () => {
    await GET(
      new Request(
        "http://localhost/api/account/usage?cursor=opaque_cursor&limit=12",
      ),
    );

    expect(mocks.getAccountUsagePage).toHaveBeenCalledWith(
      { userId: ids.user, cursor: "opaque_cursor", limit: 12 },
      mocks.snapshotClient,
    );
  });

  it("matches existing list routes by ignoring unknown keys and using first repeated values", async () => {
    await GET(
      new Request(
        "http://localhost/api/account/usage?unknown=value&cursor=first_cursor&cursor=second_cursor&limit=12&limit=13",
      ),
    );

    expect(mocks.getAccountUsagePage).toHaveBeenCalledWith(
      { userId: ids.user, cursor: "first_cursor", limit: 12 },
      mocks.snapshotClient,
    );
  });

  it.each(["cursor=", "limit=0", "limit=51", "limit=1.5"])(
    "rejects invalid query %s before opening a transaction",
    async (query) => {
      const response = await GET(
        new Request(`http://localhost/api/account/usage?${query}`),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "INVALID_REQUEST",
          message: "请求内容不符合接口约定。",
        },
      });
      expect(mocks.withReadOnlyRepeatableReadTransaction).not.toHaveBeenCalled();
      expect(mocks.getAccountUsagePage).not.toHaveBeenCalled();
    },
  );
});
