import { describe, expect, it } from "vitest";

import {
  advanceConversationLoadedDepth,
  conversationHasOutstandingRuns,
  conversationOutstandingRunStatus,
  conversationSidebarRunStatus,
  conversationPageLimitToRestoreDepth,
  conversationRecencyGroupKey,
  groupConversationSummariesByRecency,
  mergeBootstrapConversationSummaries,
  mergeConversationPage,
  mergeConversationPageAtRevision,
  mergeConversationSummarySources,
  nextConversationIdAfterRemoteRemoval,
  nextSearchResultIndex,
  removeConversationAndSelectNext,
  removeConversationFromSummarySources,
  removeConversationSummary,
  sortConversationSummaries,
  upsertConversationSummary,
} from "@/components/conversation-list-state";
import type { ConversationSummary } from "@/lib/contracts";

function conversation(
  suffix: string,
  input: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    title: `会话 ${suffix}`,
    updatedAt: "2026-08-24T08:00:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: null,
    activeRun: null,
    waitingRunCount: 0,
    attention: null,
    ...input,
  };
}

describe("conversation list state", () => {
  it("tracks server pagination depth independently from local upserts", () => {
    const loadedDepth = advanceConversationLoadedDepth(0, 30);
    const visibleCountAfterLocalUpsert = 31;

    expect(loadedDepth).toBe(30);
    expect(visibleCountAfterLocalUpsert).toBe(31);
    expect(
      conversationPageLimitToRestoreDepth({
        targetDepth: loadedDepth,
        loadedCount: 30,
        pageSize: 30,
      }),
    ).toBeNull();
  });

  it("restores only the remaining depth instead of overfetching a full page", () => {
    expect(
      conversationPageLimitToRestoreDepth({
        targetDepth: 31,
        loadedCount: 30,
        pageSize: 30,
      }),
    ).toBe(1);
    expect(
      conversationPageLimitToRestoreDepth({
        targetDepth: 75,
        loadedCount: 30,
        pageSize: 30,
      }),
    ).toBe(30);
    expect(advanceConversationLoadedDepth(30, 30)).toBe(60);
  });

  it("严格从 summary 的 active Run 和 waiting 数量识别未完成研究", () => {
    const idle = conversation("1");
    const paused = conversation("2", { waitingRunCount: 2 });
    const active = conversation("3", {
      activeRun: {
        id: "20000000-0000-4000-8000-000000000003",
        status: "running",
        startedAt: "2026-08-24T08:01:00.000Z",
      },
      waitingRunCount: 1,
    });

    expect(conversationOutstandingRunStatus(idle)).toBeNull();
    expect(conversationOutstandingRunStatus(paused)).toBe("waiting");
    expect(conversationOutstandingRunStatus(active)).toBe("running");
    expect(conversationHasOutstandingRuns(idle)).toBe(false);
    expect(conversationHasOutstandingRuns(paused)).toBe(true);
    expect(conversationHasOutstandingRuns(active)).toBe(true);
  });

  it("只用 active、waiting 和未读 attention 生成侧栏运行状态", () => {
    const readTerminal = conversation("1");
    const unreadTerminal = conversation("2", {
      attention: {
        terminalEventId: "42",
        runId: "20000000-0000-4000-8000-000000000002",
        status: "completed",
        finishedAt: "2026-08-24T08:02:00.000Z",
      },
    });
    const waitingWithAttention = conversation("3", {
      waitingRunCount: 1,
      attention: {
        terminalEventId: "43",
        runId: "20000000-0000-4000-8000-000000000003",
        status: "failed",
        finishedAt: "2026-08-24T08:03:00.000Z",
      },
    });
    const activeWithAttention = conversation("4", {
      activeRun: {
        id: "20000000-0000-4000-8000-000000000004",
        status: "queued",
        startedAt: null,
      },
      waitingRunCount: 1,
      attention: {
        terminalEventId: "44",
        runId: "20000000-0000-4000-8000-000000000005",
        status: "cancelled",
        finishedAt: "2026-08-24T08:04:00.000Z",
      },
    });

    expect(conversationSidebarRunStatus(readTerminal)).toBeNull();
    expect(conversationSidebarRunStatus(unreadTerminal)).toBe("completed");
    expect(conversationSidebarRunStatus(waitingWithAttention)).toBe(
      "waiting",
    );
    expect(conversationSidebarRunStatus(activeWithAttention)).toBe("queued");
  });

  it("按 pinnedAt、updatedAt、id 的服务端顺序稳定排序", () => {
    const recent = conversation("1", {
      updatedAt: "2026-08-24T10:00:00.000Z",
    });
    const olderPinned = conversation("2", {
      pinnedAt: "2026-08-24T11:00:00.000Z",
    });
    const newerPinned = conversation("3", {
      pinnedAt: "2026-08-24T12:00:00.000Z",
    });

    expect(
      sortConversationSummaries([recent, olderPinned, newerPinned]).map(
        (item) => item.id,
      ),
    ).toEqual([newerPinned.id, olderPinned.id, recent.id]);
  });

  it("upsert 替换固定字段并重新排序，remove 只移除目标", () => {
    const first = conversation("1");
    const second = conversation("2");
    const pinnedFirst = {
      ...first,
      title: "已重命名",
      pinnedAt: "2026-08-24T12:00:00.000Z",
    };

    const upserted = upsertConversationSummary([second, first], pinnedFirst);
    expect(upserted).toEqual([pinnedFirst, second]);
    expect(removeConversationSummary(upserted, first.id)).toEqual([second]);
  });

  it.each(["archive", "delete"])(
    "本地 %s 同时清理分页与 tracked 摘要，失败或迟到的 revalidation 不会复活目标",
    () => {
      const target = conversation("1", {
        attention: {
          terminalEventId: "42",
          runId: "20000000-0000-4000-8000-000000000001",
          status: "completed",
          finishedAt: "2026-08-24T08:02:00.000Z",
        },
      });
      const other = conversation("2");
      const atRequestStart = {
        conversations: [target, other],
        trackedConversations: [target],
      };
      const locallyRemoved = removeConversationFromSummarySources(
        atRequestStart,
        target.id,
      );
      const revisionsAtRequestStart = new Map([[target.id, 0]]);
      const currentRevisions = new Map([[target.id, 1]]);

      expect(locallyRemoved).toEqual({
        conversations: [other],
        trackedConversations: [],
      });
      expect(
        mergeBootstrapConversationSummaries({
          current: locallyRemoved.conversations,
          incoming: atRequestStart.conversations,
          atRequestStart: atRequestStart.conversations,
          revisionsAtRequestStart,
          currentRevisions,
          preserveIncomingConversationIds: new Set(),
        }),
      ).toEqual([other]);
      expect(
        mergeBootstrapConversationSummaries({
          current: locallyRemoved.trackedConversations,
          incoming: atRequestStart.trackedConversations,
          atRequestStart: atRequestStart.trackedConversations,
          revisionsAtRequestStart,
          currentRevisions,
          preserveIncomingConversationIds: new Set(),
        }),
      ).toEqual([]);
    },
  );

  it("移除当前会话后优先选择其下一项，末项则选择上一项", () => {
    const first = conversation("1");
    const second = conversation("2");
    const third = conversation("3");

    expect(
      removeConversationAndSelectNext([first, second, third], second.id),
    ).toEqual({
      conversations: [first, third],
      nextConversationId: third.id,
    });
    expect(
      removeConversationAndSelectNext([first, second, third], third.id)
        .nextConversationId,
    ).toBe(second.id);
  });

  it("远端移除当前会话后选择仍存在的相邻项，否则回退到当前首项", () => {
    const first = conversation("1");
    const second = conversation("2");
    const third = conversation("3");

    expect(
      nextConversationIdAfterRemoteRemoval({
        previousConversations: [first, second, third],
        currentConversations: [first, third],
        removedConversationId: second.id,
      }),
    ).toBe(third.id);
    expect(
      nextConversationIdAfterRemoteRemoval({
        previousConversations: [first, second, third],
        currentConversations: [first],
        removedConversationId: second.id,
      }),
    ).toBe(first.id);
    expect(
      nextConversationIdAfterRemoteRemoval({
        previousConversations: [first, second, third],
        currentConversations: [],
        removedConversationId: second.id,
      }),
    ).toBeNull();
  });

  it("分页合并会替换重复项但保持服务端页顺序", () => {
    const first = conversation("1");
    const second = conversation("2");
    const renamedSecond = { ...second, title: "新的标题" };
    const third = conversation("3");

    expect(mergeConversationPage([first, second], [renamedSecond, third])).toEqual([
      first,
      renamedSecond,
      third,
    ]);
  });

  it("迟到分页不会覆盖请求期间更新的摘要或复活已删除项", () => {
    const first = conversation("1");
    const second = conversation("2");
    const updatedFirst = {
      ...first,
      activeRun: {
        id: "20000000-0000-4000-8000-000000000001",
        status: "running" as const,
        startedAt: "2026-08-24T08:01:00.000Z",
      },
    };
    const third = conversation("3");

    expect(
      mergeConversationPageAtRevision({
        current: [updatedFirst],
        incoming: [first, second, third],
        atRequestStart: [first, second],
        revisionsAtRequestStart: new Map([
          [first.id, 0],
          [second.id, 0],
        ]),
        currentRevisions: new Map([
          [first.id, 1],
          [second.id, 1],
        ]),
      }),
    ).toEqual(sortConversationSummaries([updatedFirst, third]));
  });

  it("合并可见页与后台观察摘要时由可见页覆盖重复项", () => {
    const visible = conversation("1", { title: "可见页的新摘要" });
    const trackedCopy = conversation("1", { title: "后台旧摘要" });
    const trackedOnly = conversation("2", { waitingRunCount: 1 });

    expect(
      mergeConversationSummarySources([visible], [trackedCopy, trackedOnly]),
    ).toEqual(sortConversationSummaries([visible, trackedOnly]));
  });

  it("旧 bootstrap 不会覆盖请求期间更新、新增或删除的会话摘要", () => {
    const first = conversation("1");
    const second = conversation("2");
    const added = conversation("3", {
      selectedRunId: "20000000-0000-4000-8000-000000000003",
    });
    const updatedFirst = {
      ...first,
      selectedRunId: "20000000-0000-4000-8000-000000000001",
      activeRun: {
        id: "20000000-0000-4000-8000-000000000001",
        status: "queued" as const,
        startedAt: null,
      },
    };

    expect(
      mergeBootstrapConversationSummaries({
        current: [updatedFirst, added],
        incoming: [first, second],
        atRequestStart: [first, second],
        revisionsAtRequestStart: new Map([
          [first.id, 0],
          [second.id, 0],
        ]),
        currentRevisions: new Map([
          [first.id, 1],
          [second.id, 1],
          [added.id, 1],
        ]),
        preserveIncomingConversationIds: new Set(),
      }),
    ).toEqual(sortConversationSummaries([updatedFirst, added]));
  });

  it("详情刷新失败时保留当前兼容摘要而不应用不兼容的 bootstrap 摘要", () => {
    const current = conversation("1", {
      selectedRunId: "20000000-0000-4000-8000-000000000001",
    });
    const incoming = {
      ...current,
      selectedRunId: "20000000-0000-4000-8000-000000000002",
    };

    expect(
      mergeBootstrapConversationSummaries({
        current: [current],
        incoming: [incoming],
        atRequestStart: [current],
        revisionsAtRequestStart: new Map([[current.id, 0]]),
        currentRevisions: new Map([[current.id, 0]]),
        preserveIncomingConversationIds: new Set([current.id]),
      }),
    ).toEqual([current]);
  });

  it("按本地日历边界分入今天、昨天、过去 7 天、过去 30 天和更早", () => {
    const now = new Date(2026, 7, 27, 12, 0, 0);
    const atDaysAgo = (daysAgo: number) => {
      const value = new Date(now);
      value.setDate(value.getDate() - daysAgo);
      return value.toISOString();
    };

    expect(conversationRecencyGroupKey(atDaysAgo(0), now)).toBe("today");
    expect(conversationRecencyGroupKey(atDaysAgo(1), now)).toBe("yesterday");
    expect(conversationRecencyGroupKey(atDaysAgo(2), now)).toBe(
      "previous_7_days",
    );
    expect(conversationRecencyGroupKey(atDaysAgo(7), now)).toBe(
      "previous_7_days",
    );
    expect(conversationRecencyGroupKey(atDaysAgo(8), now)).toBe(
      "previous_30_days",
    );
    expect(conversationRecencyGroupKey(atDaysAgo(30), now)).toBe(
      "previous_30_days",
    );
    expect(conversationRecencyGroupKey(atDaysAgo(31), now)).toBe("older");
  });

  it("只返回非空时间组，并保持每组内既有的会话顺序", () => {
    const now = new Date(2026, 7, 27, 12, 0, 0);
    const today = conversation("1", {
      updatedAt: new Date(2026, 7, 27, 10, 0, 0).toISOString(),
    });
    const recentFirst = conversation("2", {
      updatedAt: new Date(2026, 7, 24, 10, 0, 0).toISOString(),
    });
    const recentSecond = conversation("3", {
      updatedAt: new Date(2026, 7, 22, 10, 0, 0).toISOString(),
    });
    const older = conversation("4", {
      updatedAt: new Date(2026, 6, 20, 10, 0, 0).toISOString(),
    });

    expect(
      groupConversationSummariesByRecency(
        [today, recentFirst, recentSecond, older],
        now,
      ),
    ).toEqual([
      { key: "today", label: "今天", conversations: [today] },
      {
        key: "previous_7_days",
        label: "过去 7 天",
        conversations: [recentFirst, recentSecond],
      },
      { key: "older", label: "更早", conversations: [older] },
    ]);
  });
});

describe("search keyboard navigation", () => {
  it("上下键从未选择状态进入结果并在边界停止", () => {
    expect(nextSearchResultIndex(-1, 3, "down")).toBe(0);
    expect(nextSearchResultIndex(0, 3, "down")).toBe(1);
    expect(nextSearchResultIndex(2, 3, "down")).toBe(2);
    expect(nextSearchResultIndex(-1, 3, "up")).toBe(2);
    expect(nextSearchResultIndex(2, 3, "up")).toBe(1);
    expect(nextSearchResultIndex(0, 3, "up")).toBe(0);
    expect(nextSearchResultIndex(0, 0, "down")).toBe(-1);
  });
});
