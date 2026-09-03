import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  InputAttachmentSpreadsheetViewer,
  InputAttachmentSpreadsheetViewerDialog,
} from "@/components/input-attachment-spreadsheet-viewer";
import { MessageView } from "@/components/research-message";
import type { ChatMessage } from "@/lib/contracts";

const spreadsheet = {
  downloadUrl:
    "/api/input-attachments/60000000-0000-4000-8000-000000000030/content",
  name: "historical-buyers.xlsx",
  sizeBytes: 12_288,
};

function dialogRefs() {
  return {
    closeButtonRef: createRef<HTMLButtonElement>(),
    downloadActionRef: createRef<HTMLAnchorElement>(),
    previewFocusRef: createRef<HTMLElement>(),
    retryButtonRef: createRef<HTMLButtonElement>(),
  };
}

describe("historical XLSX preview UI", () => {
  it("routes the fixed XLSX attachment contract through a dialog trigger", () => {
    const message: ChatMessage = {
      id: "40000000-0000-4000-8000-000000000030",
      runId: "20000000-0000-4000-8000-000000000030",
      role: "user",
      content: "分析这个表格",
      citations: [],
      artifacts: [],
      attachments: [
        {
          id: "60000000-0000-4000-8000-000000000030",
          kind: "file",
          name: spreadsheet.name,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: spreadsheet.sizeBytes,
          downloadUrl: spreadsheet.downloadUrl,
          createdAt: "2026-09-02T02:00:00.000Z",
        },
      ],
      feedback: null,
      createdAt: "2026-09-02T02:00:01.000Z",
    };

    const markup = renderToStaticMarkup(
      <MessageView
        events={[]}
        isFeedbackPending={false}
        message={message}
        onFeedback={() => undefined}
        onOpenActivity={() => undefined}
        run={null}
      />,
    );

    expect(markup).toContain(
      'aria-label="预览表格：historical-buyers.xlsx"',
    );
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("download=\"\"");
    expect(markup).not.toContain(`href="${spreadsheet.downloadUrl}"`);
  });

  it("renders a standalone XLSX trigger as a button rather than a download link", () => {
    const markup = renderToStaticMarkup(
      <InputAttachmentSpreadsheetViewer {...spreadsheet} />,
    );
    expect(markup.startsWith("<button")).toBe(true);
    expect(markup).toContain("XLSX · 12.0 KB");
    expect(markup).not.toContain("href=");
  });

  it("renders tabs, row/column headings, sparse row numbers, and inert cell text", () => {
    const markup = renderToStaticMarkup(
      <InputAttachmentSpreadsheetViewerDialog
        {...spreadsheet}
        {...dialogRefs()}
        dialogId="spreadsheet-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{
          status: "ready",
          content: {
            activeSheetIndex: 0,
            sheets: [
              {
                name: "Buyers",
                columnLabels: ["A", "B"],
                rowNumbers: [1, 3],
                rows: [
                  ["Company", "Website"],
                  ["<script>alert(1)</script>", '=HYPERLINK("https://x")'],
                ],
              },
              {
                name: "Summary",
                columnLabels: ["A"],
                rowNumbers: [1],
                rows: [["2 companies"]],
              },
            ],
          },
        }}
        titleId="spreadsheet-title"
      />,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain(
      'aria-controls="spreadsheet-dialog-sheet-panel" aria-selected="true"',
    );
    expect(markup).toContain('role="tab" tabindex="0"');
    expect(markup).toContain('aria-selected="false"');
    expect(markup).toContain('role="tab" tabindex="-1"');
    expect(markup).toContain(
      'aria-labelledby="spreadsheet-dialog-sheet-tab-0"',
    );
    expect(markup).toContain('role="tabpanel" tabindex="0"');
    expect(markup).toContain('<th scope="col">A</th>');
    expect(markup).toContain('scope="row">3</th>');
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain(
      "=HYPERLINK(&quot;https://x&quot;)",
    );
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain('href="https://x"');
    expect(markup).toContain(
      `download="" href="${spreadsheet.downloadUrl}"`,
    );
  });

  it("keeps invalid XLSX errors non-retryable while retaining original download", () => {
    const markup = renderToStaticMarkup(
      <InputAttachmentSpreadsheetViewerDialog
        {...spreadsheet}
        {...dialogRefs()}
        dialogId="spreadsheet-dialog"
        onClose={() => undefined}
        onRetry={() => undefined}
        state={{ status: "error", reason: "invalid_xlsx" }}
        titleId="spreadsheet-title"
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("无法显示 XLSX 表格预览");
    expect(markup).toContain("文件结构或大小超出安全预览范围");
    expect(markup).not.toContain("重新载入");
    expect(markup).toContain(
      `download="" href="${spreadsheet.downloadUrl}"`,
    );
  });
});

