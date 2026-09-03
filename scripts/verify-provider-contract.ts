import type {
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
} from "openai/resources/responses/responses";

export const WEB_SEARCH_SOURCES_INCLUDE =
  "web_search_call.action.sources" as const;

export type VerifiedWebSearchContract = {
  webSearchCalls: number;
  completedSearchActions: number;
  sourceCount: number;
};

export function providerVerificationRequest(
  model: string,
): ResponseCreateParamsStreaming {
  return {
    model,
    input:
      "Use web search to find the official OpenAI homepage. Reply with one short sentence naming the site.",
    tools: [{ type: "web_search" }],
    tool_choice: "required",
    include: [WEB_SEARCH_SOURCES_INCLUDE],
    max_output_tokens: 128,
    store: false,
    stream: true,
  };
}

export function verifyWebSearchContract(
  items: readonly ResponseOutputItem[],
  location: string,
): VerifiedWebSearchContract {
  let webSearchCalls = 0;
  let completedSearchActions = 0;
  let sourceCount = 0;

  for (const item of items) {
    if (item.type !== "web_search_call") {
      continue;
    }

    webSearchCalls += 1;
    if (item.status !== "completed" && item.status !== "failed") {
      throw new Error(
        `${location} web_search_call ${item.id} had non-terminal status ${item.status}`,
      );
    }
    if (item.status !== "completed" || item.action.type !== "search") {
      continue;
    }

    completedSearchActions += 1;
    if (item.action.sources === undefined) {
      throw new Error(
        `${location} completed search action ${item.id} omitted requested sources`,
      );
    }
    sourceCount += item.action.sources.length;
  }

  if (webSearchCalls === 0) {
    throw new Error(`${location} contained no web_search_call output item`);
  }
  if (completedSearchActions === 0) {
    throw new Error(`${location} contained no completed search action`);
  }
  if (sourceCount === 0) {
    throw new Error(`${location} completed search actions contained no sources`);
  }

  return { webSearchCalls, completedSearchActions, sourceCount };
}
