import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getConversationShare,
  listConversationShares,
  putConversationShare,
  revokeConversationShare,
} from "@/components/api-client";

const conversationId = "10000000-0000-4000-8000-000000000001";
const publicId = "20000000-0000-4000-8000-000000000001";
const share = {
  conversationId,
  publicId,
  publicPath: `/share/${publicId}` as const,
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T09:00:00.000Z",
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("conversation share API client", () => {
  it("lists the exact owner page without caching", async () => {
    const page = {
      items: [{ ...share, title: "German buyers" }],
      nextCursor: "next_page",
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listConversationShares({ cursor: "current_page", limit: 30 }),
    ).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/conversation-shares?limit=30&cursor=current_page",
      {
        method: "GET",
        cache: "no-store",
        signal: undefined,
      },
    );
  });

  it("loads the exact share endpoint without caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ share }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConversationShare(conversationId)).resolves.toEqual({
      share,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/share`,
      {
        method: "GET",
        cache: "no-store",
        signal: undefined,
      },
    );
  });

  it("publishes with PUT and no invented request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ share }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(putConversationShare(conversationId)).resolves.toEqual({
      share,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/share`,
      {
        method: "PUT",
        signal: undefined,
      },
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(Object.hasOwn(request, "body")).toBe(false);
  });

  it("revokes with DELETE and parses the fixed revocation contract", async () => {
    const revocation = {
      conversationId,
      publicId,
      revokedAt: "2026-08-28T10:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ revocation }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      revokeConversationShare(conversationId, publicId),
    ).resolves.toEqual({ revocation });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/share?publicId=${publicId}`,
      {
        method: "DELETE",
        signal: undefined,
      },
    );
  });

  it("rejects response fields outside the documented contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ share: { ...share, url: "wrong" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConversationShare(conversationId)).rejects.toThrow();
  });

  it("rejects a public path that does not match the fixed public ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        share: {
          ...share,
          publicPath: "/share/30000000-0000-4000-8000-000000000001",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(putConversationShare(conversationId)).rejects.toThrow(
      "Public path must match the public share ID",
    );
  });
});
