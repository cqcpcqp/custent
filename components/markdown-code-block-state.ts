import hljs from "highlight.js/lib/common";

export type CodeBlockClipboard = {
  writeText: (content: string) => Promise<void>;
};

export type CodeBlockCopyResult =
  | { status: "copied"; message: "已复制代码" }
  | { status: "error"; message: string };

export type CodeBlockCopyPresentation = {
  ariaLabel: string;
  status: "idle" | "copying" | "copied" | "error";
  text: "复制" | "正在复制" | "已复制" | "复制失败";
};

export type MarkdownCodeHighlight = {
  highlighted: boolean;
  html: string;
};

export type CodeBlockCopyOperation<Identity> = {
  identity: Identity;
  sequence: number;
};

export function nextCodeBlockCopyOperation<Identity>(
  identity: Identity,
  previousSequence: number,
): CodeBlockCopyOperation<Identity> {
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) {
    throw new TypeError("代码复制 operation 序号无效");
  }
  const sequence = previousSequence + 1;
  if (!Number.isSafeInteger(sequence)) {
    throw new TypeError("代码复制 operation 序号已超出安全整数范围");
  }
  return { identity, sequence };
}

export function codeBlockCopyOperationIsCurrent<Identity>(
  operation: CodeBlockCopyOperation<Identity>,
  current: CodeBlockCopyOperation<Identity>,
): boolean {
  return (
    operation.sequence === current.sequence &&
    operation.identity === current.identity
  );
}

const markdownLanguageClass =
  /^language-([A-Za-z0-9][A-Za-z0-9_+#.-]{0,39})$/u;

/**
 * React Markdown derives this class from the fenced-code info string. Only an
 * exact, display-safe language class is accepted; the code itself is never
 * inspected to infer a language or an execution capability.
 */
export function parseMarkdownCodeLanguage(
  className: string | undefined,
): string | null {
  if (className === undefined) {
    return null;
  }
  return markdownLanguageClass.exec(className)?.[1] ?? null;
}

/**
 * mdast-util-to-hast appends one rendering newline to every fenced code node.
 * Remove only that synthetic newline, preserving any intentional blank line.
 */
export function markdownCodeText(renderedText: string): string {
  return renderedText.endsWith("\n") ? renderedText.slice(0, -1) : renderedText;
}

function escapeHtml(content: string): string {
  return content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/**
 * Highlight only an explicitly labeled, registered language. Unknown and
 * unlabeled fences remain escaped plain text; their contents are never used to
 * guess a language.
 */
export function highlightMarkdownCode(
  content: string,
  language: string | null,
): MarkdownCodeHighlight {
  if (language === null || hljs.getLanguage(language) === undefined) {
    return { highlighted: false, html: escapeHtml(content) };
  }

  return {
    highlighted: true,
    html: hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    }).value,
  };
}

export function codeBlockCopyPresentation(
  feedback: CodeBlockCopyResult | null,
  isCopying: boolean,
): CodeBlockCopyPresentation {
  if (isCopying) {
    return {
      ariaLabel: "正在复制代码",
      status: "copying",
      text: "正在复制",
    };
  }
  if (feedback?.status === "copied") {
    return {
      ariaLabel: "代码已复制",
      status: "copied",
      text: "已复制",
    };
  }
  if (feedback?.status === "error") {
    return {
      ariaLabel: feedback.message,
      status: "error",
      text: "复制失败",
    };
  }
  return { ariaLabel: "复制代码", status: "idle", text: "复制" };
}

export async function copyMarkdownCode(
  content: string,
  clipboard: CodeBlockClipboard | null,
): Promise<CodeBlockCopyResult> {
  if (clipboard === null) {
    return {
      status: "error",
      message: "当前环境无法访问剪贴板。",
    };
  }

  try {
    await clipboard.writeText(content);
    return { status: "copied", message: "已复制代码" };
  } catch {
    return {
      status: "error",
      message: "复制失败，请检查剪贴板权限后重试。",
    };
  }
}
