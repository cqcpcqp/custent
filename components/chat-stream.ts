import { RunEventSchema, type RunEvent } from "@/lib/contracts";

const eventTypes = new Set([
  "status",
  "reasoning",
  "web_search",
  "code_interpreter_status",
  "code_interpreter_code",
  "code_interpreter_result",
  "tool_started",
  "tool_completed",
  "delta",
  "artifact",
  "attachment",
  "done",
  "error",
] as const);

type RunEventType = RunEvent["payload"]["type"];

export class RunEventProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunEventProtocolError";
  }
}

export class RunEventStreamInterruptedError extends RunEventProtocolError {
  readonly reconnectable = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunEventStreamInterruptedError";
  }
}

function readSseField(line: string, field: string): string | null {
  const prefix = `${field}:`;
  if (!line.startsWith(prefix)) {
    return null;
  }
  const value = line.slice(prefix.length);
  return value.startsWith(" ") ? value.slice(1) : value;
}

function parseRunEventFrame(frame: string): RunEvent {
  let eventName: string | null = null;
  let eventId: string | null = null;
  const dataLines: string[] = [];

  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith(":")) {
      continue;
    }

    const idField = readSseField(line, "id");
    if (idField !== null) {
      eventId = idField;
      continue;
    }

    const eventField = readSseField(line, "event");
    if (eventField !== null) {
      eventName = eventField;
      continue;
    }

    const dataField = readSseField(line, "data");
    if (dataField !== null) {
      dataLines.push(dataField);
      continue;
    }

    if (line.length > 0) {
      throw new RunEventProtocolError(`无法识别的 SSE 字段：${line}`);
    }
  }

  if (eventId === null) {
    throw new RunEventProtocolError("运行事件缺少 SSE id 字段");
  }
  if (eventName === null) {
    throw new RunEventProtocolError("运行事件缺少 SSE event 字段");
  }
  if (!eventTypes.has(eventName as RunEventType)) {
    throw new RunEventProtocolError(`未知 SSE event：${eventName}`);
  }
  if (dataLines.length === 0) {
    throw new RunEventProtocolError(`SSE ${eventName} 事件缺少 data 字段`);
  }

  try {
    const event = RunEventSchema.parse(JSON.parse(dataLines.join("\n")));
    if (event.id !== eventId) {
      throw new RunEventProtocolError(
        `SSE id ${eventId} 与运行事件 id ${event.id} 不一致`,
      );
    }
    if (event.payload.type !== eventName) {
      throw new RunEventProtocolError(
        `SSE 事件名 ${eventName} 与 payload 类型 ${event.payload.type} 不一致`,
      );
    }
    return event;
  } catch (error) {
    if (error instanceof RunEventProtocolError) {
      throw error;
    }
    throw new RunEventProtocolError(`SSE ${eventName} 数据不符合 RunEvent 契约`, {
      cause: error,
    });
  }
}

export function parseSseFrame(frame: string): RunEvent {
  return parseRunEventFrame(frame);
}

function frameBoundary(buffer: string): { index: number; length: number } | null {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");

  if (lfIndex === -1 && crlfIndex === -1) {
    return null;
  }
  if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex)) {
    return { index: crlfIndex, length: 4 };
  }
  return { index: lfIndex, length: 2 };
}

export async function* readRunEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<RunEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      let boundary = frameBoundary(buffer);
      while (boundary !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        if (frame.length > 0 && !frame.startsWith(":")) {
          yield parseRunEventFrame(frame);
        }
        boundary = frameBoundary(buffer);
      }
    }

    if (buffer.trim().length > 0) {
      throw new RunEventStreamInterruptedError(
        "SSE 响应流以未完成事件结束",
      );
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* readRunEventStreamWithReconnect(input: {
  initialLastEventId: string | null;
  openStream(lastEventId: string | null): Promise<ReadableStream<Uint8Array>>;
  beforeReconnect(): Promise<void>;
}): AsyncGenerator<RunEvent> {
  let lastEventId = input.initialLastEventId;

  while (true) {
    try {
      const stream = await input.openStream(lastEventId);
      for await (const event of readRunEventStream(stream)) {
        lastEventId = event.id;
        yield event;
      }
      return;
    } catch (error) {
      if (!(error instanceof RunEventStreamInterruptedError)) {
        throw error;
      }
      await input.beforeReconnect();
    }
  }
}
