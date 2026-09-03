import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationShareSummary,
  RevokeConversationShareResponse,
} from "@/lib/contracts";
import { AppError } from "@/lib/errors";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  public: "33333333-3333-4333-8333-333333333333",
};

const mocks = vi.hoisted(() => ({
  getConversationShare: vi.fn(),
  getCurrentUserId: vi.fn(),
  putConversationShare: vi.fn(),
  revokeConversationShare: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  getConversationShare: mocks.getConversationShare,
  putConversationShare: mocks.putConversationShare,
  revokeConversationShare: mocks.revokeConversationShare,
}));

import {
  DELETE,
  GET,
  PUT,
} from "@/app/api/conversations/[conversationId]/share/route";

const timestamp = "2026-08-28T08:00:00.000Z";
const share: ConversationShareSummary = {
  conversationId: ids.conversation,
  publicId: ids.public,
  publicPath: `/share/${ids.public}`,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const revocation: RevokeConversationShareResponse["revocation"] = {
  conversationId: ids.conversation,
  publicId: ids.public,
  revokedAt: timestamp,
};

function context(conversationId = ids.conversation) {
  return { params: Promise.resolve({ conversationId }) };
}

function request(
  method: "GET" | "PUT" | "DELETE",
  expectedPublicId: string | null = ids.public,
): Request {
  const query =
    method === "DELETE" && expectedPublicId !== null
      ? `?publicId=${encodeURIComponent(expectedPublicId)}`
      : "";
  return new Request(
    `http://localhost/api/conversations/${ids.conversation}/share${query}`,
    { method },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.getConversationShare.mockResolvedValue(null);
  mocks.putConversationShare.mockResolvedValue(share);
  mocks.revokeConversationShare.mockResolvedValue(revocation);
});

describe("/api/conversations/:conversationId/share", () => {
  it("returns the exact nullable owner share contract", async () => {
    const absentResponse = await GET(request("GET"), context());
    expect(absentResponse.status).toBe(200);
    await expect(absentResponse.json()).resolves.toEqual({ share: null });

    mocks.getConversationShare.mockResolvedValueOnce(share);
    const existingResponse = await GET(request("GET"), context());
    expect(existingResponse.status).toBe(200);
    await expect(existingResponse.json()).resolves.toEqual({ share });
    expect(mocks.getConversationShare).toHaveBeenLastCalledWith(
      ids.user,
      ids.conversation,
    );
  });

  it("publishes or refreshes the snapshot without reading a request body", async () => {
    const response = await PUT(request("PUT"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ share });
    expect(mocks.putConversationShare).toHaveBeenCalledWith(
      ids.user,
      ids.conversation,
    );
  });

  it("revokes one owned share with the fixed receipt", async () => {
    const response = await DELETE(request("DELETE"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revocation });
    expect(mocks.revokeConversationShare).toHaveBeenCalledWith(
      ids.user,
      ids.conversation,
      ids.public,
    );
  });

  it.each([null, "not-a-uuid"])(
    "requires one valid expected public ID before revocation (%s)",
    async (publicId) => {
      const response = await DELETE(request("DELETE", publicId), context());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "INVALID_REQUEST" },
      });
      expect(mocks.revokeConversationShare).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["GET", GET],
    ["PUT", PUT],
    ["DELETE", DELETE],
  ] as const)("rejects an invalid UUID before %s repository access", async (method, handler) => {
    const response = await handler(request(method), context("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(mocks.getConversationShare).not.toHaveBeenCalled();
    expect(mocks.putConversationShare).not.toHaveBeenCalled();
    expect(mocks.revokeConversationShare).not.toHaveBeenCalled();
  });

  it("preserves repository business errors", async () => {
    mocks.putConversationShare.mockRejectedValueOnce(
      new AppError("ACTIVE_RUN", "对话仍在运行。", 409),
    );
    const activeResponse = await PUT(request("PUT"), context());
    expect(activeResponse.status).toBe(409);
    await expect(activeResponse.json()).resolves.toEqual({
      error: { code: "ACTIVE_RUN", message: "对话仍在运行。" },
    });

    mocks.revokeConversationShare.mockRejectedValueOnce(
      new AppError("SHARE_NOT_FOUND", "对话尚未分享。", 404),
    );
    const missingResponse = await DELETE(request("DELETE"), context());
    expect(missingResponse.status).toBe(404);
    await expect(missingResponse.json()).resolves.toEqual({
      error: { code: "SHARE_NOT_FOUND", message: "对话尚未分享。" },
    });
  });
});
