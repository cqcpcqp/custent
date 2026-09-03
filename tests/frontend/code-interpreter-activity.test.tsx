import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ActivityTimeline,
  analysisAndToolActivityCount,
  buildActivityItems,
} from "@/components/run-activity";
import type { RunEvent } from "@/lib/contracts";

const RUN_ID = "20000000-0000-4000-8000-000000000001";

function event(
  id: number,
  payload: RunEvent["payload"],
): RunEvent {
  return {
    id: String(id),
    runId: RUN_ID,
    createdAt: `2026-08-31T08:00:${String(id).padStart(2, "0")}.000Z`,
    payload,
  };
}

function completedPythonEvents(): RunEvent[] {
  return [
    event(1, {
      type: "code_interpreter_status",
      callId: "python-1",
      phase: "in_progress",
      outputIndex: 2,
      providerSequence: 10,
    }),
    event(2, {
      type: "code_interpreter_code",
      callId: "python-1",
      update: "delta",
      code: "values = [1, 2, 3]\\n",
      outputIndex: 2,
      providerSequence: 11,
    }),
    event(3, {
      type: "code_interpreter_code",
      callId: "python-1",
      update: "done",
      code: "values = [1, 2, 3]\\nprint(sum(values))",
      outputIndex: 2,
      providerSequence: 12,
    }),
    event(4, {
      type: "code_interpreter_status",
      callId: "python-1",
      phase: "interpreting",
      outputIndex: 2,
      providerSequence: 13,
    }),
    event(5, {
      type: "code_interpreter_status",
      callId: "python-1",
      phase: "completed",
      outputIndex: 2,
      providerSequence: 14,
    }),
    event(6, {
      type: "code_interpreter_result",
      callId: "python-1",
      phase: "completed",
      outputIndex: 2,
      providerSequence: 15,
      containerId: "container-1",
      code: "values = [1, 2, 3]\\nprint(sum(values))",
      outputs: [
        { type: "logs", logs: "6" },
        { type: "image", url: "https://example.com/chart.png" },
      ],
    }),
  ];
}

describe("Code Interpreter activity", () => {
  it("groups one provider lifecycle into one typed, replayable activity", () => {
    const events = completedPythonEvents();
    const items = buildActivityItems(events);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "code_interpreter",
      callId: "python-1",
      phase: "completed",
      streamedCode: "values = [1, 2, 3]\\nprint(sum(values))",
      finalCode: "values = [1, 2, 3]\\nprint(sum(values))",
      hasResult: true,
      outputs: [
        { type: "logs", logs: "6" },
        { type: "image", url: "https://example.com/chart.png" },
      ],
      incompleteOutcome: null,
    });
    expect(analysisAndToolActivityCount(events)).toBe(1);
  });

  it("renders code, stdout, and generated-image links without raw JSON", () => {
    const markup = renderToStaticMarkup(
      <ActivityTimeline events={completedPythonEvents()} />,
    );

    expect(markup).toContain("Python 执行完成");
    expect(markup).toContain("values = [1, 2, 3]");
    expect(markup).toContain("执行输出");
    expect(markup).toContain(">6</pre>");
    expect(markup).toContain("打开图像 1");
    expect(markup).toContain('href="https://example.com/chart.png"');
    expect(markup).not.toContain("container-1");
  });

  it("keeps compact activity useful while omitting verbose stdout", () => {
    const markup = renderToStaticMarkup(
      <ActivityTimeline compact events={completedPythonEvents()} />,
    );

    expect(markup).toContain("values = [1, 2, 3]");
    expect(markup).not.toContain("执行输出");
  });

  it("marks a nonterminal Python call as interrupted by the terminal event", () => {
    const events = [
      event(1, {
        type: "code_interpreter_status",
        callId: "python-2",
        phase: "interpreting",
        outputIndex: 1,
        providerSequence: 2,
      }),
      event(2, {
        type: "error",
        error: {
          code: "RUN_CANCELLED",
          message: "运行已停止",
          runId: RUN_ID,
        },
      }),
    ];

    expect(buildActivityItems(events)[0]).toMatchObject({
      kind: "code_interpreter",
      incompleteOutcome: "interrupted",
    });
    expect(
      renderToStaticMarkup(<ActivityTimeline events={events} />),
    ).toContain("Python 执行已中断");
  });

  it("rejects out-of-order provider updates instead of inventing a fallback", () => {
    const events = completedPythonEvents();
    const outOfOrder = structuredClone(events);
    if (outOfOrder[2].payload.type !== "code_interpreter_code") {
      throw new Error("test fixture is not a code event");
    }
    outOfOrder[2].payload.providerSequence = 11;

    expect(() => buildActivityItems(outOfOrder)).toThrow(
      "providerSequence 没有严格递增",
    );
  });
});
