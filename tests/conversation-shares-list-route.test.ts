import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ListConversationSharesResponse } from "@/lib/contracts";
import { AppError } from "@/lib/errors";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  public: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  listConversationSharePage: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  listConversationSharePage: mocks.listConversationSharePage,
}));

import { GET } from "@/app/api/conversation-shares/route";

const page: ListConversationSharesResponse = {
  items: [
    {
      conversationId: ids.conversation,
      publicId: ids.public,
      publicPath: `/share/${ids.public}`,
      title: "German buyers",
      createdAt: "2026-08-29T08:00:00.000Z",
      updatedAt: "2026-08-30T08:00:00.000Z",
    },
  ],
  nextCursor: "next_page",
};

function request(query = ""): Request {
  return new Request(`http://localhost/api/conversation-shares${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.listConversationSharePage.mockResolvedValue(page);
});

describe("GET /api/conversation-shares", () => {
  it("returns the exact current-owner page with fixed defaults", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(page);
    expect(mocks.listConversationSharePage).toHaveBeenCalledWith({
      userId: ids.user,
      cursor: null,
      limit: 30,
    });
  });

  it("forwards one opaque cursor and bounded limit", async () => {
    await GET(request("?cursor=opaque_cursor&limit=12"));

    expect(mocks.listConversationSharePage).toHaveBeenCalledWith({
      userId: ids.user,
      cursor: "opaque_cursor",
      limit: 12,
    });
  });

  it.each(["?limit=0", "?limit=51", "?limit=1.5", "?cursor="])(
    "rejects invalid list input before repository access (%s)",
    async (query) => {
      const response = await GET(request(query));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
      expect(mocks.listConversationSharePage).not.toHaveBeenCalled();
    },
  );

  it("preserves an invalid opaque cursor repository error", async () => {
    mocks.listConversationSharePage.mockRejectedValueOnce(
      new AppError("INVALID_REQUEST", "共享链接分页游标无效。", 400),
    );

    const response = await GET(request("?cursor=bad_cursor"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "共享链接分页游标无效。",
      },
    });
  });
});
