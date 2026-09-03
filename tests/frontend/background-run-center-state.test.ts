import { describe, expect, it, vi } from "vitest";

import {
  ApiClientError,
  ApiNetworkError,
} from "@/components/api-client";
import {
  backgroundRunHistoryErrorMessage,
  backgroundRunHistoryInitialPageRequest,
  backgroundRunHistoryMergePage,
  backgroundRunHistoryNextPageRequest,
  backgroundRunHistoryResultSurface,
  backgroundRunHistorySelection,
  backgroundRunHistoryWithoutCenterRuns,
  backgroundRunHistoryPageSize,
  backgroundRunCenterItems,
  backgroundRunCenterSelection,
  loadBackgroundRunHistoryUntilVisible,
} from "@/components/background-run-center-state";
import type {
  BackgroundRunHistoryItem,
  ConversationSummary,
} from "@/lib/contracts";

function conversation(
  suffix: string,
  input: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    title: `会话 ${suffix}`,
    updatedAt: "2026-08-28T08:00:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: null,
    activeRun: null,
    waitingRunCount: 0,
    attention: null,
    ...input,
  };
}

describe("background run center state", () => {
  it("omits conversations without active, waiting, or unread terminal state", () => {
    expect(backgroundRunCenterItems([])).toEqual([]);
    expect(backgroundRunCenterItems([conversation("1")])).toEqual([]);
  });

  it("projects active, waiting, and attention from one fixed summary in priority order", () => {
    const summary = conversation("1", {
      title: "德国泵类买家",
      updatedAt: "2026-08-28T09:00:00.000Z",
      activeRun: {
        id: "20000000-0000-4000-8000-000000000001",
        status: "running",
        startedAt: "2026-08-28T08:55:00.000Z",
      },
      waitingRunCount: 2,
      attention: {
        runId: "20000000-0000-4000-8000-000000000009",
        terminalEventId: "42",
        status: "completed",
        finishedAt: "2026-08-28T08:50:00.000Z",
      },
    });

    expect(backgroundRunCenterItems([summary])).toEqual([
      {
        id: `active:${summary.id}:20000000-0000-4000-8000-000000000001`,
        kind: "active",
        conversationId: summary.id,
        conversationTitle: "德国泵类买家",
        conversationUpdatedAt: summary.updatedAt,
        runId: "20000000-0000-4000-8000-000000000001",
        status: "running",
        startedAt: "2026-08-28T08:55:00.000Z",
      },
      {
        id: `waiting:${summary.id}`,
        kind: "waiting",
        conversationId: summary.id,
        conversationTitle: "德国泵类买家",
        conversationUpdatedAt: summary.updatedAt,
        status: "waiting",
        waitingRunCount: 2,
      },
      {
        id: `attention:${summary.id}:20000000-0000-4000-8000-000000000009:42`,
        kind: "attention",
        conversationId: summary.id,
        conversationTitle: "德国泵类买家",
        conversationUpdatedAt: summary.updatedAt,
        runId: "20000000-0000-4000-8000-000000000009",
        status: "completed",
        terminalEventId: "42",
        finishedAt: "2026-08-28T08:50:00.000Z",
      },
    ]);
  });

  it("covers queued and running active statuses without deriving another status", () => {
    const queued = conversation("1", {
      activeRun: {
        id: "20000000-0000-4000-8000-000000000001",
        status: "queued",
        startedAt: null,
      },
    });
    const running = conversation("2", {
      activeRun: {
        id: "20000000-0000-4000-8000-000000000002",
        status: "running",
        startedAt: "2026-08-28T07:59:00.000Z",
      },
    });

    expect(
      backgroundRunCenterItems([running, queued]).map((item) => ({
        kind: item.kind,
        status: item.status,
        ...("startedAt" in item ? { startedAt: item.startedAt } : {}),
      })),
    ).toEqual([
      { kind: "active", status: "queued", startedAt: null },
      {
        kind: "active",
        status: "running",
        startedAt: "2026-08-28T07:59:00.000Z",
      },
    ]);
  });

  it.each([
    "completed",
    "failed",
    "cancelled",
    "reconciliation_required",
  ] as const)("preserves the exact %s attention status", (status) => {
    const summary = conversation("1", {
      attention: {
        runId: "20000000-0000-4000-8000-000000000001",
        terminalEventId: "73",
        status,
        finishedAt: "2026-08-28T08:01:00.000Z",
      },
    });

    expect(backgroundRunCenterItems([summary])).toMatchObject([
      { kind: "attention", status, terminalEventId: "73" },
    ]);
  });

  it("emits one aggregated waiting item with the exact waitingRunCount", () => {
    const summary = conversation("1", { waitingRunCount: 5 });

    expect(backgroundRunCenterItems([summary])).toEqual([
      expect.objectContaining({
        id: `waiting:${summary.id}`,
        kind: "waiting",
        status: "waiting",
        waitingRunCount: 5,
      }),
    ]);
  });

  it("deduplicates identical summaries and is stable across input order", () => {
    const older = conversation("1", {
      updatedAt: "2026-08-28T08:00:00.000Z",
      waitingRunCount: 1,
    });
    const newer = conversation("2", {
      updatedAt: "2026-08-28T09:00:00.000Z",
      activeRun: {
        id: "20000000-0000-4000-8000-000000000002",
        status: "queued",
        startedAt: null,
      },
      attention: {
        runId: "20000000-0000-4000-8000-000000000003",
        terminalEventId: "91",
        status: "failed",
        finishedAt: "2026-08-28T08:59:00.000Z",
      },
    });
    const duplicateNewer = structuredClone(newer);

    const forward = backgroundRunCenterItems([
      older,
      newer,
      duplicateNewer,
    ]);
    const reversed = backgroundRunCenterItems([
      duplicateNewer,
      newer,
      older,
    ]);

    expect(reversed).toEqual(forward);
    expect(forward.map((item) => item.kind)).toEqual([
      "active",
      "waiting",
      "attention",
    ]);
    expect(new Set(forward.map((item) => item.id)).size).toBe(forward.length);
  });

  it("orders equal-priority items by updatedAt descending and conversation id", () => {
    const firstId = conversation("1", { waitingRunCount: 1 });
    const secondId = conversation("2", { waitingRunCount: 1 });
    const newest = conversation("3", {
      updatedAt: "2026-08-28T10:00:00.000Z",
      waitingRunCount: 1,
    });

    expect(
      backgroundRunCenterItems([secondId, newest, firstId]).map(
        (item) => item.conversationId,
      ),
    ).toEqual([newest.id, firstId.id, secondId.id]);
  });

  it("rejects conflicting duplicate summaries instead of choosing a backend value", () => {
    const summary = conversation("1", { waitingRunCount: 1 });

    expect(() =>
      backgroundRunCenterItems([
        summary,
        { ...summary, waitingRunCount: 2 },
      ]),
    ).toThrow(`后台运行中心收到冲突的会话摘要 ${summary.id}`);
  });

  it("opens activity for active and attention items but only the conversation for waiting items", () => {
    const projected = backgroundRunCenterItems([
      conversation("1", {
        activeRun: {
          id: "20000000-0000-4000-8000-000000000001",
          status: "running",
          startedAt: "2026-08-28T08:00:00.000Z",
        },
        waitingRunCount: 2,
        attention: {
          runId: "20000000-0000-4000-8000-000000000002",
          terminalEventId: "84",
          status: "completed",
          finishedAt: "2026-08-28T08:01:00.000Z",
        },
      }),
    ]);

    expect(projected.map(backgroundRunCenterSelection)).toEqual([
      {
        conversationId: projected[0]?.conversationId,
        activityRunId: "20000000-0000-4000-8000-000000000001",
      },
      {
        conversationId: projected[1]?.conversationId,
        activityRunId: null,
      },
      {
        conversationId: projected[2]?.conversationId,
        activityRunId: "20000000-0000-4000-8000-000000000002",
      },
    ]);
  });
});

describe("background run history state", () => {
  const historyItems: readonly BackgroundRunHistoryItem[] = [
    {
      runId: "20000000-0000-4000-8000-000000000001",
      conversationId: "10000000-0000-4000-8000-000000000001",
      conversationTitle: "会话 1",
      status: "completed",
      finishedAt: "2026-08-28T08:01:00.000Z",
    },
    {
      runId: "20000000-0000-4000-8000-000000000002",
      conversationId: "10000000-0000-4000-8000-000000000002",
      conversationTitle: "会话 2",
      status: "failed",
      finishedAt: "2026-08-28T08:00:00.000Z",
    },
  ];

  it("builds fixed first and keyset page requests for the selected status", () => {
    expect(backgroundRunHistoryInitialPageRequest("all")).toEqual({
      status: "all",
      cursor: null,
      limit: backgroundRunHistoryPageSize,
    });
    expect(
      backgroundRunHistoryNextPageRequest("failed", "opaque-cursor"),
    ).toEqual({
      status: "failed",
      cursor: "opaque-cursor",
      limit: backgroundRunHistoryPageSize,
    });
    expect(() =>
      backgroundRunHistoryNextPageRequest("completed", ""),
    ).toThrow("后台任务历史分页 cursor 不能为空字符串");
  });

  it("merges pages by exact Run identity and rejects backend duplicates", () => {
    expect(
      backgroundRunHistoryMergePage([historyItems[0]], [historyItems[1]]),
    ).toEqual(historyItems);
    expect(() => backgroundRunHistoryMergePage([], [historyItems[0], historyItems[0]])).toThrow(
      `后台任务历史分页返回了重复 Run ${historyItems[0].runId}`,
    );
  });

  it("removes active and attention Runs already displayed above history", () => {
    const centerItems = backgroundRunCenterItems([
      conversation("1", {
        activeRun: {
          id: historyItems[0].runId,
          status: "running",
          startedAt: "2026-08-28T08:00:00.000Z",
        },
      }),
      conversation("2", {
        attention: {
          runId: historyItems[1].runId,
          terminalEventId: "84",
          status: "failed",
          finishedAt: historyItems[1].finishedAt,
        },
      }),
    ]);

    expect(
      backgroundRunHistoryWithoutCenterRuns(historyItems, centerItems),
    ).toEqual([]);
  });

  it("loads through hidden pages until one visible history Run is available", async () => {
    const centerItems = backgroundRunCenterItems([
      conversation("1", {
        activeRun: {
          id: historyItems[0].runId,
          status: "running",
          startedAt: "2026-08-28T08:00:00.000Z",
        },
      }),
    ]);
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [historyItems[0]],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        items: [historyItems[1]],
        nextCursor: "cursor-2",
      });

    const page = await loadBackgroundRunHistoryUntilVisible({
      currentItems: [],
      cursor: null,
      centerItems,
      loadPage,
    });

    expect(loadPage.mock.calls).toEqual([[null], ["cursor-1"]]);
    expect(page).toEqual({
      items: historyItems,
      nextCursor: "cursor-2",
    });
    expect(
      backgroundRunHistoryWithoutCenterRuns(page.items, centerItems),
    ).toEqual([historyItems[1]]);
  });

  it("stops automatic history paging when hidden results are exhausted", async () => {
    const centerItems = backgroundRunCenterItems([
      conversation("1", {
        activeRun: {
          id: historyItems[0].runId,
          status: "running",
          startedAt: "2026-08-28T08:00:00.000Z",
        },
      }),
      conversation("2", {
        attention: {
          runId: historyItems[1].runId,
          terminalEventId: "84",
          status: "failed",
          finishedAt: historyItems[1].finishedAt,
        },
      }),
    ]);
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [historyItems[0]],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        items: [historyItems[1]],
        nextCursor: null,
      });

    const page = await loadBackgroundRunHistoryUntilVisible({
      currentItems: [],
      cursor: null,
      centerItems,
      loadPage,
    });

    expect(loadPage.mock.calls).toEqual([[null], ["cursor-1"]]);
    expect(page).toEqual({ items: historyItems, nextCursor: null });
    expect(
      backgroundRunHistoryWithoutCenterRuns(page.items, centerItems),
    ).toEqual([]);
  });

  it("opens the exact conversation and Run activity from a history row", () => {
    expect(backgroundRunHistorySelection(historyItems[0])).toEqual({
      conversationId: historyItems[0].conversationId,
      activityRunId: historyItems[0].runId,
    });
  });

  it.each([
    [{ isLoading: true, loadError: null, itemCount: 0 }, "loading"],
    [{ isLoading: false, loadError: "失败", itemCount: 0 }, "failure"],
    [{ isLoading: false, loadError: null, itemCount: 0 }, "empty"],
    [{ isLoading: false, loadError: null, itemCount: 2 }, "results"],
  ] as const)("maps history request state to %s", (input, expected) => {
    expect(backgroundRunHistoryResultSurface(input)).toBe(expected);
  });

  it("maps only exact API code/status pairs and never exposes backend messages", () => {
    const internalDetails =
      "SELECT * FROM runs at https://internal.example.invalid/history";
    const invalidRequest = new ApiClientError(
      "INVALID_REQUEST",
      internalDetails,
      400,
    );
    const internalError = new ApiClientError(
      "INTERNAL_ERROR",
      internalDetails,
      500,
    );
    const mismatchedPair = new ApiClientError(
      "INVALID_REQUEST",
      internalDetails,
      500,
    );
    const unknownCode = new ApiClientError(
      "UNKNOWN_HISTORY_ERROR",
      internalDetails,
      418,
    );

    expect(backgroundRunHistoryErrorMessage(invalidRequest)).toBe(
      "最近完成任务的请求状态已失效，请重新加载。",
    );
    expect(backgroundRunHistoryErrorMessage(internalError)).toBe(
      "任务历史服务暂时不可用，请稍后重试。",
    );
    expect(backgroundRunHistoryErrorMessage(mismatchedPair)).toBe(
      "暂时无法加载最近完成任务，请重试。",
    );
    expect(backgroundRunHistoryErrorMessage(unknownCode)).toBe(
      "暂时无法加载最近完成任务，请重试。",
    );
    for (const error of [
      invalidRequest,
      internalError,
      mismatchedPair,
      unknownCode,
    ]) {
      expect(backgroundRunHistoryErrorMessage(error)).not.toContain(
        internalDetails,
      );
    }
  });

  it("distinguishes explicit network failures from safe generic client failures", () => {
    const internalDetails =
      "Invalid protocol response from https://internal.example.invalid";

    expect(backgroundRunHistoryErrorMessage(new ApiNetworkError())).toBe(
      "网络连接失败，请检查网络后重试。",
    );
    expect(
      backgroundRunHistoryErrorMessage(new Error(internalDetails)),
    ).toBe("暂时无法加载最近完成任务，请重试。");
    expect(backgroundRunHistoryErrorMessage({ message: internalDetails })).toBe(
      "暂时无法加载最近完成任务，请重试。",
    );
    expect(
      backgroundRunHistoryErrorMessage(new Error(internalDetails)),
    ).not.toContain(internalDetails);
  });
});
