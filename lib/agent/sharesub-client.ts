import OpenAI, { type ClientOptions } from "openai";
import type {
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

type OpenAIClientOptions = {
  apiKey: string;
  baseURL: string;
  fetch?: ClientOptions["fetch"];
};

export function createSilentOpenAIClient({
  apiKey,
  baseURL,
  fetch,
}: OpenAIClientOptions): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL,
    ...(fetch === undefined ? {} : { fetch }),
    logLevel: "off",
    maxRetries: 0,
  });
}

function orderedOutputItems(
  outputItemsByIndex: Map<number, ResponseOutputItem>,
): ResponseOutputItem[] {
  const entries = [...outputItemsByIndex.entries()].sort(
    ([left], [right]) => left - right,
  );

  for (const [position, [outputIndex]] of entries.entries()) {
    if (outputIndex !== position) {
      throw new Error(
        `ShareSub stream returned non-contiguous output_index ${outputIndex} at position ${position}`,
      );
    }
  }

  return entries.map(([, item]) => item);
}

export async function* normalizeShareSubResponseStream(
  source: AsyncIterable<ResponseStreamEvent>,
): AsyncGenerator<ResponseStreamEvent> {
  const outputItemsByIndex = new Map<number, ResponseOutputItem>();

  for await (const event of source) {
    if (event.type === "response.output_item.done") {
      if (outputItemsByIndex.has(event.output_index)) {
        throw new Error(
          `ShareSub stream returned duplicate output_index ${event.output_index}`,
        );
      }
      outputItemsByIndex.set(event.output_index, event.item);
      yield event;
      continue;
    }

    if (event.type === "response.completed") {
      if (event.response.output.length !== 0) {
        throw new Error(
          "ShareSub response.completed must contain an empty output array",
        );
      }

      const output = orderedOutputItems(outputItemsByIndex);
      if (output.length === 0) {
        throw new Error(
          "ShareSub response.completed arrived without output_item.done events",
        );
      }

      yield {
        ...event,
        response: { ...event.response, output },
      };
      continue;
    }

    yield event;
  }
}

export function createShareSubOpenAIClient({
  apiKey,
  baseURL,
}: OpenAIClientOptions): OpenAI {
  const client = createSilentOpenAIClient({ apiKey, baseURL });
  const originalCreate = client.responses.create.bind(client.responses);

  const patchedCreate = (
    body: { stream?: boolean },
    options?: unknown,
  ): unknown => {
    const result = originalCreate(body as never, options as never);
    if (body.stream !== true) {
      return result;
    }

    return Promise.resolve(result).then((stream) =>
      normalizeShareSubResponseStream(
        stream as unknown as AsyncIterable<ResponseStreamEvent>,
      ),
    );
  };

  Object.defineProperty(client.responses, "create", {
    configurable: true,
    value: patchedCreate,
    writable: true,
  });

  return client;
}
