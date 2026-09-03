import { describe, expect, it } from "vitest";

import {
  parseSseFrame,
  readRunEventStream,
  readRunEventStreamWithReconnect,
  RunEventProtocolError,
  RunEventStreamInterruptedError,
} from "@/components/chat-stream";
import { encodeRunEventSse, type RunEvent } from "@/lib/contracts";

const runId = "00000000-0000-4000-8000-000000000002";

function chunkedStream(bytes: Uint8Array, chunkSizes: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0;
      for (const size of chunkSizes) {
        if (offset >= bytes.length) {
          break;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      }
      if (offset < bytes.length) {
        controller.enqueue(bytes.slice(offset));
      }
      controller.close();
    },
  });
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function statusEvent(id: string): RunEvent {
  return {
    id,
    runId,
    createdAt: "2026-08-24T08:00:00.000Z",
    payload: {
      type: "status",
      phase: "searching",
      message: "正在搜索",
    },
  };
}

describe("parseSseFrame", () => {
  it("严格解析带 id 的完整 RunEvent", () => {
    const event = statusEvent("12");
    expect(
      parseSseFrame(
        `id: 12\nevent: status\ndata: ${JSON.stringify(event)}`,
      ),
    ).toEqual(event);
  });

  it("支持标准 CRLF SSE 帧", () => {
    const event: RunEvent = {
      id: "13",
      runId,
      createdAt: "2026-08-24T08:00:01.000Z",
      payload: { type: "delta", text: "结果" },
    };
    expect(
      parseSseFrame(
        `id: 13\r\nevent: delta\r\ndata: ${JSON.stringify(event)}`,
      ),
    ).toEqual(event);
  });

  it("严格解析附件活动事件", () => {
    const event: RunEvent = {
      id: "14",
      runId,
      createdAt: "2026-08-24T08:00:02.000Z",
      payload: {
        type: "attachment",
        attachment: {
          id: "00000000-0000-4000-8000-000000000014",
          kind: "image",
          name: "product.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          downloadUrl:
            "/api/input-attachments/00000000-0000-4000-8000-000000000014/content",
          createdAt: "2026-08-24T08:00:01.000Z",
        },
      },
    };
    expect(
      parseSseFrame(
        `id: 14\nevent: attachment\ndata: ${JSON.stringify(event)}`,
      ),
    ).toEqual(event);
  });

  it("严格解析 Code Interpreter 结果事件", () => {
    const event: RunEvent = {
      id: "15",
      runId,
      createdAt: "2026-08-24T08:00:03.000Z",
      payload: {
        type: "code_interpreter_result",
        callId: "python-1",
        phase: "completed",
        outputIndex: 1,
        providerSequence: 8,
        containerId: "container-1",
        code: "print(6)",
        outputs: [{ type: "logs", logs: "6" }],
      },
    };

    expect(
      parseSseFrame(
        `id: 15\nevent: code_interpreter_result\ndata: ${JSON.stringify(event)}`,
      ),
    ).toEqual(event);
  });

  it("拒绝 SSE id 与数据 id 不一致", () => {
    const event = statusEvent("12");
    expect(() =>
      parseSseFrame(
        `id: 11\nevent: status\ndata: ${JSON.stringify(event)}`,
      ),
    ).toThrow("SSE id 11 与运行事件 id 12 不一致");
  });

  it("拒绝 event 名与 payload 类型不一致", () => {
    const event = statusEvent("12");
    expect(() =>
      parseSseFrame(
        `id: 12\nevent: delta\ndata: ${JSON.stringify(event)}`,
      ),
    ).toThrow("SSE 事件名 delta 与 payload 类型 status 不一致");
  });

  it("未知 event 直接报错", () => {
    let error: unknown;
    try {
      parseSseFrame('id: 1\nevent: ping\ndata: {"type":"ping"}');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RunEventProtocolError);
    expect(error).not.toBeInstanceOf(RunEventStreamInterruptedError);
    expect(error).toMatchObject({ message: "未知 SSE event：ping" });
  });

  it("schema 错误仍是不可重连的硬协议错误", () => {
    let error: unknown;
    try {
      parseSseFrame(
        'id: 1\nevent: status\ndata: {"id":"1","unexpected":true}',
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RunEventProtocolError);
    expect(error).not.toBeInstanceOf(RunEventStreamInterruptedError);
    expect(error).toMatchObject({
      message: "SSE status 数据不符合 RunEvent 契约",
    });
  });
});

describe("readRunEventStream", () => {
  it("可跨任意网络分片读取完整运行事件序列", async () => {
    const events: RunEvent[] = [
      statusEvent("1"),
      {
        id: "2",
        runId,
        createdAt: "2026-08-24T08:00:01.000Z",
        payload: {
          type: "web_search",
          callId: "search-1",
          phase: "completed",
          outputIndex: 0,
          providerSequence: 4,
          action: null,
        },
      },
      {
        id: "3",
        runId,
        createdAt: "2026-08-24T08:00:02.000Z",
        payload: { type: "delta", text: "已找到相关公司。" },
      },
      {
        id: "4",
        runId,
        createdAt: "2026-08-24T08:00:03.000Z",
        payload: {
          type: "done",
          message: {
            id: "00000000-0000-4000-8000-000000000003",
            runId,
            role: "assistant",
            content: "已找到相关公司。",
            citations: [],
            artifacts: [],
            attachments: [],
            feedback: null,
            createdAt: "2026-08-24T08:00:03.000Z",
          },
          credits: { available: 96, reserved: 0 },
        },
      },
    ];
    const bytes = joinBytes(events.map(encodeRunEventSse));
    const stream = chunkedStream(bytes, [1, 2, 5, 3, 11, 7, 19]);
    const parsed: RunEvent[] = [];

    for await (const event of readRunEventStream(stream)) {
      parsed.push(event);
    }

    expect(parsed).toEqual(events);
  });

  it("把未完成的尾部事件标记为可重连的流中断", async () => {
    const event = statusEvent("1");
    const bytes = new TextEncoder().encode(
      `id: 1\nevent: status\ndata: ${JSON.stringify(event)}`,
    );
    const consume = async () => {
      for await (const event of readRunEventStream(chunkedStream(bytes, [4, 8]))) {
        void event;
      }
    };
    const error = await consume().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunEventStreamInterruptedError);
    expect(error).toBeInstanceOf(RunEventProtocolError);
    expect(error).toMatchObject({
      name: "RunEventStreamInterruptedError",
      message: "SSE 响应流以未完成事件结束",
      reconnectable: true,
    });
  });
});

describe("readRunEventStreamWithReconnect", () => {
  it("在截断后使用最后一个完整事件 ID 续传", async () => {
    const first = statusEvent("1");
    const second: RunEvent = {
      id: "2",
      runId,
      createdAt: "2026-08-24T08:00:01.000Z",
      payload: { type: "delta", text: "续传内容" },
    };
    const terminal: RunEvent = {
      id: "3",
      runId,
      createdAt: "2026-08-24T08:00:02.000Z",
      payload: {
        type: "error",
        error: {
          code: "RUN_FAILED",
          message: "测试终态",
          runId,
        },
      },
    };
    const streams = [
      chunkedStream(
        joinBytes([
          encodeRunEventSse(first),
          encodeRunEventSse(second).slice(0, 24),
        ]),
        [2, 7, 3],
      ),
      chunkedStream(
        joinBytes([encodeRunEventSse(second), encodeRunEventSse(terminal)]),
        [5, 1, 11],
      ),
    ];
    const resumeIds: Array<string | null> = [];
    let reconnectCount = 0;
    const parsed: RunEvent[] = [];

    for await (const event of readRunEventStreamWithReconnect({
      initialLastEventId: null,
      async openStream(lastEventId) {
        resumeIds.push(lastEventId);
        const stream = streams.shift();
        if (stream === undefined) {
          throw new Error("测试流被重复打开");
        }
        return stream;
      },
      async beforeReconnect() {
        reconnectCount += 1;
      },
    })) {
      parsed.push(event);
    }

    expect(parsed).toEqual([first, second, terminal]);
    expect(resumeIds).toEqual([null, "1"]);
    expect(reconnectCount).toBe(1);
  });

  it("硬协议错误不会触发重连", async () => {
    let reconnectCount = 0;
    let openCount = 0;
    const consume = async () => {
      for await (const event of readRunEventStreamWithReconnect({
        initialLastEventId: "8",
        async openStream() {
          openCount += 1;
          return chunkedStream(
            new TextEncoder().encode(
              'id: 9\nevent: unknown\ndata: {"type":"unknown"}\n\n',
            ),
            [3, 4],
          );
        },
        async beforeReconnect() {
          reconnectCount += 1;
        },
      })) {
        void event;
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: "RunEventProtocolError",
      message: "未知 SSE event：unknown",
    });
    expect(openCount).toBe(1);
    expect(reconnectCount).toBe(0);
  });
});
