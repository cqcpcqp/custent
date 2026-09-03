import { describe, expect, it } from "vitest";

import {
  dismissRunCompletionNotification,
  dismissRunCompletionNotificationsForConversation,
  emptyRunCompletionNotificationQueue,
  enqueueRunCompletionNotification,
  reconcileRunCompletionNotifications,
  runCompletionOutcomeForEvent,
  type RunCompletionNotification,
} from "@/components/run-completion-notification-state";
import type { ConversationSummary, RunEvent } from "@/lib/contracts";

const completedNotification: RunCompletionNotification = {
  conversationId: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  outcome: "completed",
};

const failedNotification: RunCompletionNotification = {
  conversationId: "10000000-0000-4000-8000-000000000002",
  runId: "20000000-0000-4000-8000-000000000002",
  title: "法国经销商",
  outcome: "failed",
};

const cancelledNotification: RunCompletionNotification = {
  conversationId: "10000000-0000-4000-8000-000000000003",
  runId: "20000000-0000-4000-8000-000000000004",
  title: "美国采购经理",
  outcome: "cancelled",
};

const reconciliationNotification: RunCompletionNotification = {
  conversationId: "10000000-0000-4000-8000-000000000004",
  runId: "20000000-0000-4000-8000-000000000005",
  title: "英国进口商",
  outcome: "reconciliation_required",
};

const earlierCompletedNotification: RunCompletionNotification = {
  ...completedNotification,
  runId: "20000000-0000-4000-8000-000000000003",
  title: "德国泵类买家（首次研究）",
};

const sameRunInAnotherConversation: RunCompletionNotification = {
  ...failedNotification,
  runId: completedNotification.runId,
};

describe("run completion notification state", () => {
  const summary = (
    notification: RunCompletionNotification,
    attentionRunId: string | null,
    status: RunCompletionNotification["outcome"] = "completed",
    finishedAt = "2026-08-27T08:01:00.000Z",
  ): ConversationSummary => ({
    id: notification.conversationId,
    title: notification.title,
    activeRun: null,
    waitingRunCount: 0,
    selectedRunId: notification.runId,
    pinnedAt: null,
    archivedAt: null,
    attention:
      attentionRunId === null
        ? null
        : {
            runId: attentionRunId,
            terminalEventId: "42",
            status,
            finishedAt,
          },
    updatedAt: "2026-08-27T08:00:00.000Z",
  });

  it("removes notifications acknowledged or removed in a server snapshot", () => {
    const queue = [completedNotification, failedNotification];

    expect(
      reconcileRunCompletionNotifications(queue, [
        summary(completedNotification, null),
        summary(failedNotification, failedNotification.runId),
      ]),
    ).toEqual([failedNotification]);
    expect(reconcileRunCompletionNotifications(queue, [])).toEqual([]);
  });

  it("preserves queue identity while every notification remains unread", () => {
    const queue = [completedNotification, failedNotification];

    expect(
      reconcileRunCompletionNotifications(queue, [
        summary(completedNotification, completedNotification.runId),
        summary(failedNotification, failedNotification.runId),
      ]),
    ).toBe(queue);
  });

  it("reconstructs unread terminal notifications from the strict attention contract", () => {
    const conversations = [
      summary(
        reconciliationNotification,
        reconciliationNotification.runId,
        "reconciliation_required",
        "2026-08-27T08:04:00.000Z",
      ),
      summary(
        failedNotification,
        failedNotification.runId,
        "failed",
        "2026-08-27T08:02:00.000Z",
      ),
      summary(
        cancelledNotification,
        cancelledNotification.runId,
        "cancelled",
        "2026-08-27T08:03:00.000Z",
      ),
      summary(
        completedNotification,
        completedNotification.runId,
        "completed",
        "2026-08-27T08:01:00.000Z",
      ),
    ];

    expect(
      reconcileRunCompletionNotifications(
        emptyRunCompletionNotificationQueue,
        conversations,
      ),
    ).toEqual([
      completedNotification,
      failedNotification,
      cancelledNotification,
      reconciliationNotification,
    ]);
  });

  it("does not reconstruct a notification for the visible conversation", () => {
    expect(
      reconcileRunCompletionNotifications(
        emptyRunCompletionNotificationQueue,
        [
          summary(completedNotification, completedNotification.runId),
          summary(failedNotification, failedNotification.runId, "failed"),
        ],
        {
          omitNewForConversationId: completedNotification.conversationId,
        },
      ),
    ).toEqual([failedNotification]);
  });

  it("only reconstructs attention that appeared or changed after the baseline", () => {
    const baseline = [
      summary(
        completedNotification,
        earlierCompletedNotification.runId,
        "completed",
        "2026-08-27T08:01:00.000Z",
      ),
      summary(failedNotification, null),
      summary(
        cancelledNotification,
        cancelledNotification.runId,
        "cancelled",
        "2026-08-27T08:04:00.000Z",
      ),
    ];
    const incoming = [
      summary(
        completedNotification,
        completedNotification.runId,
        "completed",
        "2026-08-27T08:03:00.000Z",
      ),
      summary(
        failedNotification,
        failedNotification.runId,
        "failed",
        "2026-08-27T08:02:00.000Z",
      ),
      summary(
        cancelledNotification,
        cancelledNotification.runId,
        "cancelled",
        "2026-08-27T08:04:00.000Z",
      ),
    ];

    expect(
      reconcileRunCompletionNotifications(
        emptyRunCompletionNotificationQueue,
        incoming,
        { baselineConversations: baseline },
      ),
    ).toEqual([failedNotification, completedNotification]);
  });

  it("treats initial unread attention as a baseline instead of a backlog", () => {
    const initialConversations = [
      summary(completedNotification, completedNotification.runId),
      summary(failedNotification, failedNotification.runId, "failed"),
    ];

    expect(
      reconcileRunCompletionNotifications(
        emptyRunCompletionNotificationQueue,
        initialConversations,
        { baselineConversations: initialConversations },
      ),
    ).toBe(emptyRunCompletionNotificationQueue);
  });

  it("does not reconstruct a Run dismissed during this page session", () => {
    expect(
      reconcileRunCompletionNotifications(
        [completedNotification],
        [summary(completedNotification, completedNotification.runId)],
        {
          baselineConversations: [summary(completedNotification, null)],
          dismissedRunIds: new Set([completedNotification.runId]),
        },
      ),
    ).toEqual([]);
  });

  it("appends distinct Runs in arrival order", () => {
    const firstQueue = enqueueRunCompletionNotification(
      emptyRunCompletionNotificationQueue,
      completedNotification,
    );
    const secondQueue = enqueueRunCompletionNotification(
      firstQueue,
      failedNotification,
    );

    expect(secondQueue).toEqual([completedNotification, failedNotification]);
    expect(emptyRunCompletionNotificationQueue).toEqual([]);
  });

  it("deduplicates a replayed terminal notification by conversation and Run", () => {
    const queue = [completedNotification];
    const replay = {
      ...completedNotification,
      title: "重命名后的标题",
      outcome: "failed" as const,
    };

    expect(enqueueRunCompletionNotification(queue, replay)).toBe(queue);
  });

  it("dismisses only the notification with the exact identity", () => {
    const queue = [
      earlierCompletedNotification,
      completedNotification,
      sameRunInAnotherConversation,
      failedNotification,
    ];

    expect(
      dismissRunCompletionNotification(queue, {
        conversationId: completedNotification.conversationId,
        runId: completedNotification.runId,
      }),
    ).toEqual([
      earlierCompletedNotification,
      sameRunInAnotherConversation,
      failedNotification,
    ]);
    expect(queue).toHaveLength(4);
  });

  it("preserves queue identity when dismissing an unknown notification", () => {
    const queue = [completedNotification];

    expect(
      dismissRunCompletionNotification(queue, {
        conversationId: "10000000-0000-4000-8000-000000000099",
        runId: completedNotification.runId,
      }),
    ).toBe(queue);
  });

  it("dismisses every notification for one conversation and preserves all others", () => {
    const queue = [
      completedNotification,
      sameRunInAnotherConversation,
      earlierCompletedNotification,
      failedNotification,
    ];

    const remaining = dismissRunCompletionNotificationsForConversation(
      queue,
      completedNotification.conversationId,
    );

    expect(remaining).toEqual([
      sameRunInAnotherConversation,
      failedNotification,
    ]);
    expect(remaining[0]).toBe(sameRunInAnotherConversation);
    expect(remaining[1]).toBe(failedNotification);
    expect(queue).toHaveLength(4);
  });

  it("preserves queue identity when the conversation has no notifications", () => {
    const queue = [completedNotification, failedNotification];

    expect(
      dismissRunCompletionNotificationsForConversation(
        queue,
        "10000000-0000-4000-8000-000000000099",
      ),
    ).toBe(queue);
  });

  it("preserves all four exact terminal outcomes", () => {
    const queue = [
      completedNotification,
      failedNotification,
      cancelledNotification,
      reconciliationNotification,
    ];

    expect(queue.map((notification) => notification.outcome)).toEqual([
      "completed",
      "failed",
      "cancelled",
      "reconciliation_required",
    ]);
  });

  it.each([
    ["RUN_CANCELLED", "cancelled"],
    ["RUN_REQUIRES_RECONCILIATION", "reconciliation_required"],
    ["PROVIDER_FAILED", "failed"],
  ] as const)("maps terminal error %s to %s", (code, outcome) => {
    const event: RunEvent = {
      id: "42",
      runId: completedNotification.runId,
      createdAt: "2026-08-27T08:00:00.000Z",
      payload: {
        type: "error",
        error: {
          code,
          message: "结束",
          runId: completedNotification.runId,
        },
      },
    };

    expect(runCompletionOutcomeForEvent(event)).toBe(outcome);
  });

  it("maps done to completed and rejects a non-terminal event", () => {
    const done: RunEvent = {
      id: "42",
      runId: completedNotification.runId,
      createdAt: "2026-08-27T08:00:00.000Z",
      payload: {
        type: "done",
        credits: { available: 88, reserved: 0 },
        message: {
          id: "40000000-0000-4000-8000-000000000001",
          runId: completedNotification.runId,
          role: "assistant",
          content: "完成",
          citations: [],
          artifacts: [],
          attachments: [],
          feedback: null,
          createdAt: "2026-08-27T08:00:00.000Z",
        },
      },
    };
    expect(runCompletionOutcomeForEvent(done)).toBe("completed");
    expect(() =>
      runCompletionOutcomeForEvent({
        ...done,
        payload: {
          type: "status",
          phase: "thinking",
          message: "思考中",
        },
      }),
    ).toThrow("收到的不是终态通知事件");
  });
});
