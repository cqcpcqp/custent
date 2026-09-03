import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import type {
  Response as OpenAIResponse,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

import {
  createShareSubOpenAIClient,
  createSilentOpenAIClient,
} from "@/lib/agent/sharesub-client";

import {
  providerVerificationRequest,
  verifyWebSearchContract,
} from "./verify-provider-contract";

const environmentFile = path.resolve(process.cwd(), ".env");
if (existsSync(environmentFile)) {
  loadEnvFile(environmentFile);
}

const apiKey = process.env.OPENAI_API_KEY;
const provider = process.env.OPENAI_PROVIDER;
const baseURL = process.env.OPENAI_BASE_URL;
const model = process.env.OPENAI_MODEL;

if (apiKey === undefined || apiKey.length === 0) {
  throw new Error("OPENAI_API_KEY is required");
}
if (provider !== "openai" && provider !== "sharesub") {
  throw new Error("OPENAI_PROVIDER must be openai or sharesub");
}
if (baseURL === undefined || baseURL.length === 0) {
  throw new Error("OPENAI_BASE_URL is required");
}
if (model === undefined || model.length === 0) {
  throw new Error("OPENAI_MODEL is required");
}

const client =
  provider === "sharesub"
    ? createShareSubOpenAIClient({ apiKey, baseURL })
    : createSilentOpenAIClient({ apiKey, baseURL });
const stream = await client.responses.create(
  providerVerificationRequest(model),
);

let completedResponse: OpenAIResponse | undefined;
const streamEventCounts = new Map<string, number>();
const streamedOutputItemTypes: string[] = [];
const streamedOutputItems: ResponseOutputItem[] = [];
let streamedTextDeltas = 0;
let streamedUrlCitations = 0;
const webSearchPhaseCounts = {
  inProgress: 0,
  searching: 0,
  completed: 0,
};

for await (const event of stream) {
  streamEventCounts.set(
    event.type,
    (streamEventCounts.get(event.type) ?? 0) + 1,
  );
  if (event.type === "response.output_item.done") {
    streamedOutputItemTypes.push(event.item.type);
    streamedOutputItems.push(event.item);
  }
  if (event.type === "response.output_text.delta") {
    streamedTextDeltas += 1;
  }
  if (event.type === "response.web_search_call.in_progress") {
    webSearchPhaseCounts.inProgress += 1;
  }
  if (event.type === "response.web_search_call.searching") {
    webSearchPhaseCounts.searching += 1;
  }
  if (event.type === "response.web_search_call.completed") {
    webSearchPhaseCounts.completed += 1;
  }
  if (
    event.type === "response.output_text.annotation.added" &&
    event.annotation !== null &&
    event.annotation.type === "url_citation"
  ) {
    streamedUrlCitations += 1;
  }
  if (event.type === "response.completed") {
    completedResponse = event.response;
  }
  if (event.type === "response.failed") {
    if (event.response.error === null) {
      throw new Error("Provider returned response.failed without an error");
    }
    throw new Error(
      `Provider returned response.failed: ${event.response.error.message}`,
    );
  }
}

if (completedResponse === undefined) {
  throw new Error("Provider stream ended without response.completed");
}
if (completedResponse.status !== "completed") {
  throw new Error(`Provider response status was ${completedResponse.status}`);
}
if (completedResponse.usage === null || completedResponse.usage === undefined) {
  throw new Error("Provider response did not include usage");
}
const usage = completedResponse.usage;

let outputTextBlocks = 0;
let urlCitations = 0;
const outputItemTypes = completedResponse.output.map((item) => item.type);

for (const item of completedResponse.output) {
  if (item.type !== "message") {
    continue;
  }
  for (const content of item.content) {
    if (content.type !== "output_text") {
      continue;
    }
    outputTextBlocks += 1;
    for (const annotation of content.annotations) {
      if (annotation.type === "url_citation") {
        urlCitations += 1;
      }
    }
  }
}

const streamedWebSearch = verifyWebSearchContract(
  streamedOutputItems,
  "Provider output_item.done events",
);
const finalWebSearch = verifyWebSearchContract(
  completedResponse.output,
  "Provider completed response",
);
if (outputTextBlocks === 0) {
  throw new Error("Provider completed without an output_text block");
}
if (
  webSearchPhaseCounts.inProgress === 0 ||
  webSearchPhaseCounts.searching === 0 ||
  webSearchPhaseCounts.completed === 0
) {
  throw new Error(
    `Provider omitted required web search phase events: ${JSON.stringify(webSearchPhaseCounts)}`,
  );
}

console.log(
  JSON.stringify(
    {
      status: completedResponse.status,
      model: completedResponse.model,
      outputItemTypes,
      streamedOutputItemTypes,
      streamedTextDeltas,
      streamedUrlCitations,
      webSearchPhaseCounts,
      streamedWebSearch,
      finalWebSearch,
      outputTextBlocks,
      urlCitations,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      },
    },
    null,
    2,
  ),
);
