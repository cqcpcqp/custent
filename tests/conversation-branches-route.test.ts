import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationSummary } from "@/lib/contracts";
import { AppError } from "@/lib/errors";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  sourceConversation: "22222222-2222-4222-8222-222222222222",
  sourceMessage: "33333333-3333-4333-8333-333333333333",
  request: "44444444-4444-4444-8444-444444444444",
  targetConversation: "55555555-5555-4555-8555-555555555555",
};

const mocks = vi.hoisted(() => ({
  branchConversationFromMessage: vi.fn(),
  getCurrentUserId: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/db", () => ({
  branchConversationFromMessage: mocks.branchConversationFromMessage,
}));

import { POST } from "@/app/api/conversations/[conversationId]/branches/route";

const timestamp = "2026-08-28T08:00:00.000Z";
const conversation: ConversationSummary = {
  id: ids.targetConversation,
  title: "德国工业泵买家",
  updatedAt: timestamp,
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

function context(conversationId = ids.sourceConversation) {
  return { params: Promise.resolve({ conversationId }) };
}

function request(body: unknown): Request {
  return new Request(
    `http://localhost/api/conversations/${ids.sourceConversation}/branches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.branchConversationFromMessage.mockResolvedValue({ conversation });
});

describe("POST /api/conversations/:conversationId/branches", () => {
  it("creates a message branch with the exact request contract", async () => {
    const body = {
      requestId: ids.request,
      sourceMessageId: ids.sourceMessage,
    };
    const response = await POST(request(body), context());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ conversation });
    expect(mocks.branchConversationFromMessage).toHaveBeenCalledWith({
      userId: ids.user,
      sourceConversationId: ids.sourceConversation,
      request: body,
    });
  });

  it("rejects invalid path and body UUIDs before repository access", async () => {
    const invalidPath = await POST(
      request({
        requestId: ids.request,
        sourceMessageId: ids.sourceMessage,
      }),
      context("not-a-uuid"),
    );
    expect(invalidPath.status).toBe(400);

    const invalidBody = await POST(
      request({ requestId: ids.request, sourceMessageId: "not-a-uuid" }),
      context(),
    );
    expect(invalidBody.status).toBe(400);
    expect(mocks.branchConversationFromMessage).not.toHaveBeenCalled();
  });

  it("rejects fields outside the fixed request contract", async () => {
    const response = await POST(
      request({
        requestId: ids.request,
        sourceMessageId: ids.sourceMessage,
        sourceRunId: "66666666-6666-4666-8666-666666666666",
      }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.branchConversationFromMessage).not.toHaveBeenCalled();
  });

  it("preserves repository business errors", async () => {
    mocks.branchConversationFromMessage.mockRejectedValueOnce(
      new AppError(
        "RUN_CONTEXT_UNAVAILABLE",
        "这条回答的完整上下文不可用。",
        409,
      ),
    );
    const response = await POST(
      request({
        requestId: ids.request,
        sourceMessageId: ids.sourceMessage,
      }),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RUN_CONTEXT_UNAVAILABLE",
        message: "这条回答的完整上下文不可用。",
      },
    });
  });
});
