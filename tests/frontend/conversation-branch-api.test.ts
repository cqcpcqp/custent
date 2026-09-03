import { afterEach, describe, expect, it, vi } from "vitest";

import { branchConversation } from "@/components/api-client";

const sourceConversationId = "10000000-0000-4000-8000-000000000001";
const targetConversationId = "20000000-0000-4000-8000-000000000001";
const sourceMessageId = "30000000-0000-4000-8000-000000000001";
const requestId = "40000000-0000-4000-8000-000000000001";
const conversation = {
  id: targetConversationId,
  title: "德国工业泵买家",
  updatedAt: "2026-08-28T08:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

function jsonResponse(payload: unknown, status = 201): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("conversation branch API client", () => {
  it("posts the exact idempotent branch request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ conversation }));
    vi.stubGlobal("fetch", fetchMock);
    const request = { requestId, sourceMessageId };

    await expect(
      branchConversation(sourceConversationId, request),
    ).resolves.toEqual({ conversation });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${sourceConversationId}/branches`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: undefined,
      },
    );
  });

  it("rejects response fields outside the fixed contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ conversation, messages: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      branchConversation(sourceConversationId, {
        requestId,
        sourceMessageId,
      }),
    ).rejects.toThrow();
  });

  it("preserves structured API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "RUN_CONTEXT_UNAVAILABLE",
            message: "这条回答的完整上下文不可用。",
          },
        },
        409,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      branchConversation(sourceConversationId, {
        requestId,
        sourceMessageId,
      }),
    ).rejects.toMatchObject({
      code: "RUN_CONTEXT_UNAVAILABLE",
      status: 409,
    });
  });
});
