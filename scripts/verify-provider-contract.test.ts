import type { ResponseOutputItem } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";

import {
  providerVerificationRequest,
  verifyWebSearchContract,
  WEB_SEARCH_SOURCES_INCLUDE,
} from "./verify-provider-contract";

type WebSearchItem = Extract<
  ResponseOutputItem,
  { type: "web_search_call" }
>;

describe("provider web-search verification contract", () => {
  it("uses the exact Responses include value", () => {
    expect(WEB_SEARCH_SOURCES_INCLUDE).toBe(
      "web_search_call.action.sources",
    );
    expect(providerVerificationRequest("test-model")).toMatchObject({
      model: "test-model",
      stream: true,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
    });
  });

  it("counts only completed search actions and their requested sources", () => {
    const items: WebSearchItem[] = [
      {
        id: "search-1",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          queries: ["official OpenAI homepage"],
          sources: [
            { type: "url", url: "https://openai.com/" },
            { type: "url", url: "https://openai.com/about/" },
          ],
        },
      },
      {
        id: "search-2",
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://openai.com/" },
      },
      {
        id: "search-3",
        type: "web_search_call",
        status: "failed",
        action: { type: "search", query: "unavailable query" },
      },
    ];

    expect(verifyWebSearchContract(items, "stream")).toEqual({
      webSearchCalls: 3,
      completedSearchActions: 1,
      sourceCount: 2,
    });
  });

  it("rejects a completed search action that omits requested sources", () => {
    const item: WebSearchItem = {
      id: "search-1",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "official OpenAI homepage" },
    };

    expect(() => verifyWebSearchContract([item], "stream")).toThrow(
      "stream completed search action search-1 omitted requested sources",
    );
  });

  it("rejects an empty source set", () => {
    const item: WebSearchItem = {
      id: "search-1",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "official OpenAI homepage",
        sources: [],
      },
    };

    expect(() => verifyWebSearchContract([item], "stream")).toThrow(
      "stream completed search actions contained no sources",
    );
  });

  it("rejects calls without a completed search action", () => {
    const item: WebSearchItem = {
      id: "search-1",
      type: "web_search_call",
      status: "completed",
      action: { type: "open_page", url: "https://openai.com/" },
    };

    expect(() => verifyWebSearchContract([item], "stream")).toThrow(
      "stream contained no completed search action",
    );
  });

  it("rejects a non-terminal output-item status", () => {
    const item: WebSearchItem = {
      id: "search-1",
      type: "web_search_call",
      status: "searching",
      action: {
        type: "search",
        query: "official OpenAI homepage",
        sources: [{ type: "url", url: "https://openai.com/" }],
      },
    };

    expect(() => verifyWebSearchContract([item], "stream")).toThrow(
      "stream web_search_call search-1 had non-terminal status searching",
    );
  });
});
