export const workspaceCrossTabChannelName =
  "custent-workspace-cross-tab-v1";

export const workspaceBootstrapChangedMessage = {
  type: "bootstrap_changed",
  version: 1,
} as const;

export type WorkspaceCrossTabMessage =
  typeof workspaceBootstrapChangedMessage;

export type BootstrapRevalidationRequestKind =
  | "full"
  | "background_poll";

export type BootstrapRevalidationQueueState = {
  requested: BootstrapRevalidationRequestKind | null;
  consecutiveFailures: number;
};

export const initialBootstrapRevalidationQueueState:
  BootstrapRevalidationQueueState = {
    requested: null,
    consecutiveFailures: 0,
  };

function higherPriorityBootstrapRevalidationRequest(
  left: BootstrapRevalidationRequestKind,
  right: BootstrapRevalidationRequestKind,
): BootstrapRevalidationRequestKind {
  return left === "full" || right === "full" ? "full" : "background_poll";
}

export function requestBootstrapRevalidation(
  state: BootstrapRevalidationQueueState,
  requestKind: BootstrapRevalidationRequestKind,
): BootstrapRevalidationQueueState {
  if (state.requested === null) {
    return { ...state, requested: requestKind };
  }
  const requested = higherPriorityBootstrapRevalidationRequest(
    state.requested,
    requestKind,
  );
  return requested === state.requested ? state : { ...state, requested };
}

export function planBootstrapRevalidationRequest(input: {
  state: BootstrapRevalidationQueueState;
  requestKind: BootstrapRevalidationRequestKind;
  bootstrapIsReady: boolean;
  hasScheduledOrRunningRequest: boolean;
}): {
  state: BootstrapRevalidationQueueState;
  shouldSchedule: boolean;
} {
  const state = requestBootstrapRevalidation(
    input.state,
    input.requestKind,
  );
  return {
    state,
    shouldSchedule:
      input.bootstrapIsReady && !input.hasScheduledOrRunningRequest,
  };
}

export function beginBootstrapRevalidation(
  state: BootstrapRevalidationQueueState,
): BootstrapRevalidationQueueState {
  if (state.requested === null) {
    throw new Error("没有待处理的 bootstrap revalidation 请求");
  }
  return { ...state, requested: null };
}

export function settleBootstrapRevalidation(
  state: BootstrapRevalidationQueueState,
  requestKind: BootstrapRevalidationRequestKind,
  outcome: "success" | "retryable_failure" | "ignored",
): BootstrapRevalidationQueueState {
  if (outcome !== "retryable_failure") {
    return { ...state, consecutiveFailures: 0 };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (!Number.isSafeInteger(consecutiveFailures)) {
    throw new Error("bootstrap revalidation 重试次数超出安全整数范围");
  }
  return {
    ...requestBootstrapRevalidation(state, requestKind),
    consecutiveFailures,
  };
}

export function isWorkspaceCrossTabMessage(
  value: unknown,
): value is WorkspaceCrossTabMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === workspaceBootstrapChangedMessage.type &&
    candidate.version === workspaceBootstrapChangedMessage.version
  );
}
