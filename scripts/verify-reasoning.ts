import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import {
  createShareSubOpenAIClient,
  createSilentOpenAIClient,
} from "@/lib/agent/sharesub-client";

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
const stream = await client.responses.create({
  model,
  input:
    "Compare direct exporting through one exclusive distributor with selling through three regional distributors. Analyze market coverage, concentration risk, channel control, and operating complexity, then reply with only the better option for a small first-time exporter.",
  reasoning: { summary: "auto" },
  max_output_tokens: 256,
  store: false,
  stream: true,
});

let reasoningSummaryDeltas = 0;
let reasoningOutputItems = 0;
let textDeltas = 0;
let completed = false;

for await (const event of stream) {
  if (event.type === "response.reasoning_summary_text.delta") {
    reasoningSummaryDeltas += 1;
  }
  if (
    event.type === "response.output_item.done" &&
    event.item.type === "reasoning"
  ) {
    reasoningOutputItems += 1;
  }
  if (event.type === "response.output_text.delta") {
    textDeltas += 1;
  }
  if (event.type === "response.completed") {
    completed = true;
  }
}

if (!completed) {
  throw new Error("Provider stream ended without response.completed");
}
if (reasoningSummaryDeltas === 0) {
  throw new Error(
    `Provider emitted no reasoning summary deltas: ${JSON.stringify({ reasoningOutputItems, textDeltas })}`,
  );
}
if (reasoningOutputItems === 0) {
  throw new Error("Provider emitted no reasoning output item");
}
if (textDeltas === 0) {
  throw new Error("Provider emitted no output text deltas");
}

console.log(
  JSON.stringify({
    model,
    reasoningSummaryDeltas,
    reasoningOutputItems,
    textDeltas,
  }),
);
