import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PublicConversationShareNotFound from "@/app/share/[publicId]/not-found";
import { SharedConversationView } from "@/components/shared-conversation-view";
import type { PublicConversationShare } from "@/lib/contracts";

const privateArtifactId = "90000000-0000-4000-8000-000000000001";
const privateAttachmentId = "90000000-0000-4000-8000-000000000002";
const assistantContent =
  "**Acme GmbH** 正在采购工业泵。\n\n" +
  `[下载 buyers.csv](/api/artifacts/${privateArtifactId}/download)\n\n` +
  `[查看附件](https://app.example.com/api/input-attachments/${privateAttachmentId}/content)`;
const citedText = "Acme GmbH";
const citedTextStart = assistantContent.indexOf(citedText);

const share: PublicConversationShare = {
  title: "德国工业泵买家研究",
  createdAt: "2026-08-28T08:00:00.000Z",
  updatedAt: "2026-08-28T09:00:00.000Z",
  messages: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      role: "user",
      content: "请查找德国工业泵买家",
      citations: [],
      createdAt: "2026-08-28T08:01:00.000Z",
      files: [
        {
          kind: "input_attachment",
          name: "产品目录.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1_024,
        },
      ],
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      role: "assistant",
      content: assistantContent,
      citations: [
        {
          url: "https://buyer.example/company",
          title: "Acme company profile",
          startIndex: citedTextStart,
          endIndex: citedTextStart + citedText.length,
        },
      ],
      createdAt: "2026-08-28T08:02:00.000Z",
      files: [
        {
          kind: "artifact",
          name: "buyers.csv",
          mimeType: "text/csv",
          sizeBytes: 2_048,
        },
      ],
    },
  ],
};

describe("public shared conversation view", () => {
  it("renders the frozen messages, citations, and file metadata", () => {
    const markup = renderToStaticMarkup(
      <SharedConversationView share={share} />,
    );

    expect(markup).toContain("德国工业泵买家研究");
    expect(markup).toContain("请查找德国工业泵买家");
    expect(markup).toContain("<strong>Acme GmbH<sup");
    expect(markup).toContain("Acme company profile");
    expect(markup).toContain('href="https://buyer.example/company"');
    expect(markup).toContain("产品目录.pdf");
    expect(markup).toContain("buyers.csv");
    expect(markup).toContain("输入附件");
    expect(markup).toContain("生成文件");
    expect(markup).toContain("文件仅展示名称、类型与大小");
    expect(markup).toContain("下载 buyers.csv");
    expect(markup).toContain("查看附件");
    expect(markup).toContain("仅展示文件元数据");
  });

  it("does not expose owner resources or mutation controls", () => {
    const markup = renderToStaticMarkup(
      <SharedConversationView share={share} />,
    );

    expect(markup).not.toContain("/api/artifacts/");
    expect(markup).not.toContain("/api/input-attachments/");
    expect(markup).not.toContain(privateArtifactId);
    expect(markup).not.toContain(privateAttachmentId);
    expect(markup).not.toContain("#private-resource");
    expect(markup).not.toContain("downloadUrl");
    expect(markup).not.toContain("下载文件");
    expect(markup).not.toContain("编辑这条消息");
    expect(markup).not.toContain("重新生成");
    expect(markup).not.toContain("赞同此回答");
  });

  it("renders an explicit unavailable-link page", () => {
    const markup = renderToStaticMarkup(
      <PublicConversationShareNotFound />,
    );

    expect(markup).toContain("这个分享链接不可用");
    expect(markup).toContain("已被撤销");
    expect(markup).toContain('href="/"');
  });
});
