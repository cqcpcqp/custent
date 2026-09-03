import type {
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import {
  createShareSubOpenAIClient,
  createSilentOpenAIClient,
  normalizeShareSubResponseStream,
} from "./sharesub-client";

const webSearchItem = {
  type: "web_search_call",
  id: "ws_1",
  status: "completed",
} as ResponseOutputItem;

const messageItem = {
  type: "message",
  id: "msg_1",
  status: "completed",
  role: "assistant",
  content: [
    {
      type: "output_text",
      text: "OpenAI",
      annotations: [
        {
          type: "url_citation",
          start_index: 0,
          end_index: 6,
          url: "https://openai.com",
          title: "OpenAI",
        },
      ],
    },
  ],
} as ResponseOutputItem;

function event(value: unknown): ResponseStreamEvent {
  return value as ResponseStreamEvent;
}

function source(events: ResponseStreamEvent[]): AsyncIterable<ResponseStreamEvent> {
  return (async function* responseEvents() {
    for (const responseEvent of events) {
      yield responseEvent;
    }
  })();
}

async function collect(
  events: AsyncIterable<ResponseStreamEvent>,
): Promise<ResponseStreamEvent[]> {
  const collected: ResponseStreamEvent[] = [];
  for await (const responseEvent of events) {
    collected.push(responseEvent);
  }
  return collected;
}

function completedEvent(output: ResponseOutputItem[] = []): ResponseStreamEvent {
  return event({
    type: "response.completed",
    sequence_number: 3,
    response: {
      id: "resp_1",
      object: "response",
      status: "completed",
      output,
    },
  });
}

describe("normalizeShareSubResponseStream", () => {
  it("disables SDK logging for both OpenAI and ShareSub clients", () => {
    const options = {
      apiKey: "test-key",
      baseURL: "https://provider.example.com/v1",
    };

    const openai = createSilentOpenAIClient(options);
    const sharesub = createShareSubOpenAIClient(options);
    expect(openai.logLevel).toBe("off");
    expect(openai.maxRetries).toBe(0);
    expect(sharesub.logLevel).toBe("off");
    expect(sharesub.maxRetries).toBe(0);
  });

  it("does not retry retryable provider failures", async () => {
    let requestCount = 0;
    const client = createSilentOpenAIClient({
      apiKey: "test-key",
      baseURL: "https://provider.example.com/v1",
      fetch: async () => {
        requestCount += 1;
        return new Response(
          JSON.stringify({
            error: {
              code: "provider_unavailable",
              message: "provider unavailable",
              type: "server_error",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 500,
          },
        );
      },
    });

    await expect(
      client.responses.create({ model: "test-model", input: "test" }),
    ).rejects.toMatchObject({ status: 500 });
    expect(requestCount).toBe(1);
  });

  it("reconstructs terminal output from exact output_item.done indexes", async () => {
    const events = await collect(
      normalizeShareSubResponseStream(
        source([
          event({
            type: "response.output_item.done",
            sequence_number: 1,
            output_index: 0,
            item: webSearchItem,
          }),
          event({
            type: "response.output_item.done",
            sequence_number: 2,
            output_index: 1,
            item: messageItem,
          }),
          completedEvent(),
        ]),
      ),
    );

    const completed = events.at(-1);
    expect(completed?.type).toBe("response.completed");
    if (completed?.type !== "response.completed") {
      throw new Error("Expected response.completed");
    }
    expect(completed.response.output).toEqual([webSearchItem, messageItem]);
  });

  it("rejects a duplicate output index", async () => {
    await expect(
      collect(
        normalizeShareSubResponseStream(
          source([
            event({
              type: "response.output_item.done",
              sequence_number: 1,
              output_index: 0,
              item: webSearchItem,
            }),
            event({
              type: "response.output_item.done",
              sequence_number: 2,
              output_index: 0,
              item: messageItem,
            }),
          ]),
        ),
      ),
    ).rejects.toThrow("duplicate output_index 0");
  });

  it("rejects terminal output that does not match the ShareSub contract", async () => {
    await expect(
      collect(
        normalizeShareSubResponseStream(
          source([completedEvent([messageItem])]),
        ),
      ),
    ).rejects.toThrow(
      "ShareSub response.completed must contain an empty output array",
    );
  });

  it("rejects missing output indexes instead of guessing their order", async () => {
    await expect(
      collect(
        normalizeShareSubResponseStream(
          source([
            event({
              type: "response.output_item.done",
              sequence_number: 1,
              output_index: 1,
              item: messageItem,
            }),
            completedEvent(),
          ]),
        ),
      ),
    ).rejects.toThrow("non-contiguous output_index 1 at position 0");
  });
});
