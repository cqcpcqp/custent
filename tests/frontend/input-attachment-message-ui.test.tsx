import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttachmentImageViewerDialog } from "@/components/attachment-image-viewer";
import { ArtifactViewerDialog } from "@/components/artifact-viewer";
import { MessageView } from "@/components/research-message";
import type { ChatMessage, InputAttachmentSummary } from "@/lib/contracts";
import {
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_IMAGE_MIME_TYPES,
} from "@/lib/input-attachment-formats";

function openingTag(markup: string, marker: string): string {
  const markerIndex = markup.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find markup marker: ${marker}`);
  }
  const start = markup.lastIndexOf("<", markerIndex);
  const end = markup.indexOf(">", markerIndex);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find opening tag for marker: ${marker}`);
  }
  return markup.slice(start, end + 1);
}

const historicalCsvAttachment = {
  id: "60000000-0000-4000-8000-000000000010",
  kind: "file",
  name: "historical-buyers.csv",
  mimeType: "text/csv",
  sizeBytes: 3072,
  downloadUrl:
    "/api/input-attachments/60000000-0000-4000-8000-000000000010/content",
  createdAt: "2026-08-26T08:00:01.000Z",
} satisfies InputAttachmentSummary;

const historicalPdfAttachment = {
  ...historicalCsvAttachment,
  id: "60000000-0000-4000-8000-000000000011",
  name: "historical-report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 8192,
  downloadUrl:
    "/api/input-attachments/60000000-0000-4000-8000-000000000011/content",
} satisfies InputAttachmentSummary;

describe("expanded input attachment message cards", () => {
  it("renders every fixed image kind as an image and OOXML as a file", () => {
    const imageAttachments: InputAttachmentSummary[] =
      INPUT_ATTACHMENT_IMAGE_MIME_TYPES.map((mimeType, index) => ({
        id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        kind: "image" as const,
        name: `factory${inputAttachmentFormatSpecifications[mimeType].extensions[0]}`,
        mimeType,
        sizeBytes: 2048 + index,
        downloadUrl: `/api/input-attachments/image-${index + 1}/content`,
        createdAt: `2026-08-26T08:00:0${index}.000Z`,
      }));
    const message: ChatMessage = {
      id: "40000000-0000-4000-8000-000000000001",
      runId: "20000000-0000-4000-8000-000000000001",
      role: "user",
      content: "分析附件",
      citations: [],
      artifacts: [],
      attachments: [
        ...imageAttachments,
        {
          id: "60000000-0000-4000-8000-000000000005",
          kind: "file",
          name: "catalog.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 4096,
          downloadUrl: "/api/input-attachments/document/content",
          createdAt: "2026-08-26T08:00:01.000Z",
        },
      ],
      feedback: null,
      createdAt: "2026-08-26T08:00:02.000Z",
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
      'class="message-input-attachment message-input-attachment--image"',
    );
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    for (const attachment of imageAttachments) {
      const marker = `aria-label="预览图片：${attachment.name}"`;
      expect(markup).toContain(marker);
      const imageTrigger = openingTag(markup, marker);
      expect(imageTrigger.startsWith("<button")).toBe(true);
      expect(imageTrigger).not.toContain("download");
      expect(imageTrigger).not.toContain("href=");
      expect(markup).toContain(`src="${attachment.downloadUrl}"`);
    }
    expect(markup).toContain(
      'class="message-input-attachment message-input-attachment--file"',
    );
    expect(markup).toContain("DOCX ·  4.0 KB");
  });

  it("routes exactly TXT, Markdown, and JSON through source preview cards", () => {
    const sourceAttachments: InputAttachmentSummary[] = [
      {
        id: "60000000-0000-4000-8000-000000000020",
        kind: "file",
        name: "buyers.txt",
        mimeType: "text/plain",
        sizeBytes: 1024,
        downloadUrl:
          "/api/input-attachments/60000000-0000-4000-8000-000000000020/content",
        createdAt: "2026-08-26T08:00:01.000Z",
      },
      {
        id: "60000000-0000-4000-8000-000000000021",
        kind: "file",
        name: "brief.md",
        mimeType: "text/markdown",
        sizeBytes: 2048,
        downloadUrl:
          "/api/input-attachments/60000000-0000-4000-8000-000000000021/content",
        createdAt: "2026-08-26T08:00:02.000Z",
      },
      {
        id: "60000000-0000-4000-8000-000000000022",
        kind: "file",
        name: "criteria.json",
        mimeType: "application/json",
        sizeBytes: 3072,
        downloadUrl:
          "/api/input-attachments/60000000-0000-4000-8000-000000000022/content",
        createdAt: "2026-08-26T08:00:03.000Z",
      },
    ];
    const docxDownloadUrl =
      "/api/input-attachments/60000000-0000-4000-8000-000000000023/content";
    const message: ChatMessage = {
      id: "40000000-0000-4000-8000-000000000020",
      runId: "20000000-0000-4000-8000-000000000020",
      role: "user",
      content: "复核文本附件",
      citations: [],
      artifacts: [],
      attachments: [
        ...sourceAttachments,
        {
          id: "60000000-0000-4000-8000-000000000023",
          kind: "file",
          name: "catalog.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 4096,
          downloadUrl: docxDownloadUrl,
          createdAt: "2026-08-26T08:00:04.000Z",
        },
      ],
      feedback: null,
      createdAt: "2026-08-26T08:00:05.000Z",
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

    for (const attachment of sourceAttachments) {
      const marker = `aria-label="预览源码：${attachment.name}"`;
      const trigger = openingTag(markup, marker);
      expect(trigger.startsWith("<button")).toBe(true);
      expect(trigger).toContain('aria-haspopup="dialog"');
      expect(trigger).toContain('aria-expanded="false"');
      expect(trigger).not.toContain("download");
      expect(trigger).not.toContain("href=");
    }
    expect(markup).toContain(`download="" href="${docxDownloadUrl}"`);
    expect(markup).not.toContain('aria-label="预览源码：catalog.docx"');
  });

  it("renders the image viewer dialog with named close and download actions", () => {
    const markup = renderToStaticMarkup(
      <AttachmentImageViewerDialog
        closeButtonRef={createRef<HTMLButtonElement>()}
        dialogId="attachment-image-dialog"
        downloadActionRef={createRef<HTMLAnchorElement>()}
        downloadUrl="/api/input-attachments/image/content"
        name="factory.jpeg"
        onClose={() => undefined}
        sizeBytes={2048}
        titleId="attachment-image-title"
      />,
    );

    expect(markup).toContain(
      'aria-labelledby="attachment-image-title" aria-modal="true"',
    );
    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'id="attachment-image-dialog" role="dialog" tabindex="-1"',
    );
    expect(markup).toContain('id="attachment-image-title"');
    expect(markup).toContain('aria-label="下载图片：factory.jpeg"');
    expect(markup).toContain('aria-label="关闭图片预览：factory.jpeg"');
    expect(markup).toContain(
      'download="" href="/api/input-attachments/image/content"',
    );
    expect(markup).toContain('alt="factory.jpeg"');
    expect(markup).toContain('src="/api/input-attachments/image/content"');
  });

  it("opens historical PDF and CSV attachments with the shared file viewer", () => {
    const message: ChatMessage = {
      id: "40000000-0000-4000-8000-000000000010",
      runId: "20000000-0000-4000-8000-000000000010",
      role: "user",
      content: "复核历史附件",
      citations: [],
      artifacts: [],
      attachments: [historicalCsvAttachment, historicalPdfAttachment],
      feedback: null,
      createdAt: "2026-08-26T08:00:02.000Z",
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

    for (const attachment of [
      historicalCsvAttachment,
      historicalPdfAttachment,
    ]) {
      const marker = `aria-label="预览文件：${attachment.name}"`;
      const trigger = openingTag(markup, marker);
      expect(trigger.startsWith("<button")).toBe(true);
      expect(trigger).toContain('aria-haspopup="dialog"');
      expect(trigger).toContain('aria-expanded="false"');
      expect(trigger).not.toContain("href=");
    }
    expect(markup).toContain("CSV ·  3.0 KB");
    expect(markup).toContain("PDF ·  8.0 KB");
  });

  it("retains the real input attachment download URL inside the shared preview dialog", () => {
    const markup = renderToStaticMarkup(
      <ArtifactViewerDialog
        artifact={historicalCsvAttachment}
        closeButtonRef={createRef<HTMLButtonElement>()}
        dialogId="input-attachment-file-dialog"
        downloadActionRef={createRef<HTMLAnchorElement>()}
        onClose={() => undefined}
        onRetry={() => undefined}
        previewFocusRef={createRef<HTMLElement>()}
        retryButtonRef={createRef<HTMLButtonElement>()}
        state={{
          status: "ready",
          content: {
            kind: "csv",
            document: {
              columns: ["company"],
              rows: [["Acme"]],
            },
          },
        }}
        titleId="input-attachment-file-title"
      />,
    );

    expect(markup).toContain(
      `download="" href="${historicalCsvAttachment.downloadUrl}"`,
    );
    expect(markup).toContain("historical-buyers.csv CSV 表格预览");
  });
});
