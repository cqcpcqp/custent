import {
  Children,
  createRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  InputAttachmentTextViewer,
  InputAttachmentTextViewerDialog,
  type InputAttachmentTextViewerProps,
} from "@/components/input-attachment-text-viewer";

const textAttachment = {
  downloadUrl:
    "/api/input-attachments/60000000-0000-4000-8000-000000000030/content",
  mimeType: "text/plain",
  name: "buyers.txt",
  sizeBytes: 2048,
} satisfies InputAttachmentTextViewerProps;

function dialogRefs() {
  return {
    closeButtonRef: createRef<HTMLButtonElement>(),
    downloadActionRef: createRef<HTMLAnchorElement>(),
    previewFocusRef: createRef<HTMLElement>(),
    retryButtonRef: createRef<HTMLButtonElement>(),
  };
}

type InspectableElementProps = {
  children?: ReactNode;
  className?: unknown;
  onClick?: unknown;
  onMouseDown?: unknown;
  [key: string]: unknown;
};

function findElement(
  root: ReactNode,
  predicate: (element: ReactElement<InspectableElementProps>) => boolean,
): ReactElement<InspectableElementProps> | null {
  for (const child of Children.toArray(root)) {
    if (!isValidElement<InspectableElementProps>(child)) {
      continue;
    }
    if (predicate(child)) {
      return child;
    }
    const nested = findElement(child.props.children, predicate);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

describe("input attachment source preview cards", () => {
  it("uses TXT, Markdown, and JSON cards as dialog triggers instead of downloads", () => {
    const markup = renderToStaticMarkup(
      <>
        <InputAttachmentTextViewer {...textAttachment} />
        <InputAttachmentTextViewer
          {...textAttachment}
          mimeType="text/markdown"
          name="brief.md"
        />
        <InputAttachmentTextViewer
          {...textAttachment}
          mimeType="application/json"
          name="criteria.json"
        />
      </>,
    );

    expect(markup).toContain('aria-label="预览源码：buyers.txt"');
    expect(markup).toContain('aria-label="预览源码：brief.md"');
    expect(markup).toContain('aria-label="预览源码：criteria.json"');
    expect(markup.match(/aria-haspopup="dialog"/gu)).toHaveLength(3);
    expect(markup.match(/aria-expanded="false"/gu)).toHaveLength(3);
    expect(markup).toContain("TXT 源码 · 2.0 KB");
    expect(markup).toContain("Markdown 源码 · 2.0 KB");
    expect(markup).toContain("JSON 源码 · 2.0 KB");
    expect(markup).not.toContain("download=\"\"");
    expect(markup).not.toContain(`href="${textAttachment.downloadUrl}"`);
  });
});

describe("input attachment source preview dialog", () => {
  it("routes the close button and backdrop through the supplied close action", () => {
    const onClose = vi.fn();
    const tree = InputAttachmentTextViewerDialog({
      ...textAttachment,
      ...dialogRefs(),
      dialogId: "input-attachment-text-dialog",
      onClose,
      onRetry: () => undefined,
      state: { status: "loading" },
      titleId: "input-attachment-text-title",
    });
    const backdrop = findElement(
      tree,
      (element) =>
        element.props.className ===
        "artifact-viewer-backdrop input-attachment-text-viewer-backdrop",
    );
    const closeButton = findElement(
      tree,
      (element) =>
        element.props["aria-label"] === "关闭源码预览：buyers.txt",
    );
    if (backdrop === null || closeButton === null) {
      throw new Error("附件源码预览缺少关闭路径");
    }
    if (
      typeof backdrop.props.onMouseDown !== "function" ||
      typeof closeButton.props.onClick !== "function"
    ) {
      throw new Error("附件源码预览关闭路径缺少事件处理器");
    }
    const backdropElement = {};
    const preventDefault = vi.fn();

    (
      backdrop.props.onMouseDown as (event: {
        target: object;
        currentTarget: object;
        preventDefault: () => void;
      }) => void
    )({
      target: backdropElement,
      currentTarget: backdropElement,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledTimes(1);

    (closeButton.props.onClick as () => void)();
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders untrusted TXT and Markdown as escaped source with the real download URL", () => {
    const source =
      '<script>alert("source only")</script>\n![remote](https://example.com/pixel.png)';
    const markup = renderToStaticMarkup(
      <InputAttachmentTextViewerDialog
        {...textAttachment}
        {...dialogRefs()}
        dialogId="input-attachment-text-dialog"
        mimeType="text/markdown"
        name="brief.md"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{
          status: "ready",
          content: {
            lineCount: 2,
            presentation: "source",
            source,
          },
        }}
        titleId="input-attachment-text-title"
      />,
    );

    expect(markup).toContain(
      'aria-labelledby="input-attachment-text-title" aria-modal="true"',
    );
    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'id="input-attachment-text-dialog" role="dialog" tabindex="-1"',
    );
    expect(markup).toContain('aria-label="brief.md Markdown 源码预览"');
    expect(markup).toContain('role="region" tabindex="0"');
    expect(markup).toContain("源码预览");
    expect(markup).toContain("2 行");
    expect(markup).toContain(
      '&lt;script&gt;alert(&quot;source only&quot;)&lt;/script&gt;',
    );
    expect(markup).toContain(
      "![remote](https://example.com/pixel.png)",
    );
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain('aria-label="下载原文件：brief.md"');
    expect(markup).toContain(
      `download="" href="${textAttachment.downloadUrl}"`,
    );
  });

  it("labels formatted JSON as a source presentation", () => {
    const markup = renderToStaticMarkup(
      <InputAttachmentTextViewerDialog
        {...textAttachment}
        {...dialogRefs()}
        dialogId="input-attachment-json-dialog"
        mimeType="application/json"
        name="criteria.json"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{
          status: "ready",
          content: {
            lineCount: 3,
            presentation: "formatted-json-source",
            source: '{\n  "market": "DE"\n}',
          },
        }}
        titleId="input-attachment-json-title"
      />,
    );

    expect(markup).toContain("JSON 源码");
    expect(markup).toContain("JSON 已格式化");
    expect(markup).toContain('&quot;market&quot;: &quot;DE&quot;');
  });

  it("announces loading and offers retry on failure without removing download", () => {
    const loadingMarkup = renderToStaticMarkup(
      <InputAttachmentTextViewerDialog
        {...textAttachment}
        {...dialogRefs()}
        dialogId="input-attachment-text-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{ status: "loading" }}
        titleId="input-attachment-text-title"
      />,
    );
    const errorMarkup = renderToStaticMarkup(
      <InputAttachmentTextViewerDialog
        {...textAttachment}
        {...dialogRefs()}
        dialogId="input-attachment-text-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{ status: "error" }}
        titleId="input-attachment-text-title"
      />,
    );

    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain('role="status"');
    expect(loadingMarkup).toContain("正在载入源码预览");
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain("暂时无法载入源码预览");
    expect(errorMarkup).toContain("重新载入");
    expect(errorMarkup).toContain(
      `download="" href="${textAttachment.downloadUrl}"`,
    );
  });
});
