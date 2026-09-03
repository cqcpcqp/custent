import { describe, expect, it } from "vitest";

import {
  RunEventFrameBuffer,
  type BufferedRunEvent,
} from "@/components/run-event-buffer";
import type { RunEvent } from "@/lib/contracts";

const runId = "20000000-0000-4000-8000-000000000001";
const otherRunId = "20000000-0000-4000-8000-000000000002";

function event(
  id: string,
  payload: RunEvent["payload"] = { type: "delta", text: id },
  eventRunId: string = runId,
): RunEvent {
  return {
    id,
    runId: eventRunId,
    createdAt: "2026-08-24T08:00:00.000Z",
    payload,
  };
}

function observation(runEvent: RunEvent): BufferedRunEvent {
  return { event: runEvent, feedbackDataRevision: 1 };
}

function harness(
  initialCommittedEventId: string | null = null,
  acceptsFlush = true,
) {
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  const flushed: BufferedRunEvent[][] = [];
  const buffer = new RunEventFrameBuffer({
    runId,
    initialCommittedEventId,
    requestFrame(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      frames.delete(handle);
    },
    onFlush(events) {
      if (!acceptsFlush) {
        return false;
      }
      flushed.push([...events]);
      return true;
    },
  });
  return {
    buffer,
    flushed,
    pendingFrameCount: () => frames.size,
    runNextFrame() {
      const entry = frames.entries().next().value as
        | [number, () => void]
        | undefined;
      if (entry === undefined) {
        throw new Error("缺少待执行 animation frame");
      }
      frames.delete(entry[0]);
      entry[1]();
    },
  };
}

describe("run event frame buffer", () => {
  it("同一帧的完整前台事件只提交一次", () => {
    const test = harness();
    expect(test.buffer.beginSubscription()).toBeNull();

    test.buffer.observe(observation(event("1")), true);
    test.buffer.observe(observation(event("2")), true);

    expect(test.pendingFrameCount()).toBe(1);
    expect(test.flushed).toEqual([]);
    expect(test.buffer.snapshot()).toEqual({
      observedEventId: "2",
      committedEventId: null,
    });

    test.runNextFrame();
    expect(test.flushed.map((batch) => batch.map((item) => item.event.id))).toEqual([
      ["1", "2"],
    ]);
    expect(test.buffer.snapshot()).toEqual({
      observedEventId: "2",
      committedEventId: "2",
    });
  });

  it("terminal 事件立即连同当前批次提交", () => {
    const test = harness();
    test.buffer.beginSubscription();
    test.buffer.observe(observation(event("1")), true);
    test.buffer.observe(
      observation(
        event("2", {
          type: "error",
          error: { code: "FAILED", message: "失败", runId },
        }),
      ),
      true,
    );

    expect(test.pendingFrameCount()).toBe(0);
    expect(test.flushed.map((batch) => batch.map((item) => item.event.id))).toEqual([
      ["1", "2"],
    ]);
    expect(test.buffer.snapshot().committedEventId).toBe("2");
  });

  it("重启 Event Stream 会丢弃未提交帧并从 committed cursor 精确恢复", () => {
    const test = harness("3");
    test.buffer.beginSubscription();
    test.buffer.observe(observation(event("4")), true);
    expect(test.pendingFrameCount()).toBe(1);

    expect(test.buffer.beginSubscription()).toBe("3");
    expect(test.pendingFrameCount()).toBe(0);
    expect(test.buffer.snapshot()).toEqual({
      observedEventId: "3",
      committedEventId: "3",
    });
    expect(test.flushed).toEqual([]);
    test.buffer.observe(observation(event("4")), true);
    test.buffer.observe(observation(event("7")), true);
    test.runNextFrame();
    expect(
      test.flushed.map((batch) => batch.map((item) => item.event.id)),
    ).toEqual([["4", "7"]]);
    expect(test.buffer.snapshot()).toEqual({
      observedEventId: "7",
      committedEventId: "7",
    });
  });

  it("帧提交时角色已失配则不推进 committed cursor", () => {
    const test = harness("3", false);
    test.buffer.beginSubscription();
    test.buffer.observe(observation(event("4")), true);

    test.runNextFrame();
    expect(test.flushed).toEqual([]);
    expect(test.buffer.snapshot()).toEqual({
      observedEventId: "4",
      committedEventId: "3",
    });
  });

  it("严格拒绝其他 Run、重复和倒序事件", () => {
    const test = harness();
    test.buffer.beginSubscription();
    expect(() =>
      test.buffer.observe(observation(event("1", undefined, otherRunId)), true),
    ).toThrow("收到了另一个 Run");

    test.buffer.observe(observation(event("2")), true);
    expect(() =>
      test.buffer.observe(observation(event("2")), true),
    ).toThrow("事件序号没有严格递增");
    expect(() =>
      test.buffer.observe(observation(event("1")), true),
    ).toThrow("事件序号没有严格递增");
  });
});
