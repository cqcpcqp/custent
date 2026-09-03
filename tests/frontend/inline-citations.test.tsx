import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  groupInlineCitationsByEndIndex,
  prepareInlineCitations,
} from "@/components/inline-citation-state";
import { markdownTextRenderedOffsets } from "@/components/inline-citation-markdown";
import {
  MessageSourcesAction,
  MessageView,
  type OpenCitationSources,
} from "@/components/research-message";
import type { ChatMessage, Citation } from "@/lib/contracts";

function citation(
  title: string,
  startIndex: number,
  endIndex: number,
): Citation {
  return {
    url: `https://example.com/${title.toLowerCase().replaceAll(" ", "-")}`,
    title,
    startIndex,
    endIndex,
  };
}

const messageId = "10000000-0000-4000-8000-000000000001";

function assistantMessage(content: string, citations: Citation[]): ChatMessage {
  return {
    id: messageId,
    runId: null,
    role: "assistant",
    content,
    citations,
    artifacts: [],
    attachments: [],
    feedback: null,
    createdAt: "2026-08-26T08:00:00.000Z",
  };
}

function assistantView(
  content: string,
  citations: Citation[],
  onOpenSources: OpenCitationSources = () => undefined,
): ReactElement {
  return MessageView({
    events: [],
    isFeedbackPending: false,
    message: assistantMessage(content, citations),
    onFeedback: () => undefined,
    onOpenActivity: () => undefined,
    onOpenSources,
    run: null,
  });
}

function renderAssistant(content: string, citations: Citation[]): string {
  return renderToStaticMarkup(assistantView(content, citations));
}

function descendantElements(node: ReactNode): ReactElement[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return [];
  }
  return [
    node,
    ...Children.toArray(node.props.children).flatMap(descendantElements),
  ];
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1;
}

describe("inline citation state", () => {
  it("maps entity and backslash-escape source boundaries to rendered text", () => {
    expect(markdownTextRenderedOffsets("AT&amp;T", "AT&T")).toEqual([
      0,
      1,
      2,
      null,
      null,
      null,
      null,
      3,
      4,
    ]);
    expect(markdownTextRenderedOffsets("\\*literal\\*", "*literal*")).toEqual([
      0,
      null,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      null,
      9,
    ]);
    expect(
      markdownTextRenderedOffsets("&NotEqualTilde;", "≂̸"),
    ).toHaveLength("&NotEqualTilde;".length + 1);
  });

  it("numbers unordered citations by first text appearance without mutating input", () => {
    const content = "Alpha beta gamma";
    const input = [
      citation("Gamma", 11, 16),
      citation("Alpha", 0, 5),
      citation("Beta", 6, 10),
    ];

    const result = prepareInlineCitations(content, input);

    expect(result.map(({ citation: item, citedText, number }) => ({
      citedText,
      number,
      title: item.title,
    }))).toEqual([
      { citedText: "Alpha", number: 1, title: "Alpha" },
      { citedText: "beta", number: 2, title: "Beta" },
      { citedText: "gamma", number: 3, title: "Gamma" },
    ]);
    expect(input.map(({ title }) => title)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("preserves overlapping and same-position citations as distinct identities", () => {
    const content = "abcdefghij";
    const exactFirst = citation("Exact first", 2, 8);
    const overlap = citation("Overlap", 0, 6);
    const exactSecond = citation("Exact second", 2, 8);
    const prepared = prepareInlineCitations(content, [
      exactFirst,
      overlap,
      exactSecond,
    ]);

    expect(prepared.map(({ citation: item, number, originalIndex }) => ({
      number,
      originalIndex,
      title: item.title,
    }))).toEqual([
      { number: 1, originalIndex: 1, title: "Overlap" },
      { number: 2, originalIndex: 0, title: "Exact first" },
      { number: 3, originalIndex: 2, title: "Exact second" },
    ]);
    expect(groupInlineCitationsByEndIndex(prepared)).toEqual([
      { citations: [prepared[0]], endIndex: 6 },
      { citations: [prepared[1], prepared[2]], endIndex: 8 },
    ]);
  });

  it("keeps duplicate URL/title/span entries and accepts exact text boundaries", () => {
    const content = "Edge";
    const duplicate = citation("Duplicate", 0, 4);
    const prepared = prepareInlineCitations(content, [
      duplicate,
      duplicate,
      citation("Before", 0, 0),
      citation("After", 4, 4),
    ]);

    expect(prepared).toHaveLength(4);
    expect(prepared.map(({ citedText, number, originalIndex }) => ({
      citedText,
      number,
      originalIndex,
    }))).toEqual([
      { citedText: "", number: 1, originalIndex: 2 },
      { citedText: "Edge", number: 2, originalIndex: 0 },
      { citedText: "Edge", number: 3, originalIndex: 1 },
      { citedText: "", number: 4, originalIndex: 3 },
    ]);
  });

  it.each([
    {
      citation: citation("Negative start", -1, 2),
      expected: "字符索引不是非负安全整数",
    },
    {
      citation: citation("Reversed", 4, 3),
      expected: "字符区间起点晚于终点",
    },
    {
      citation: citation("Out of bounds", 0, 11),
      expected: "字符区间超出回答正文",
    },
  ])("rejects an invalid fixed-contract range: $expected", ({
    citation: invalidCitation,
    expected,
  }) => {
    expect(() =>
      prepareInlineCitations("0123456789", [invalidCitation]),
    ).toThrow(expected);
  });
});

describe("assistant inline citation UI", () => {
  it("wraps Markdown tables in a keyboard-scrollable region", () => {
    const markup = renderAssistant(
      "| 公司 | 官网 |\n| --- | --- |\n| Bosch | https://bosch.com |",
      [],
    );

    expect(markup).toContain(
      'aria-label="表格，可横向滚动" class="research-markdown__table-scroll markdown-table__scroll" role="region" tabindex="0"',
    );
    expect(markup).toContain('aria-label="复制表格"');
    expect(markup).toContain('class="markdown-table__feedback visually-hidden"');
    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>公司</th>");
  });

  it("keeps Markdown text and inserts clickable domain source pills at span ends", () => {
    const content = "**Acme** imports pumps in Europe.";
    const pumpsStart = content.indexOf("pumps");
    const europeStart = content.indexOf("Europe");
    const markup = renderAssistant(content, [
      {
        ...citation(
          "Europe market",
          europeStart,
          europeStart + "Europe".length,
        ),
        url: "https://market.example/europe",
      },
      {
        ...citation("Pump catalog", pumpsStart, pumpsStart + "pumps".length),
        url: "https://www.catalog.example/pumps",
      },
    ]);

    expect(markup).toContain("<strong>Acme</strong>");
    expect(markup).toContain(
      'pumps<sup aria-label="引用来源：1" class="inline-citation-group" role="group">',
    );
    expect(markup).toContain(
      'Europe<sup aria-label="引用来源：2" class="inline-citation-group" role="group">',
    );
    expect(markup).toContain(
      'aria-controls="citation-sources-panel" aria-haspopup="dialog" aria-label="来源 1：Pump catalog" class="inline-citation"',
    );
    expect(markup).toContain(
      'aria-controls="citation-sources-panel" aria-haspopup="dialog" aria-label="来源 2：Europe market" class="inline-citation"',
    );
    expect(markup).not.toContain('href="https://www.catalog.example/pumps"');
    expect(markup).toContain(
      '<span class="inline-citation__host">catalog.example</span>',
    );
    expect(markup).toContain(
      '<span class="inline-citation__host">market.example</span>',
    );
    expect(markup).toContain('aria-label="来源 1：Pump catalog"');
    expect(markup).toContain('aria-label="来源 2：Europe market"');
    expect(markup).toContain('aria-label="查看回答来源，共 2 个"');
    expect(markup).toContain("<span>来源 2</span>");
    expect(markup.indexOf("Pump catalog")).toBeLessThan(
      markup.indexOf("Europe market"),
    );
    expect(markup).not.toContain('class="source-card"');
  });

  it("opens the complete sources panel from the assistant footer entry", () => {
    const content = "Acme imports pumps.";
    const pumpsStart = content.indexOf("pumps");
    const onOpenSources = vi.fn<OpenCitationSources>();
    const citations = prepareInlineCitations(content, [
      citation("Pump catalog", pumpsStart, pumpsStart + "pumps".length),
    ]);
    const action = MessageSourcesAction({
      citations,
      messageId,
      onOpenSources,
    });
    if (action === null) {
      throw new Error("有引用的回答缺少来源入口");
    }
    const sourceButton = descendantElements(action).find(
      (element) =>
        element.type === "button" &&
        (element.props as { className?: string }).className ===
          "message-action-button message-sources-action",
    );
    if (sourceButton === undefined) {
      throw new Error("回答中缺少底部来源按钮");
    }
    const trigger = {} as HTMLButtonElement;
    const onClick = (
      sourceButton.props as {
        onClick: (event: { currentTarget: HTMLButtonElement }) => void;
      }
    ).onClick;

    onClick({ currentTarget: trigger });

    expect(onOpenSources).toHaveBeenCalledOnce();
    expect(onOpenSources).toHaveBeenCalledWith(
      messageId,
      citations,
      1,
      trigger,
    );
  });

  it("renders overlaps independently and groups sources sharing one end index", () => {
    const content = "abcdefghij";
    const markup = renderAssistant(content, [
      citation("Same end B", 4, 8),
      citation("Overlap", 0, 6),
      citation("Same end A", 2, 8),
    ]);

    expect(markup).toContain(
      'abcdef<sup aria-label="引用来源：1" class="inline-citation-group" role="group">',
    );
    expect(markup).toContain(
      'gh<sup aria-label="引用来源：2、3" class="inline-citation-group" role="group">',
    );
    expect(occurrences(markup, 'class="inline-citation"')).toBe(2);
    expect(occurrences(markup, 'class="inline-citation__count"')).toBe(1);
    expect(markup).toContain('<span class="inline-citation__count">+1</span>');
    expect(markup).toContain('aria-label="查看回答来源，共 3 个"');
    expect(markup).not.toContain('class="source-card"');
  });

  it("keeps every source link available when no sources panel is supplied", () => {
    const content = "Acme imports pumps.";
    const pumpsStart = content.indexOf("pumps");
    const markup = renderToStaticMarkup(
      <MessageView
        events={[]}
        isFeedbackPending={false}
        message={assistantMessage(content, [
          citation("Primary", pumpsStart, pumpsStart + "pumps".length),
          citation("Secondary", pumpsStart, pumpsStart + "pumps".length),
        ])}
        onFeedback={() => undefined}
        onOpenActivity={() => undefined}
        run={null}
      />,
    );

    expect(markup).toContain('href="https://example.com/primary"');
    expect(occurrences(markup, 'class="source-card"')).toBe(2);
    expect(markup).toContain('<span class="inline-citation__count">+1</span>');
    expect(markup).not.toContain("message-sources-action");
  });

  it("places zero-length boundary citations before and after the text", () => {
    const markup = renderAssistant("Edge", [
      citation("After", 4, 4),
      citation("Before", 0, 0),
    ]);

    expect(markup).toContain(
      '<p><sup aria-label="引用来源：1" class="inline-citation-group" role="group">',
    );
    expect(markup).toContain(
      '</sup>Edge<sup aria-label="引用来源：2" class="inline-citation-group" role="group">',
    );
  });

  it("never nests an inline citation inside an existing Markdown link", () => {
    const content = "See [Acme catalog](https://acme.example/catalog) today.";
    const catalogStart = content.indexOf("Acme catalog");
    const markup = renderAssistant(content, [
      citation(
        "Catalog source",
        catalogStart,
        catalogStart + "Acme catalog".length,
      ),
    ]);

    const markdownLinkEnd = markup.indexOf("</a>");
    const inlineCitationStart = markup.indexOf(
      '<sup aria-label="引用来源：1"',
    );
    expect(markdownLinkEnd).toBeGreaterThan(-1);
    expect(inlineCitationStart).toBeGreaterThan(markdownLinkEnd);
    expect(markup.slice(0, inlineCitationStart)).not.toContain(
      'class="inline-citation"',
    );
  });

  it.each([
    {
      content: "AT&amp;T grows quickly.",
      citedSource: "AT&amp;T",
      renderedText: "AT&amp;T",
      title: "Entity source",
    },
    {
      content: "Use \\*literal\\* text here.",
      citedSource: "Use \\*literal\\* text",
      renderedText: "Use *literal* text",
      title: "Escaped source",
    },
    {
      content: "Value &NotEqualTilde; target.",
      citedSource: "Value &NotEqualTilde;",
      renderedText: "Value ≂̸",
      title: "Multi-codepoint entity",
    },
  ])(
    "places $title after the exact rendered boundary",
    ({ citedSource, content, renderedText, title }) => {
      const markup = renderAssistant(content, [
        citation(title, 0, citedSource.length),
      ]);

      expect(markup).toContain(
        `${renderedText}<sup aria-label="引用来源：1"`,
      );
    },
  );

  it("surfaces out-of-bounds citations instead of hiding or correcting them", () => {
    expect(() =>
      renderAssistant("Short", [citation("Broken", 0, 9)]),
    ).toThrow("字符区间超出回答正文");
  });
});
