import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveAllConversations,
  deleteAllConversations,
} from "@/components/api-client";

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

describe("bulk conversation API client", () => {
  it("archives through the exact collection PATCH contract", async () => {
    const payload = {
      mutation: {
        action: "archive_all",
        conversationCount: 3,
        completedAt: "2026-09-01T08:00:00.000Z",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(archiveAllConversations()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "archive_all" }),
      signal: undefined,
    });
  });

  it("deletes through the bodyless collection DELETE contract", async () => {
    const payload = {
      mutation: {
        action: "delete_all",
        conversationCount: 5,
        completedAt: "2026-09-01T08:01:00.000Z",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteAllConversations()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("/api/conversations", {
      method: "DELETE",
      signal: undefined,
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(Object.hasOwn(request, "body")).toBe(false);
  });

  it("rejects extra response fields instead of guessing a compatible shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          mutation: {
            action: "archive_all",
            conversationCount: 0,
            completedAt: "2026-09-01T08:02:00.000Z",
            conversationIds: [],
          },
        }),
      ),
    );

    await expect(archiveAllConversations()).rejects.toThrow();
  });
});
