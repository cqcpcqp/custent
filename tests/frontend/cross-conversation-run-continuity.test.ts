import { describe, expect, it } from "vitest";

import { backgroundRunCenterItems } from "@/components/background-run-center-state";
import {
  upsertConversationSummary,
} from "@/components/conversation-list-state";
import { buildActivityItems } from "@/components/run-activity";
import {
  dismissRunCompletionNotificationsForConversation,
  emptyRunCompletionNotificationQueue,
  enqueueRunCompletionNotification,
  reconcileRunCompletionNotifications,
  runCompletionOutcomeForEvent,
} from "@/components/run-completion-notification-state";
import {
  RunEventFrameBuffer,
  type BufferedRunEvent,
} from "@/components/run-event-buffer";
import {
  activeRunSubscriptionRole,
  runSubscriptionCommitsEvents,
  runSubscriptionRole,
} from "@/components/run-subscription-policy";
import {
  conversationStateReducer,
  conversationStateShowsTerminalResult,
  conversationSummaryAtReadWatermark,
  createConversationViewState,
  eventsForRun,
  loadedRunSubscriptionRequests,
  runEventSubscriptionMode,
  type ConversationStateMap,
} from "@/components/research-workspace-state";
import { mergeTerminalConversationSummary } from "@/components/terminal-refresh";
import type {
  AgentRun,
  ChatMessage,
  ConversationSummary,
  RunEvent,
} from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const conversationA = "10000000-0000-4000-8000-000000000001";
const conversationB = "10000000-0000-4000-8000-000000000002";
const runA = "20000000-0000-4000-8000-000000000001";

function message(input: {
  id: string;
  role: ChatMessage["role"];
  content: string;
  createdAt: string;
}): ChatMessage {
  return {
    ...input,
    runId: runA,
    citations: [],
    artifacts: [],
    attachments: [],
    feedback: null,
  };
}

function event(
  id: string,
  payload: RunEvent["payload"],
): RunEvent {
  return {
    id,
    runId: runA,
    createdAt: `2026-08-29T08:00:${id.padStart(2, "0")}.000Z`,
    payload,
  };
}

function observation(runEvent: RunEvent): BufferedRunEvent {
  return { event: runEvent, feedbackDataRevision: 1 };
}

function conversation(
  id: string,
  title: string,
  input: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title,
    updatedAt: "2026-08-29T08:00:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: id === conversationA ? runA : null,
    activeRun: null,
    waitingRunCount: 0,
    attention: null,
    ...input,
  };
}

describe("cross-conversation run continuity", () => {
  it("keeps A running in the background, notifies once, then replays every uncommitted activity exactly once", () => {
    const inputMessage = message({
      id: "40000000-0000-4000-8000-000000000001",
      role: "user",
      content: "寻找德国泵类采购经理",
      createdAt: "2026-08-29T08:00:00.000Z",
    });
    const assistantMessage = message({
      id: "50000000-0000-4000-8000-000000000001",
      role: "assistant",
      content: "已整理德国目标买家。",
      createdAt: "2026-08-29T08:00:05.000Z",
    });
    const runningRun: AgentRun = {
      id: runA,
      requestId: "30000000-0000-4000-8000-000000000001",
      conversationId: conversationA,
      inputMessageId: inputMessage.id,
      assistantMessageId: assistantMessage.id,
      status: "running",
      conversationTurn: "1",
      attemptIndex: 1,
      predecessorRunId: null,
      retryOfRunId: null,
      regenerateOfRunId: null,
      executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
      failure: null,
      createdAt: "2026-08-29T08:00:00.000Z",
      startedAt: "2026-08-29T08:00:01.000Z",
      finishedAt: null,
      cancelRequestedAt: null,
    };
    const committedStatus = event("1", {
      type: "status",
      phase: "thinking",
      message: "正在分析目标市场",
    });
    const backgroundEvents = [
      event("2", {
        type: "reasoning",
        itemId: "buyer-screening",
        summaryIndex: 0,
        providerSequence: 0,
        text: "先筛选有进口记录的公司。",
      }),
      event("3", {
        type: "web_search",
        callId: "search-buyers",
        phase: "searching",
        outputIndex: 0,
        providerSequence: 0,
        action: {
          type: "search",
          query: "German pump distributors purchasing manager",
          queries: ["German pump distributors purchasing manager"],
          sources: [],
        },
      }),
      event("4", {
        type: "web_search",
        callId: "search-buyers",
        phase: "completed",
        outputIndex: 0,
        providerSequence: 1,
        action: {
          type: "search",
          query: "German pump distributors purchasing manager",
          queries: ["German pump distributors purchasing manager"],
          sources: [{ type: "url", url: "https://example.com/buyer" }],
        },
      }),
      event("5", {
        type: "done",
        message: assistantMessage,
        credits: { available: 9_500, reserved: 0 },
      }),
    ] as const;
    const doneEvent = backgroundEvents[3];

    let states: ConversationStateMap = {
      [conversationA]: {
        ...createConversationViewState(),
        messages: [inputMessage],
        runs: [runningRun],
        isLoaded: true,
      },
      [conversationB]: {
        ...createConversationViewState(),
        isLoaded: true,
      },
    };
    states = conversationStateReducer(states, {
      type: "run_events_received",
      conversationId: conversationA,
      observations: [observation(committedStatus)],
    });

    let summaries = [
      conversation(conversationA, "德国泵类买家", {
        activeRun: {
          id: runA,
          status: "running",
          startedAt: runningRun.startedAt,
        },
      }),
      conversation(conversationB, "法国经销商"),
    ];
    const flushedEventIds: string[][] = [];
    let nextFrameHandle = 1;
    const frames = new Map<number, () => void>();
    const buffer = new RunEventFrameBuffer({
      runId: runA,
      initialCommittedEventId: committedStatus.id,
      requestFrame(callback) {
        const handle = nextFrameHandle;
        nextFrameHandle += 1;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame(handle) {
        frames.delete(handle);
      },
      onFlush(observations) {
        flushedEventIds.push(
          observations.map(({ event: runEvent }) => runEvent.id),
        );
        states = conversationStateReducer(states, {
          type: "run_events_received",
          conversationId: conversationA,
          observations,
        });
        return true;
      },
    });

    const foregroundRole = activeRunSubscriptionRole({
      conversationId: conversationA,
      activeConversationId: conversationA,
      visibilityState: "visible",
    });
    expect(foregroundRole).toBe("foreground_follow");
    if (foregroundRole === null) {
      throw new Error("当前可见会话缺少 foreground follow");
    }
    expect(runSubscriptionCommitsEvents(foregroundRole)).toBe(true);
    expect(buffer.beginSubscription()).toBe("1");

    const backgroundRole = activeRunSubscriptionRole({
      conversationId: conversationA,
      activeConversationId: conversationB,
      visibilityState: "visible",
    });
    expect(backgroundRole).toBeNull();
    buffer.discardPending();

    expect(buffer.snapshot()).toEqual({
      observedEventId: "1",
      committedEventId: "1",
    });
    expect(flushedEventIds).toEqual([]);
    expect(eventsForRun(states[conversationA], runA)).toEqual([
      committedStatus,
    ]);
    expect(
      states[conversationA].messages.filter(
        (candidate) => candidate.id === assistantMessage.id,
      ),
    ).toHaveLength(0);

    const activeSummary = summaries.find(
      (summary) => summary.id === conversationA,
    );
    if (activeSummary === undefined) {
      throw new Error("测试缺少会话 A 摘要");
    }
    const terminalSummary: ConversationSummary = {
      ...activeSummary,
      updatedAt: doneEvent.createdAt,
      activeRun: null,
      attention: {
        runId: runA,
        terminalEventId: doneEvent.id,
        status: "completed",
        finishedAt: doneEvent.createdAt,
      },
    };
    summaries = upsertConversationSummary(
      summaries,
      mergeTerminalConversationSummary(activeSummary, terminalSummary, runA),
    );

    const notification = {
      conversationId: conversationA,
      runId: runA,
      title: terminalSummary.title,
      outcome: runCompletionOutcomeForEvent(doneEvent),
    } as const;
    let notifications = enqueueRunCompletionNotification(
      emptyRunCompletionNotificationQueue,
      notification,
    );
    notifications = enqueueRunCompletionNotification(
      notifications,
      notification,
    );
    notifications = reconcileRunCompletionNotifications(
      notifications,
      summaries,
    );
    notifications = reconcileRunCompletionNotifications(
      notifications,
      summaries,
    );

    expect(notifications).toEqual([notification]);
    expect(
      backgroundRunCenterItems(summaries).filter(
        (item) => item.kind === "attention",
      ),
    ).toEqual([
      expect.objectContaining({
        conversationId: conversationA,
        runId: runA,
        terminalEventId: doneEvent.id,
        status: "completed",
      }),
    ]);

    const completedRun: AgentRun = {
      ...runningRun,
      assistantMessageId: assistantMessage.id,
      status: "completed",
      failure: null,
      finishedAt: doneEvent.createdAt,
    };
    const replayRequests = loadedRunSubscriptionRequests(
      states[conversationA],
      [completedRun],
      runA,
      new Map(),
    );
    expect(replayRequests).toEqual([
      {
        run: completedRun,
        existingEvents: [committedStatus],
        intent: "activity",
      },
    ]);
    expect(
      runEventSubscriptionMode(
        completedRun,
        replayRequests[0].existingEvents,
        "not_loaded",
      ),
    ).toBe("replay_once");

    states = conversationStateReducer(states, {
      type: "load_succeeded",
      conversationId: conversationA,
      detail: {
        conversation: terminalSummary,
        messages: [inputMessage, assistantMessage],
        runs: [completedRun],
      },
      feedbackDataRevision: 2,
    });
    expect(states[conversationA].runs).toEqual([completedRun]);
    expect(
      states[conversationA].messages.filter(
        (candidate) => candidate.id === assistantMessage.id,
      ),
    ).toHaveLength(1);

    const replayRole = runSubscriptionRole({
      mode: "replay_once",
      conversationId: conversationA,
      activeConversationId: conversationA,
      visibilityState: "visible",
    });
    expect(replayRole).toBe("replay_once");
    if (replayRole === null) {
      throw new Error("显式活动恢复缺少 replay_once");
    }
    expect(buffer.beginSubscription()).toBe("1");
    expect(buffer.snapshot()).toEqual({
      observedEventId: "1",
      committedEventId: "1",
    });
    for (const runEvent of backgroundEvents) {
      buffer.observe(
        observation(runEvent),
        runSubscriptionCommitsEvents(replayRole),
      );
    }

    expect(frames.size).toBe(0);
    expect(flushedEventIds).toEqual([["2", "3", "4", "5"]]);
    expect(buffer.snapshot()).toEqual({
      observedEventId: "5",
      committedEventId: "5",
    });
    const replayedEvents = eventsForRun(states[conversationA], runA);
    expect(replayedEvents.map((runEvent) => runEvent.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    expect(
      replayedEvents.filter(
        (runEvent) =>
          runEvent.payload.type === "done" ||
          runEvent.payload.type === "error",
      ),
    ).toEqual([doneEvent]);
    expect(
      states[conversationA].messages.filter(
        (candidate) => candidate.id === assistantMessage.id,
      ),
    ).toHaveLength(1);
    expect(
      buildActivityItems(replayedEvents).map((item) => item.key),
    ).toEqual([
      "event:1",
      "reasoning:buyer-screening:0",
      "web_search:search-buyers",
      "event:5",
    ]);
    expect(
      conversationStateShowsTerminalResult(
        states[conversationA],
        runA,
        doneEvent.id,
      ),
    ).toBe(true);
    expect(
      enqueueRunCompletionNotification(notifications, notification),
    ).toBe(notifications);

    const readSummary = conversationSummaryAtReadWatermark(
      terminalSummary,
      doneEvent.id,
    );
    summaries = upsertConversationSummary(summaries, readSummary);
    notifications = dismissRunCompletionNotificationsForConversation(
      notifications,
      conversationA,
    );
    expect(readSummary.attention).toBeNull();
    expect(notifications).toEqual([]);
    expect(backgroundRunCenterItems(summaries)).toEqual([]);
  });
});
