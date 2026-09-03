import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  StreamingMessage,
  streamingMessageAccessibilityState,
} from "@/components/research-message";
import type { AgentRun, RunEvent } from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const runId = "20000000-0000-4000-8000-000000000001";

function run(status: "queued" | "running" = "running"): AgentRun {
  return {
    id: runId,
    requestId: "30000000-0000-4000-8000-000000000001",
    conversationId: "40000000-0000-4000-8000-000000000001",
    inputMessageId: "50000000-0000-4000-8000-000000000001",
    assistantMessageId: null,
    status,
    conversationTurn: "1",
    attemptIndex: 1,
    predecessorRunId: null,
    retryOfRunId: null,
    regenerateOfRunId: null,
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
    failure: null,
    createdAt: "2026-08-27T08:00:00.000Z",
    startedAt:
      status === "running" ? "2026-08-27T08:00:01.000Z" : null,
    finishedAt: null,
    cancelRequestedAt: null,
  };
}

function event(id: string, payload: RunEvent["payload"]): RunEvent {
  return {
    id,
    runId,
    createdAt: `2026-08-27T08:00:${id.padStart(2, "0")}.000Z`,
    payload,
  };
}

function renderStreaming(text: string): string {
  return renderToStaticMarkup(
    <StreamingMessage
      artifacts={[]}
      connectionState={{ phase: "idle" }}
      events={[]}
      onOpenActivity={() => undefined}
      run={run()}
      text={text}
    />,
  );
}

function openingTag(markup: string, marker: string): string {
  const markerIndex = markup.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find markup marker: ${marker}`);
  }
  const start = markup.lastIndexOf("<", markerIndex);
  const end = markup.indexOf(">", markerIndex);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find opening tag for marker: ${marker}`);
  }
  return markup.slice(start, end + 1);
}

describe("streaming message accessibility", () => {
  it("marks the growing article busy without making its body a live region", () => {
    const markup = renderStreaming("正在核对德国泵类买家");
    const articleTag = openingTag(markup, 'class="message message--assistant"');

    expect(articleTag).toContain('aria-busy="true"');
    expect(articleTag).not.toContain("aria-live");
    expect(markup).toContain("正在核对德国泵类买家");
    expect(markup).toContain(
      '<span aria-atomic="true" aria-live="polite" class="visually-hidden" role="status">正在生成回答。</span>',
    );
  });

  it("keeps the announcement unchanged when only response deltas change", () => {
    const firstDelta = renderStreaming("第一段");
    const laterDelta = renderStreaming("第一段，第二段，第三段");

    expect(firstDelta).toContain("第一段");
    expect(laterDelta).toContain("第一段，第二段，第三段");
    expect(
      firstDelta.match(/role="status">([^<]+)<\/span>/u)?.[1],
    ).toBe("正在生成回答。");
    expect(
      laterDelta.match(/role="status">([^<]+)<\/span>/u)?.[1],
    ).toBe("正在生成回答。");
  });

  it("announces only the effective queued or running phase", () => {
    const queuedRun = run("queued");
    expect(streamingMessageAccessibilityState(queuedRun, [])).toEqual({
      announcement: "研究已排队，正在等待生成回答。",
      isBusy: true,
    });

    expect(
      streamingMessageAccessibilityState(queuedRun, [
        event("1", {
          type: "status",
          phase: "thinking",
          message: "分析目标市场",
        }),
      ]),
    ).toEqual({
      announcement: "正在生成回答。",
      isBusy: true,
    });
  });

  it("rejects terminal runs instead of presenting them as streaming", () => {
    expect(() =>
      streamingMessageAccessibilityState(
        {
          ...run(),
          status: "completed",
          assistantMessageId: "60000000-0000-4000-8000-000000000001",
          finishedAt: "2026-08-27T08:01:00.000Z",
        },
        [],
      ),
    ).toThrow(`Run ${runId} 不是流式运行`);
  });
});
