import type { RunEventConnectionMode } from "@/components/run-event-connection-state";

export type RunSubscriptionIntent = "active" | "activity";

export type RunSubscriptionRole = "foreground_follow" | "replay_once";

export type RunEventStreamSubscriptionRole = RunSubscriptionRole;

export type RunSubscriptionRoleTransition =
  | "retain"
  | "preserve_terminal_follow_up"
  | "restart";

export function activeRunSubscriptionRole(input: {
  conversationId: string;
  activeConversationId: string | null;
  visibilityState: DocumentVisibilityState;
}): Extract<RunEventStreamSubscriptionRole, "foreground_follow"> | null {
  return input.conversationId === input.activeConversationId &&
    input.visibilityState === "visible"
    ? "foreground_follow"
    : null;
}

export function runSubscriptionRole(input: {
  mode: RunEventConnectionMode;
  conversationId: string;
  activeConversationId: string | null;
  visibilityState: DocumentVisibilityState;
}): RunEventStreamSubscriptionRole | null {
  if (input.mode === "replay_once") {
    return "replay_once";
  }
  return activeRunSubscriptionRole(input);
}

export function runSubscriptionUsesEventStream(
  role: RunSubscriptionRole | null,
): role is RunEventStreamSubscriptionRole {
  return role === "foreground_follow" || role === "replay_once";
}

export function runSubscriptionCommitsEvents(
  role: RunEventStreamSubscriptionRole,
): boolean {
  return runSubscriptionUsesEventStream(role);
}

export function runSubscriptionPresentsConnectionState(
  role: RunEventStreamSubscriptionRole,
): boolean {
  return runSubscriptionUsesEventStream(role);
}

export function connectionModeForRunSubscriptionRole(
  role: RunEventStreamSubscriptionRole,
): RunEventConnectionMode {
  return role === "replay_once" ? "replay_once" : "follow";
}

export function runSubscriptionRoleTransition(input: {
  currentRole: RunEventStreamSubscriptionRole;
  nextRole: RunEventStreamSubscriptionRole | null;
  terminalEventReceived: boolean;
}): RunSubscriptionRoleTransition {
  if (input.currentRole === input.nextRole) {
    return "retain";
  }
  return input.terminalEventReceived
    ? "preserve_terminal_follow_up"
    : "restart";
}

export function backgroundRunBootstrapObservationRequired(input: {
  conversations: readonly Readonly<{
    id: string;
    activeRun: Readonly<{ id: string }> | null;
  }>[];
  activeConversationId: string | null;
  visibilityState: DocumentVisibilityState;
}): boolean {
  return input.conversations.some(
    (conversation) =>
      conversation.activeRun !== null &&
      (input.visibilityState !== "visible" ||
        conversation.id !== input.activeConversationId),
  );
}

export function markCurrentRunSubscriptionTerminalEvent(input: {
  current:
    | {
        controller: AbortController;
        terminalEventReceived: boolean;
      }
    | undefined;
  controller: AbortController;
}): boolean {
  if (input.current?.controller !== input.controller) {
    return false;
  }
  input.current.terminalEventReceived = true;
  return true;
}

export function releaseCurrentTerminalRunSubscription<
  Subscription extends {
    controller: AbortController;
    terminalEventReceived: boolean;
  },
>(input: {
  subscriptions: Map<string, Subscription>;
  runId: string;
  controller: AbortController;
}): boolean {
  const current = input.subscriptions.get(input.runId);
  if (
    current?.controller !== input.controller ||
    !current.terminalEventReceived
  ) {
    return false;
  }

  input.subscriptions.delete(input.runId);
  input.controller.abort();
  return true;
}
