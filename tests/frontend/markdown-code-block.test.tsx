import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  codeBlockCopyOperationIsCurrent,
  codeBlockCopyPresentation,
  copyMarkdownCode,
  highlightMarkdownCode,
  markdownCodeText,
  nextCodeBlockCopyOperation,
  parseMarkdownCodeLanguage,
} from "@/components/markdown-code-block-state";
import { MessageView, StreamingMessage } from "@/components/research-message";
import type { AgentRun, ChatMessage, Citation } from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

function renderAssistant(content: string, citations: Citation[] = []): string {
  const message: ChatMessage = {
    id: "10000000-0000-4000-8000-000000000001",
    runId: null,
    role: "assistant",
    content,
    citations,
    artifacts: [],
    attachments: [],
    feedback: null,
    createdAt: "2026-08-26T08:00:00.000Z",
  };

  return renderToStaticMarkup(
    <MessageView
      events={[]}
      isFeedbackPending={false}
      message={message}
      onFeedback={() => undefined}
      onOpenActivity={() => undefined}
      run={null}
    />,
  );
}

describe("Markdown fenced code block UI", () => {
  it("renders an unlabeled fence as a code block with its own copy control", () => {
    const markup = renderAssistant("```\nconst answer = 42;\n```");

    expect(markup).toContain('class="markdown-code-block"');
    expect(markup).toContain(
      '<span class="markdown-code-block__language">代码</span>',
    );
    expect(markup).toContain('aria-label="复制代码"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("<pre><code>const answer = 42;</code></pre>");
  });

  it("shows only the strictly parsed fence language and preserves its class", () => {
    const markup = renderAssistant(
      "```tsx\nexport const Buyer = () => <strong>Acme</strong>;\n```",
    );

    expect(markup).toContain(
      '<span class="markdown-code-block__language">tsx</span>',
    );
    expect(markup).toContain('<code class="language-tsx hljs">');
    expect(markup).toContain('class="hljs-keyword"');
    expect(markup).toContain('<span class="hljs-title function_">Buyer</span>');
    expect(markup).toContain('&lt;<span class="hljs-name">strong</span>&gt;');
    expect(markup).toContain("Acme");
  });

  it("keeps inline code separate from fenced-code controls", () => {
    const markup = renderAssistant("请运行 `pnpm test` 验证改动。");

    expect(markup).toContain("<code>pnpm test</code>");
    expect(markup).not.toContain('class="markdown-code-block"');
    expect(markup).not.toContain('aria-label="复制代码"');
  });

  it("coexists with Markdown links and indexed inline citations", () => {
    const content =
      "阅读 [采购文档](https://buyer.example/docs) 后查看示例。\n\n```json\n{\"market\":\"DE\"}\n```";
    const citedText = "查看示例";
    const startIndex = content.indexOf(citedText);
    const markup = renderAssistant(content, [
      {
        url: "https://source.example/research",
        title: "研究来源",
        startIndex,
        endIndex: startIndex + citedText.length,
      },
    ]);

    expect(markup).toContain(
      'href="https://buyer.example/docs" rel="noreferrer" target="_blank"',
    );
    expect(markup).toContain(
      '查看示例<sup aria-label="引用来源：1" class="inline-citation-group"',
    );
    expect(markup).toContain('<code class="language-json hljs">');
    expect(markup).toContain('aria-label="复制代码"');
  });

  it("keeps streaming fenced code escaped and plain until the run is terminal", () => {
    const run: AgentRun = {
      id: "20000000-0000-4000-8000-000000000001",
      requestId: "30000000-0000-4000-8000-000000000001",
      conversationId: "40000000-0000-4000-8000-000000000001",
      inputMessageId: "50000000-0000-4000-8000-000000000001",
      assistantMessageId: null,
      status: "running",
      conversationTurn: "1",
      attemptIndex: 1,
      predecessorRunId: null,
      retryOfRunId: null,
      regenerateOfRunId: null,
      executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
      failure: null,
      createdAt: "2026-08-26T08:00:00.000Z",
      startedAt: "2026-08-26T08:00:01.000Z",
      finishedAt: null,
      cancelRequestedAt: null,
    };
    const markup = renderToStaticMarkup(
      <StreamingMessage
        artifacts={[]}
        connectionState={{ phase: "idle" }}
        events={[]}
        onOpenActivity={() => undefined}
        run={run}
        text={"```tsx\nconst Buyer = () => <strong>Acme</strong>;\n```"}
      />,
    );

    expect(markup).toContain('<code class="language-tsx">');
    expect(markup).toContain("&lt;strong&gt;Acme&lt;/strong&gt;");
    expect(markup).not.toContain('class="language-tsx hljs"');
    expect(markup).not.toContain('class="hljs-keyword"');
  });
});

describe("Markdown code block state", () => {
  it("parses only an exact display-safe language class without inference", () => {
    expect(parseMarkdownCodeLanguage("language-c++")).toBe("c++");
    expect(parseMarkdownCodeLanguage("language-objective-c")).toBe(
      "objective-c",
    );
    expect(parseMarkdownCodeLanguage(undefined)).toBeNull();
    expect(parseMarkdownCodeLanguage("tsx")).toBeNull();
    expect(parseMarkdownCodeLanguage("language-ts extra-class")).toBeNull();
    expect(parseMarkdownCodeLanguage("language-<script>")).toBeNull();
  });

  it("removes only the renderer newline and preserves an intentional blank line", () => {
    expect(markdownCodeText("const value = 1;\n")).toBe("const value = 1;");
    expect(markdownCodeText("line\n\n")).toBe("line\n");
    expect(markdownCodeText("inline-shaped text")).toBe("inline-shaped text");
  });

  it("highlights only a declared registered language and safely escapes unknown code", () => {
    const highlighted = highlightMarkdownCode(
      'const buyer = "Acme";',
      "javascript",
    );
    expect(highlighted.highlighted).toBe(true);
    expect(highlighted.html).toContain('class="hljs-keyword"');

    expect(
      highlightMarkdownCode('<script>alert("x")</script>', "buyerlang"),
    ).toEqual({
      highlighted: false,
      html: "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    });
  });

  it("keeps copy errors visibly distinguishable as well as announced", () => {
    expect(codeBlockCopyPresentation(null, false)).toEqual({
      ariaLabel: "复制代码",
      status: "idle",
      text: "复制",
    });
    expect(
      codeBlockCopyPresentation(
        { status: "error", message: "复制失败，请检查剪贴板权限后重试。" },
        false,
      ),
    ).toEqual({
      ariaLabel: "复制失败，请检查剪贴板权限后重试。",
      status: "error",
      text: "复制失败",
    });
  });

  it("copies the displayed code through Clipboard API", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(
      copyMarkdownCode("const buyer = 'Acme';", { writeText }),
    ).resolves.toEqual({ status: "copied", message: "已复制代码" });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("const buyer = 'Acme';");
  });

  it("returns an announced error when Clipboard API rejects the write", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });

    await expect(copyMarkdownCode("SELECT 1;", { writeText })).resolves.toEqual({
      status: "error",
      message: "复制失败，请检查剪贴板权限后重试。",
    });
  });

  it("discards a deferred clipboard result after code is rerendered", async () => {
    let resolveWrite: (() => void) | undefined;
    const writeFinished = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const writeText = vi.fn(() => writeFinished);
    const firstIdentity = { code: "const first = true;" };
    const firstOperation = nextCodeBlockCopyOperation(firstIdentity, 0);
    let currentOperation = firstOperation;

    const pendingResult = copyMarkdownCode(firstIdentity.code, {
      writeText,
    }).then((result) =>
      codeBlockCopyOperationIsCurrent(firstOperation, currentOperation)
        ? result
        : null,
    );

    currentOperation = nextCodeBlockCopyOperation(
      { code: "const second = true;" },
      firstOperation.sequence,
    );
    resolveWrite?.();

    await expect(pendingResult).resolves.toBeNull();
    expect(writeText).toHaveBeenCalledWith("const first = true;");
  });
});
