"use client";

import { useLayoutEffect, useRef } from "react";

import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  StopIcon,
} from "@/components/icons";
import type {
  RunCompletionNotification,
  RunCompletionOutcome,
} from "@/components/run-completion-notification-state";

type RunCompletionNotificationsProps = {
  notifications: readonly RunCompletionNotification[];
  onDismiss: (conversationId: string, runId: string) => void;
  onOpenConversation: (conversationId: string, runId: string) => void;
};

const outcomeLabels: Record<RunCompletionOutcome, string> = {
  completed: "后台研究已完成",
  failed: "后台研究未能完成",
  cancelled: "后台研究已停止",
  reconciliation_required: "后台研究需要核对积分",
};

function notificationAnnouncement(
  notification: RunCompletionNotification,
): string {
  return `“${notification.title}”${outcomeLabels[notification.outcome]}`;
}

function NotificationOutcomeIcon({
  outcome,
}: {
  outcome: RunCompletionOutcome;
}) {
  switch (outcome) {
    case "completed":
      return <CheckIcon />;
    case "cancelled":
      return <StopIcon />;
    case "failed":
    case "reconciliation_required":
      return <AlertIcon />;
  }
}

function LatestRunCompletionNotification({
  latestNotification,
  notificationCount,
  onDismiss,
  onOpenConversation,
}: Omit<RunCompletionNotificationsProps, "notifications"> & {
  latestNotification: RunCompletionNotification;
  notificationCount: number;
}) {
  const remainingNotificationCount = notificationCount - 1;
  const dismissButtonRef = useRef<HTMLButtonElement>(null);
  const focusReplacementAfterDismissRef = useRef(false);
  const announcement =
    remainingNotificationCount === 0
      ? notificationAnnouncement(latestNotification)
      : `${notificationAnnouncement(latestNotification)}，另有 ${remainingNotificationCount} 项可在后台任务中查看`;

  useLayoutEffect(() => {
    if (!focusReplacementAfterDismissRef.current) {
      return;
    }
    focusReplacementAfterDismissRef.current = false;
    dismissButtonRef.current?.focus();
  }, [latestNotification.runId]);

  return (
    <aside
      aria-label="后台运行通知"
      className="run-completion-notifications"
    >
      <p
        aria-atomic="true"
        aria-live="polite"
        className="run-completion-notifications__status visually-hidden"
        role="status"
      >
        {announcement}
      </p>
      <ol
        aria-label={`后台运行通知列表，仅显示最新 1 项，共 ${notificationCount} 项`}
        className="run-completion-notifications__list"
      >
        <li
          className={`run-completion-notification run-completion-notification--${latestNotification.outcome}`}
          key={`${latestNotification.conversationId}:${latestNotification.runId}`}
        >
          <button
            aria-label={`${announcement}，打开对话`}
            className="run-completion-notification__open"
            onClick={() =>
              onOpenConversation(
                latestNotification.conversationId,
                latestNotification.runId,
              )
            }
            type="button"
          >
            <span className="run-completion-notification__icon">
              <NotificationOutcomeIcon outcome={latestNotification.outcome} />
            </span>
            <span className="run-completion-notification__copy">
              <strong>{latestNotification.title}</strong>
              <span>
                {outcomeLabels[latestNotification.outcome]}
                {remainingNotificationCount === 0
                  ? null
                  : ` · 另有 ${remainingNotificationCount} 项`}
              </span>
            </span>
          </button>
          <button
            aria-label={`关闭“${latestNotification.title}”的后台运行通知`}
            className="run-completion-notification__dismiss"
            onClick={() => {
              focusReplacementAfterDismissRef.current =
                remainingNotificationCount > 0;
              onDismiss(
                latestNotification.conversationId,
                latestNotification.runId,
              );
            }}
            ref={dismissButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </li>
      </ol>
    </aside>
  );
}

export function RunCompletionNotifications({
  notifications,
  onDismiss,
  onOpenConversation,
}: RunCompletionNotificationsProps) {
  const latestNotification = notifications.at(-1);
  if (latestNotification === undefined) {
    return null;
  }

  return (
    <LatestRunCompletionNotification
      latestNotification={latestNotification}
      notificationCount={notifications.length}
      onDismiss={onDismiss}
      onOpenConversation={onOpenConversation}
    />
  );
}
