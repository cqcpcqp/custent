import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BackgroundRunHistoryResponse } from "@/lib/contracts";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  listBackgroundRunHistoryPage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/runs", () => ({
  listBackgroundRunHistoryPage: mocks.listBackgroundRunHistoryPage,
}));

import { GET } from "@/app/api/runs/history/route";

const responseBody: BackgroundRunHistoryResponse = {
  items: [
    {
      runId: ids.run,
      conversationId: ids.conversation,
      conversationTitle: "German pump buyers",
      status: "completed",
      finishedAt: "2026-08-28T08:02:00.000Z",
    },
  ],
  nextCursor: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.listBackgroundRunHistoryPage.mockResolvedValue(responseBody);
});

describe("GET /api/runs/history", () => {
  it("uses the current user and fixed default history page", async () => {
    const response = await GET(
      new Request("http://localhost/api/runs/history"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(mocks.listBackgroundRunHistoryPage).toHaveBeenCalledWith({
      userId: ids.user,
      status: "all",
      cursor: null,
      limit: 20,
    });
  });

  it("passes one fixed terminal filter, opaque cursor, and explicit limit", async () => {
    await GET(
      new Request(
        "http://localhost/api/runs/history?status=failed&cursor=opaque_cursor&limit=12",
      ),
    );

    expect(mocks.listBackgroundRunHistoryPage).toHaveBeenCalledWith({
      userId: ids.user,
      status: "failed",
      cursor: "opaque_cursor",
      limit: 12,
    });
  });

  it("matches existing list routes by ignoring unknown keys and using first repeated values", async () => {
    await GET(
      new Request(
        "http://localhost/api/runs/history?unknown=value&status=cancelled&status=failed&cursor=first&cursor=second&limit=11&limit=12",
      ),
    );

    expect(mocks.listBackgroundRunHistoryPage).toHaveBeenCalledWith({
      userId: ids.user,
      status: "cancelled",
      cursor: "first",
      limit: 11,
    });
  });

  it.each([
    "status=running",
    "status=",
    "cursor=",
    "limit=0",
    "limit=51",
    "limit=1.5",
  ])("rejects invalid query %s before reading history", async (query) => {
    const response = await GET(
      new Request(`http://localhost/api/runs/history?${query}`),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "请求内容不符合接口约定。",
      },
    });
    expect(mocks.listBackgroundRunHistoryPage).not.toHaveBeenCalled();
  });
});
