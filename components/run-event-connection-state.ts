export type RunEventConnectionMode = "follow" | "replay_once";

export type RunEventConnectionState =
  | { phase: "idle" }
  | { phase: "connecting"; mode: RunEventConnectionMode }
  | { phase: "connected"; mode: RunEventConnectionMode }
  | {
      phase: "reconnecting";
      mode: RunEventConnectionMode;
      attempt: number;
      retryDelayMs: number;
    }
  | {
      phase: "failed";
      mode: RunEventConnectionMode;
      message: string;
    };

export const idleRunEventConnectionState: RunEventConnectionState = {
  phase: "idle",
};

export function reconnectingRunEventConnectionState(input: {
  mode: RunEventConnectionMode;
  attempt: number;
  retryDelayMs: number;
}): RunEventConnectionState {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new TypeError("attempt must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.retryDelayMs) || input.retryDelayMs < 0) {
    throw new TypeError("retryDelayMs must be a non-negative safe integer");
  }
  return { phase: "reconnecting", ...input };
}

export function sameRunEventConnectionState(
  left: RunEventConnectionState,
  right: RunEventConnectionState,
): boolean {
  if (left.phase !== right.phase) {
    return false;
  }
  switch (left.phase) {
    case "idle":
      return true;
    case "connecting":
    case "connected":
      return right.phase === left.phase && right.mode === left.mode;
    case "reconnecting":
      return (
        right.phase === "reconnecting" &&
        right.mode === left.mode &&
        right.attempt === left.attempt &&
        right.retryDelayMs === left.retryDelayMs
      );
    case "failed":
      return (
        right.phase === "failed" &&
        right.mode === left.mode &&
        right.message === left.message
      );
  }
}

export type RunEventConnectionPresentation = {
  label: string;
  detail: string;
  tone: "neutral" | "connected" | "warning" | "danger";
};

export function runEventConnectionPresentation(
  state: RunEventConnectionState,
): RunEventConnectionPresentation | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "connecting":
      return state.mode === "follow"
        ? {
            label: "正在连接实时活动",
            detail: "Agent 任务已在后台创建，页面正在建立活动连接。",
            tone: "neutral",
          }
        : {
            label: "正在载入运行活动",
            detail: "页面正在读取这次运行已保存的活动。",
            tone: "neutral",
          };
    case "connected":
      return state.mode === "follow"
        ? {
            label: "实时活动已连接",
            detail: "页面正在跟随 Agent 的最新活动。",
            tone: "connected",
          }
        : {
            label: "正在读取运行活动",
            detail: "页面已连接，正在读取这次运行已保存的活动。",
            tone: "connected",
          };
    case "reconnecting":
      return state.mode === "follow"
        ? {
            label: `活动连接中断，正在第 ${state.attempt} 次重连`,
            detail: "页面断线不等于 Agent 停止；恢复连接后会从断点继续接收。",
            tone: "warning",
          }
        : {
            label: `活动载入中断，正在第 ${state.attempt} 次重连`,
            detail: "页面恢复连接后会从断点继续载入，不会重复活动。",
            tone: "warning",
          };
    case "failed":
      return state.mode === "follow"
        ? {
            label: "实时活动连接失败",
            detail:
              "Agent 是否仍在运行以运行状态为准；页面暂时无法继续接收活动。请重试连接。",
            tone: "danger",
          }
        : {
            label: "运行活动载入失败",
            detail: "页面未能读取这次运行的活动，请重新载入。",
            tone: "danger",
          };
  }
}
