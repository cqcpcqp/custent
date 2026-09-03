import type { ConversationSummary, RunEvent } from "@/lib/contracts";

export type RunCompletionOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "reconciliation_required";

export type RunCompletionNotification = Readonly<{
  conversationId: string;
  runId: string;
  title: string;
  outcome: RunCompletionOutcome;
}>;

export type RunCompletionNotificationQueue = readonly RunCompletionNotification[];

export const emptyRunCompletionNotificationQueue: RunCompletionNotificationQueue =
  [];

export function runCompletionOutcomeForEvent(
  event: RunEvent,
): RunCompletionOutcome {
  if (event.payload.type === "done") {
    return "completed";
  }
  if (event.payload.type !== "error") {
    throw new TypeError(`Run ${event.runId} 收到的不是终态通知事件`);
  }
  if (event.payload.error.code === "RUN_CANCELLED") {
    return "cancelled";
  }
  if (event.payload.error.code === "RUN_REQUIRES_RECONCILIATION") {
    return "reconciliation_required";
  }
  return "failed";
}

function isSameRunCompletionNotification(
  left: RunCompletionNotification,
  right: Pick<RunCompletionNotification, "conversationId" | "runId">,
): boolean {
  return (
    left.conversationId === right.conversationId && left.runId === right.runId
  );
}

export function enqueueRunCompletionNotification(
  queue: RunCompletionNotificationQueue,
  notification: RunCompletionNotification,
): RunCompletionNotificationQueue {
  if (
    queue.some((queuedNotification) =>
      isSameRunCompletionNotification(queuedNotification, notification),
    )
  ) {
    return queue;
  }

  return [...queue, notification];
}

export function dismissRunCompletionNotification(
  queue: RunCompletionNotificationQueue,
  identity: Pick<RunCompletionNotification, "conversationId" | "runId">,
): RunCompletionNotificationQueue {
  const index = queue.findIndex((notification) =>
    isSameRunCompletionNotification(notification, identity),
  );
  if (index === -1) {
    return queue;
  }

  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}

export function dismissRunCompletionNotificationsForConversation(
  queue: RunCompletionNotificationQueue,
  conversationId: RunCompletionNotification["conversationId"],
): RunCompletionNotificationQueue {
  const remainingNotifications = queue.filter(
    (notification) => notification.conversationId !== conversationId,
  );
  return remainingNotifications.length === queue.length
    ? queue
    : remainingNotifications;
}

export function reconcileRunCompletionNotifications(
  queue: RunCompletionNotificationQueue,
  conversations: readonly ConversationSummary[],
  options: Readonly<{
    baselineConversations?: readonly ConversationSummary[];
    dismissedRunIds?: ReadonlySet<string>;
    omitNewForConversationId?: string | null;
  }> = {},
): RunCompletionNotificationQueue {
  const attentionByConversationId = new Map(
    conversations.map((conversation) => [
      conversation.id,
      conversation.attention,
    ]),
  );
  const baselineAttentionByConversationId =
    options.baselineConversations === undefined
      ? null
      : new Map(
          options.baselineConversations.map((conversation) => [
            conversation.id,
            conversation.attention,
          ]),
        );
  const remainingNotifications = queue.filter((notification) => {
    const attention = attentionByConversationId.get(
      notification.conversationId,
    );
    return (
      attention?.runId === notification.runId &&
      options.dismissedRunIds?.has(notification.runId) !== true
    );
  });
  const reconstructedNotifications = conversations
    .flatMap((conversation) =>
      conversation.attention === null
        ? []
        : [{ attention: conversation.attention, conversation }],
    )
    .filter(
      ({ attention, conversation }) =>
        conversation.id !== options.omitNewForConversationId &&
        options.dismissedRunIds?.has(attention.runId) !== true &&
        (baselineAttentionByConversationId === null ||
          baselineAttentionByConversationId.get(conversation.id)?.runId !==
            attention.runId ||
          baselineAttentionByConversationId.get(conversation.id)
            ?.terminalEventId !== attention.terminalEventId) &&
        !remainingNotifications.some((notification) =>
          isSameRunCompletionNotification(notification, {
            conversationId: conversation.id,
            runId: attention.runId,
          }),
        ),
    )
    .sort((left, right) =>
      left.attention.finishedAt.localeCompare(right.attention.finishedAt),
    )
    .map<RunCompletionNotification>(({ attention, conversation }) => {
      return {
        conversationId: conversation.id,
        runId: attention.runId,
        title: conversation.title,
        outcome: attention.status,
      };
    });

  if (
    remainingNotifications.length === queue.length &&
    reconstructedNotifications.length === 0
  ) {
    return queue;
  }
  return [...remainingNotifications, ...reconstructedNotifications];
}
