import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityTimeline } from "@/components/run-activity";
import type { RunEvent } from "@/lib/contracts";

const runId = "20000000-0000-4000-8000-000000000001";

function event(
  id: string,
  payload: RunEvent["payload"],
): RunEvent {
  return {
    id,
    runId,
    createdAt: `2026-08-26T08:00:${id.padStart(2, "0")}.000Z`,
    payload,
  };
}

describe("activity reasoning summary Markdown", () => {
  it("renders controlled Markdown only for the reasoning summary", () => {
    const markup = renderToStaticMarkup(
      <ActivityTimeline
        events={[
          event("1", {
            type: "reasoning",
            itemId: "reasoning-1",
            summaryIndex: 0,
            providerSequence: 1,
            text: "**Planning...**\n\n- 核对目标市场\n- 验证买家角色\n\n![隐藏图片](https://example.com/image.png)",
          }),
          event("2", {
            type: "web_search",
            callId: "search-1",
            phase: "completed",
            outputIndex: 0,
            providerSequence: 2,
            action: {
              type: "search",
              query: "**German pump distributors**",
              queries: ["**German pump distributors**"],
              sources: [],
            },
          }),
          event("3", {
            type: "tool_started",
            callId: "tool-1",
            toolName: "save_research_results",
            title: "保存买家",
            input: '{"query":"**German pumps**"}',
          }),
          event("4", {
            type: "tool_completed",
            callId: "tool-1",
            toolName: "save_research_results",
            title: "买家已保存",
            output: "**2 buyers saved**",
          }),
        ]}
      />,
    );

    expect(markup).toContain("activity-event__reasoning-summary");
    expect(markup).toContain("<strong>Planning...</strong>");
    expect(markup).not.toContain("**Planning...**");
    expect(markup).toContain("<li>核对目标市场</li>");
    expect(markup).not.toContain("<img");

    expect(markup).toContain("<pre>**German pump distributors**</pre>");
    expect(markup).toContain(
      "<pre>{&quot;query&quot;:&quot;**German pumps**&quot;}</pre>",
    );
    expect(markup).toContain("<pre>**2 buyers saved**</pre>");
    expect(markup).toContain(
      '<details class="activity-event__tool-details"><summary><span>查看工具输入与输出</span>',
    );
    expect(markup).not.toContain(
      '<details class="activity-event__tool-details" open=""',
    );
    expect(markup).not.toContain("<strong>German pumps</strong>");
    expect(markup).not.toContain("<strong>2 buyers saved</strong>");
  });

  it("shows three unique source domains and keeps the full search in a disclosure", () => {
    const markup = renderToStaticMarkup(
      <ActivityTimeline
        events={[
          event("1", {
            type: "web_search",
            callId: "search-dense",
            phase: "completed",
            outputIndex: 0,
            providerSequence: 1,
            action: {
              type: "search",
              query: "German pump distributors",
              queries: ["German pump distributors", "industrial pump buyers"],
              sources: [
                { type: "url", url: "https://example.com/buyers" },
                { type: "url", url: "https://www.example.com/about" },
                { type: "url", url: "https://buyers.test/directory" },
                { type: "url", url: "https://trade.test/pumps" },
                { type: "url", url: "https://hidden.test/results" },
                { type: "url", url: "https://extra.test/importers" },
              ],
            },
          }),
        ]}
      />,
    );

    expect(markup).toContain("返回 6 个来源");
    expect(markup).toContain('aria-label="另有 2 个来源域名"');
    expect(markup).toContain(
      '<details class="activity-event__search-details"><summary><span>查看查询与全部来源</span>',
    );
    expect(markup).not.toContain(
      '<details class="activity-event__search-details" open=""',
    );
    expect(markup).toContain(
      "<pre>German pump distributors\nindustrial pump buyers</pre>",
    );
    expect(markup.match(/title="https:\/\//gu)).toHaveLength(6);
  });

  it("keeps a running tool input collapsed behind a native keyboard control", () => {
    const markup = renderToStaticMarkup(
      <ActivityTimeline
        events={[
          event("1", {
            type: "tool_started",
            callId: "tool-running",
            toolName: "create_csv_file",
            title: "正在整理买家清单",
            input: '{"fileName":"buyers.csv"}',
          }),
        ]}
      />,
    );

    expect(markup).toContain("正在整理买家清单");
    expect(markup).toContain("生成通用 CSV · 运行中");
    expect(markup).toContain(
      '<details class="activity-event__tool-details"><summary><span>查看工具输入</span>',
    );
    expect(markup).toContain(
      '<div class="activity-event__tool-details-body"><div class="activity-event__data"><span>输入</span>',
    );
    expect(markup).not.toContain("<span>输出</span>");
  });
});

describe("incomplete activity terminal rendering", () => {
  it("keeps failure and incomplete status visible in compact search rows", () => {
    const searchAction = {
      type: "search" as const,
      query: "private compact query",
      queries: ["private compact query"],
      sources: [{ type: "url" as const, url: "https://example.com/buyers" }],
    };
    const markup = renderToStaticMarkup(
      <ActivityTimeline
        compact
        events={[
          event("1", {
            type: "web_search",
            callId: "search-failed",
            phase: "failed",
            outputIndex: 0,
            providerSequence: 1,
            action: searchAction,
          }),
          event("2", {
            type: "web_search",
            callId: "search-incomplete",
            phase: "searching",
            outputIndex: 1,
            providerSequence: 2,
            action: searchAction,
          }),
          event("3", {
            type: "error",
            error: {
              code: "RUN_REQUIRES_RECONCILIATION",
              message: "运行待对账",
              runId,
            },
          }),
        ]}
      />,
    );

    expect(markup).toContain("网页搜索 · 失败");
    expect(markup).toContain("网页搜索 · 未完成 · 待对账");
    expect(markup).not.toContain("返回 1 个来源");
    expect(markup).not.toContain("private compact query");
    expect(markup).toContain(">example.com<");
  });

  it.each([
    {
      code: "PROVIDER_ERROR",
      searchTitle: "网页搜索失败",
      toolMeta: "保存研究结果 · 失败",
      terminalMeta: "运行失败",
    },
    {
      code: "RUN_CANCELLED",
      searchTitle: "网页搜索已中断",
      toolMeta: "保存研究结果 · 已中断",
      terminalMeta: "运行已停止",
    },
    {
      code: "RUN_REQUIRES_RECONCILIATION",
      searchTitle: "网页搜索未完成",
      toolMeta: "保存研究结果 · 未完成 · 待对账",
      terminalMeta: "运行待对账",
    },
  ] as const)(
    "renders $code without leaving incomplete steps running",
    ({ code, searchTitle, toolMeta, terminalMeta }) => {
      const markup = renderToStaticMarkup(
        <ActivityTimeline
          events={[
            event("1", {
              type: "web_search",
              callId: "search-open",
              phase: "searching",
              outputIndex: 0,
              providerSequence: 1,
              action: null,
            }),
            event("2", {
              type: "tool_started",
              callId: "tool-open",
              toolName: "save_research_results",
              title: "保存客户清单",
              input: "5 家公司",
            }),
            event("3", {
              type: "error",
              error: {
                code,
                message: "运行终止",
                runId,
              },
            }),
          ]}
        />,
      );

      expect(markup).toContain(searchTitle);
      expect(markup).toContain(toolMeta);
      expect(markup).toContain(terminalMeta);
      expect(markup).not.toContain("运行终止");
      expect(markup).not.toContain("网页搜索 · 运行中");
      expect(markup).not.toContain("保存研究结果 · 运行中");
    },
  );

  it("renders unfinished steps as interrupted after done", () => {
    const markup = renderToStaticMarkup(
      <ActivityTimeline
        events={[
          event("1", {
            type: "web_search",
            callId: "search-open",
            phase: "in_progress",
            outputIndex: 0,
            providerSequence: 1,
            action: null,
          }),
          event("2", {
            type: "tool_started",
            callId: "tool-open",
            toolName: "save_research_results",
            title: "保存客户清单",
            input: "5 家公司",
          }),
          event("3", {
            type: "done",
            message: {
              id: "40000000-0000-4000-8000-000000000001",
              runId,
              role: "assistant",
              content: "研究完成",
              citations: [],
              artifacts: [],
              attachments: [],
              feedback: null,
              createdAt: "2026-08-26T08:00:03.000Z",
            },
            credits: { available: 90, reserved: 0 },
          }),
        ]}
      />,
    );

    expect(markup).toContain("网页搜索已中断");
    expect(markup).toContain("保存研究结果 · 已中断");
    expect(markup).not.toContain("运行中");
  });
});
