import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiNetworkError,
  getBackgroundRunHistory,
} from "@/components/api-client";
import {
  backgroundRunHistoryInitialPageRequest,
  backgroundRunHistoryNextPageRequest,
} from "@/components/background-run-center-state";
import type { BackgroundRunHistoryResponse } from "@/lib/contracts";

const response: BackgroundRunHistoryResponse = {
  items: [
    {
      runId: "10000000-0000-4000-8000-000000000001",
      conversationId: "20000000-0000-4000-8000-000000000001",
      conversationTitle: "德国工业泵买家",
      status: "completed",
      finishedAt: "2026-08-28T08:02:00.000Z",
    },
  ],
  nextCursor: "opaque/+ cursor=",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background Run history fixed API client", () => {
  it("sends the exact status, page limit, and opaque keyset cursor", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(response))
      .mockResolvedValueOnce(
        Response.json({ ...response, items: [], nextCursor: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getBackgroundRunHistory(
        backgroundRunHistoryInitialPageRequest("completed"),
      ),
    ).resolves.toEqual(response);
    await expect(
      getBackgroundRunHistory(
        backgroundRunHistoryNextPageRequest("failed", "opaque/+ cursor="),
      ),
    ).resolves.toMatchObject({ nextCursor: null });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runs/history?status=completed&limit=20",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runs/history?status=failed&limit=20&cursor=opaque%2F%2B+cursor%3D",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("strictly rejects added backend fields and nonterminal statuses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...response, total: 1 }))
      .mockResolvedValueOnce(
        Response.json({
          ...response,
          items: [{ ...response.items[0], status: "running" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getBackgroundRunHistory(backgroundRunHistoryInitialPageRequest("all")),
    ).rejects.toThrow();
    await expect(
      getBackgroundRunHistory(backgroundRunHistoryInitialPageRequest("all")),
    ).rejects.toThrow();
  });

  it("turns only fetch network failures into an explicit network error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        new TypeError(
          "Failed to fetch https://internal.example.invalid/runs/history",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getBackgroundRunHistory(backgroundRunHistoryInitialPageRequest("all")),
    ).rejects.toEqual(new ApiNetworkError());
  });

  it("preserves AbortError so cancelled history requests stay silent", async () => {
    const abortError = new DOMException("Request aborted", "AbortError");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(abortError);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getBackgroundRunHistory(backgroundRunHistoryInitialPageRequest("all")),
    ).rejects.toBe(abortError);
  });
});
