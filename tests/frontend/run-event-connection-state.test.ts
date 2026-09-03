import { describe, expect, it } from "vitest";

import {
  idleRunEventConnectionState,
  reconnectingRunEventConnectionState,
  runEventConnectionPresentation,
  sameRunEventConnectionState,
  type RunEventConnectionState,
} from "@/components/run-event-connection-state";

describe("run event connection state", () => {
  it("distinguishes Agent execution from the page transport", () => {
    expect(
      runEventConnectionPresentation({ phase: "connecting", mode: "follow" }),
    ).toEqual({
      label: "正在连接实时活动",
      detail: "Agent 任务已在后台创建，页面正在建立活动连接。",
      tone: "neutral",
    });
    expect(
      runEventConnectionPresentation({
        phase: "reconnecting",
        mode: "follow",
        attempt: 2,
        retryDelayMs: 1_600,
      }),
    ).toEqual({
      label: "活动连接中断，正在第 2 次重连",
      detail: "页面断线不等于 Agent 停止；恢复连接后会从断点继续接收。",
      tone: "warning",
    });
  });

  it("uses different copy for one-time historical replay", () => {
    expect(
      runEventConnectionPresentation({
        phase: "failed",
        mode: "replay_once",
        message: "事件契约无效",
      }),
    ).toEqual({
      label: "运行活动载入失败",
      detail: "页面未能读取这次运行的活动，请重新载入。",
      tone: "danger",
    });
  });

  it("validates reconnect attempts and compares exact states", () => {
    const state = reconnectingRunEventConnectionState({
      mode: "follow",
      attempt: 1,
      retryDelayMs: 800,
    });
    expect(
      sameRunEventConnectionState(state, { ...state }),
    ).toBe(true);
    expect(
      sameRunEventConnectionState(state, {
        phase: "reconnecting",
        mode: "follow",
        attempt: 2,
        retryDelayMs: 800,
      }),
    ).toBe(false);
    expect(() =>
      reconnectingRunEventConnectionState({
        mode: "follow",
        attempt: 0,
        retryDelayMs: 800,
      }),
    ).toThrow(TypeError);
  });

  it("keeps idle presentation absent", () => {
    const state: RunEventConnectionState = idleRunEventConnectionState;
    expect(runEventConnectionPresentation(state)).toBeNull();
    expect(sameRunEventConnectionState(state, { phase: "idle" })).toBe(true);
  });
});
