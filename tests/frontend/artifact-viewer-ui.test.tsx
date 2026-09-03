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
  ArtifactCards,
  ArtifactViewerDialog,
} from "@/components/artifact-viewer";
import type { ArtifactSummary } from "@/lib/contracts";

const csvArtifact: ArtifactSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "buyer-list.csv",
  mimeType: "text/csv",
  sizeBytes: 4096,
  downloadUrl:
    "/api/artifacts/10000000-0000-4000-8000-000000000001/download",
  createdAt: "2026-08-27T08:30:00.000Z",
};

const pdfArtifact: ArtifactSummary = {
  ...csvArtifact,
  id: "10000000-0000-4000-8000-000000000002",
  name: "buyer-report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 8192,
  downloadUrl:
    "/api/artifacts/10000000-0000-4000-8000-000000000002/download",
};

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

describe("artifact preview cards", () => {
  it("uses the file card as a dialog trigger instead of an implicit download", () => {
    const markup = renderToStaticMarkup(
      <ArtifactCards artifacts={[csvArtifact, pdfArtifact]} />,
    );

    expect(markup).toContain('aria-label="生成文件"');
    expect(markup).toContain('aria-label="预览文件：buyer-list.csv"');
    expect(markup).toContain('aria-label="预览文件：buyer-report.pdf"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).not.toContain("download=\"\"");
    expect(markup).not.toContain(`href="${csvArtifact.downloadUrl}"`);
  });
});

describe("artifact preview dialog", () => {
  it("routes the close button and backdrop through the supplied close action", () => {
    const onClose = vi.fn();
    const tree = ArtifactViewerDialog({
      artifact: csvArtifact,
      ...dialogRefs(),
      dialogId: "artifact-dialog",
      onClose,
      onRetry: () => undefined,
      state: { status: "loading" },
      titleId: "artifact-title",
    });
    const backdrop = findElement(
      tree,
      (element) => element.props.className === "artifact-viewer-backdrop",
    );
    const closeButton = findElement(
      tree,
      (element) =>
        element.props["aria-label"] === "关闭文件预览：buyer-list.csv",
    );
    if (backdrop === null || closeButton === null) {
      throw new Error("文件预览缺少关闭路径");
    }
    if (
      typeof backdrop.props.onMouseDown !== "function" ||
      typeof closeButton.props.onClick !== "function"
    ) {
      throw new Error("文件预览关闭路径缺少事件处理器");
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

  it("renders an accessible CSV table and a distinct download action", () => {
    const markup = renderToStaticMarkup(
      <ArtifactViewerDialog
        artifact={csvArtifact}
        {...dialogRefs()}
        dialogId="artifact-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{
          status: "ready",
          content: {
            kind: "csv",
            document: {
              columns: ["company", "country"],
              rows: [
                ["Acme", "US"],
                ["Globe", "DE"],
              ],
            },
          },
        }}
        titleId="artifact-title"
      />,
    );

    expect(markup).toContain(
      'aria-labelledby="artifact-title" aria-modal="true"',
    );
    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'id="artifact-dialog" role="dialog" tabindex="-1"',
    );
    expect(markup).toContain('id="artifact-title"');
    expect(markup).toContain('aria-label="下载文件：buyer-list.csv"');
    expect(markup).toContain('aria-label="关闭文件预览：buyer-list.csv"');
    expect(markup).toContain(
      `download="" href="${csvArtifact.downloadUrl}"`,
    );
    expect(markup).toContain('role="region" tabindex="0"');
    expect(markup).toContain('<th scope="col">company</th>');
    expect(markup).toContain("Acme");
    expect(markup).toContain("2 行");
    expect(markup).toContain("2 列");
  });

  it("renders untrusted CSV cells as inert text instead of HTML, links, or formulas", () => {
    const markup = renderToStaticMarkup(
      <ArtifactViewerDialog
        artifact={csvArtifact}
        {...dialogRefs()}
        dialogId="artifact-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{
          status: "ready",
          content: {
            kind: "csv",
            document: {
              columns: ['<img src=x onerror="alert(1)">'],
              rows: [
                ['=HYPERLINK("https://attacker.example")'],
                ["<script>alert(1)</script>"],
              ],
            },
          },
        }}
        titleId="artifact-title"
      />,
    );

    expect(markup).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(markup).toContain(
      "=HYPERLINK(&quot;https://attacker.example&quot;)",
    );
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain('href="https://attacker.example"');
  });

  it("renders the fetched PDF through the in-app canvas viewer while retaining the source download", () => {
    const markup = renderToStaticMarkup(
      <ArtifactViewerDialog
        artifact={pdfArtifact}
        {...dialogRefs()}
        dialogId="artifact-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{
          status: "ready",
          content: {
            kind: "pdf",
            blob: new Blob(["%PDF-1.7"], { type: "application/pdf" }),
          },
        }}
        titleId="artifact-title"
      />,
    );

    expect(markup).toContain(
      'aria-label="buyer-report.pdf PDF 文档预览"',
    );
    expect(markup).toContain('role="region" tabindex="0"');
    expect(markup).toContain("正在解析 PDF 文档");
    expect(markup).toContain(
      `download="" href="${pdfArtifact.downloadUrl}"`,
    );
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain(`src="${pdfArtifact.downloadUrl}"`);
  });

  it("announces loading and offers retry only when preview loading is unavailable", () => {
    const loadingMarkup = renderToStaticMarkup(
      <ArtifactViewerDialog
        artifact={csvArtifact}
        {...dialogRefs()}
        dialogId="artifact-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{ status: "loading" }}
        titleId="artifact-title"
      />,
    );
    const errorMarkup = renderToStaticMarkup(
      <ArtifactViewerDialog
        artifact={csvArtifact}
        {...dialogRefs()}
        dialogId="artifact-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{ status: "error", reason: "unavailable" }}
        titleId="artifact-title"
      />,
    );

    expect(loadingMarkup).toContain('aria-busy="true"');
    expect(loadingMarkup).toContain('role="status"');
    expect(loadingMarkup).toContain("正在载入CSV预览");
    expect(errorMarkup).toContain('role="alert"');
    expect(errorMarkup).toContain("重新载入");
    expect(errorMarkup).toContain(
      `download="" href="${csvArtifact.downloadUrl}"`,
    );
  });

  it("uses a fixed non-retryable state for an empty or malformed CSV", () => {
    const markup = renderToStaticMarkup(
      <ArtifactViewerDialog
        artifact={csvArtifact}
        {...dialogRefs()}
        dialogId="artifact-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{ status: "error", reason: "invalid_csv" }}
        titleId="artifact-title"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("无法显示 CSV 表格预览");
    expect(markup).toContain("文件为空或不符合严格 CSV 格式");
    expect(markup).not.toContain("重新载入");
    expect(markup).toContain(
      `download="" href="${csvArtifact.downloadUrl}"`,
    );
  });
});
