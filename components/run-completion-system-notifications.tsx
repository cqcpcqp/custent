"use client";

import { useEffect, useRef } from "react";

import {
  browserRunCompletionNotificationLedgerLockName,
  browserRunCompletionNotificationLedgerProbeStorageKey,
  browserRunCompletionNotificationLedgerStorageKey,
  browserRunCompletionNotificationPreferenceStorageKey,
  coordinateRunCompletionSystemNotification,
  probeBrowserRunCompletionNotificationStorageWrite,
  readBrowserRunCompletionNotificationStorage,
  runCompletionNotificationIdentity,
  writeBrowserRunCompletionNotificationStorage,
} from "@/components/browser-run-completion-notification-state";
import type {
  RunCompletionNotification,
  RunCompletionOutcome,
} from "@/components/run-completion-notification-state";

type RunCompletionSystemNotificationsProps = Readonly<{
  notifications: readonly RunCompletionNotification[];
  onOpenConversation: (conversationId: string, runId: string) => void;
}>;

export type RunCompletionSystemNotificationPresentation = Readonly<{
  options: NotificationOptions;
  title: string;
}>;

const systemNotificationTitles: Record<RunCompletionOutcome, string> = {
  completed: "后台研究已完成",
  failed: "后台研究未能完成",
  cancelled: "后台研究已停止",
  reconciliation_required: "后台研究需要核对积分",
};

function systemNotificationsAreSupported(): boolean {
  return (
    typeof window.Notification === "function" &&
    typeof window.navigator.locks?.request === "function"
  );
}

export function runCompletionSystemNotificationPresentation(
  notification: RunCompletionNotification,
): RunCompletionSystemNotificationPresentation {
  return {
    title: systemNotificationTitles[notification.outcome],
    options: {
      body: `“${notification.title}”`,
      lang: "zh-CN",
      tag: `custent:run-completion:${runCompletionNotificationIdentity(
        notification,
      )}`,
    },
  };
}

export function RunCompletionSystemNotifications({
  notifications,
  onOpenConversation,
}: RunCompletionSystemNotificationsProps) {
  const observedNotificationIdsRef = useRef(new Set<string>());
  const onOpenConversationRef = useRef(onOpenConversation);
  const isMountedRef = useRef(true);

  useEffect(() => {
    onOpenConversationRef.current = onOpenConversation;
  }, [onOpenConversation]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!systemNotificationsAreSupported()) {
      return;
    }

    for (const notification of notifications) {
      const identity = runCompletionNotificationIdentity(notification);
      if (observedNotificationIdsRef.current.has(identity)) {
        continue;
      }
      observedNotificationIdsRef.current.add(identity);

      void coordinateRunCompletionSystemNotification(notification, {
        deliverNotification: () => {
          if (!isMountedRef.current) {
            return null;
          }

          const presentation =
            runCompletionSystemNotificationPresentation(notification);
          const systemNotification = new window.Notification(
            presentation.title,
            presentation.options,
          );
          try {
            systemNotification.addEventListener("click", () => {
              systemNotification.close();
              window.focus();
              onOpenConversationRef.current(
                notification.conversationId,
                notification.runId,
              );
            });
          } catch (error) {
            systemNotification.close();
            throw error;
          }
          return { rollback: () => systemNotification.close() };
        },
        probeLedgerWrite: (serializedLedger) =>
          probeBrowserRunCompletionNotificationStorageWrite(
            () => window.localStorage,
            browserRunCompletionNotificationLedgerProbeStorageKey,
            serializedLedger,
          ),
        readLedger: () =>
          readBrowserRunCompletionNotificationStorage(
            () => window.localStorage,
            browserRunCompletionNotificationLedgerStorageKey,
          ),
        readPermission: () => window.Notification.permission,
        readPreference: () =>
          readBrowserRunCompletionNotificationStorage(
            () => window.localStorage,
            browserRunCompletionNotificationPreferenceStorageKey,
          ),
        runExclusive: (operation) =>
          window.navigator.locks.request(
            browserRunCompletionNotificationLedgerLockName,
            { mode: "exclusive" },
            () => operation(),
          ),
        writeLedger: (serializedLedger) =>
          writeBrowserRunCompletionNotificationStorage(
            () => window.localStorage,
            browserRunCompletionNotificationLedgerStorageKey,
            serializedLedger,
          ),
      })
        .then((outcome) => {
          if (
            outcome === "not_delivered" ||
            outcome === "storage_unavailable"
          ) {
            observedNotificationIdsRef.current.delete(identity);
          }
        })
        .catch(() => {
          observedNotificationIdsRef.current.delete(identity);
        });
    }
  }, [notifications]);

  return null;
}
