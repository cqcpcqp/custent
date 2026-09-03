import { describe, expect, it } from "vitest";

import {
  isConversationSharePrivateResourceSentinel,
  isConversationSharePrivateResourceUrl,
  redactConversationSharePrivateResourceUrls,
  sanitizeConversationShareMessages,
} from "@/lib/conversation-share-safety";
import type { SharedConversationMessage } from "@/lib/contracts";

const artifactId = "11111111-1111-4111-8111-111111111111";
const attachmentId = "22222222-2222-4222-8222-222222222222";
const stagedAttachmentId = "33333333-3333-4333-8333-333333333333";

describe("conversation share safety", () => {
  it("recognizes only fixed owner-only resource pathnames", () => {
    for (const url of [
      `/api/artifacts/${artifactId}/download`,
      `https://custent.example/api/artifacts/${artifactId}/download?inline=1`,
      `/api/input-attachments/${attachmentId}`,
      `http://localhost:3000/api/input-attachments/${attachmentId}/content#page=1`,
    ]) {
      expect(isConversationSharePrivateResourceUrl(url)).toBe(true);
    }

    for (const url of [
      "https://buyer.example/source",
      `/api/artifacts/${artifactId}`,
      `/api/input-attachments/${attachmentId}/content/extra`,
      "/api/input-attachments/not-a-uuid/content",
    ]) {
      expect(isConversationSharePrivateResourceUrl(url)).toBe(false);
    }
  });

  it("replaces relative and absolute private URLs with equal-length safe fragments", () => {
    const privateArtifactUrl = `/api/artifacts/${artifactId}/download`;
    const privateAttachmentUrl =
      `https://custent.example/api/input-attachments/${attachmentId}/content?download=1`;
    const privateStagedUrl =
      `/api/input-attachments/${stagedAttachmentId}`;
    const publicUrl = "https://buyer.example/source";
    const content =
      `文件 [CSV](${privateArtifactUrl})，图片 ${privateAttachmentUrl}，` +
      `暂存 ${privateStagedUrl}，来源 ${publicUrl}。`;

    const redacted = redactConversationSharePrivateResourceUrls(content);
    expect(redacted).toHaveLength(content.length);
    expect(redacted).toContain(publicUrl);
    expect(redacted).not.toContain("/api/artifacts/");
    expect(redacted).not.toContain("/api/input-attachments/");
    expect(redacted).not.toContain(artifactId);
    expect(redacted).not.toContain(attachmentId);
    expect(redacted).not.toContain(stagedAttachmentId);

    const sentinels = redacted.match(/#private-resource-*/gu);
    expect(sentinels).toHaveLength(3);
    for (const sentinel of sentinels ?? []) {
      expect(isConversationSharePrivateResourceSentinel(sentinel)).toBe(true);
    }
    expect(isConversationSharePrivateResourceSentinel(publicUrl)).toBe(false);
    expect(redactConversationSharePrivateResourceUrls(redacted)).toBe(
      redacted,
    );
  });

  it("filters private citations without moving surviving citation indices", () => {
    const content =
      `Buyer evidence and [CSV](/api/artifacts/${artifactId}/download).`;
    const message: SharedConversationMessage = {
      id: "44444444-4444-4444-8444-444444444444",
      role: "assistant",
      content,
      citations: [
        {
          url: "https://buyer.example/source",
          title: "Public source",
          startIndex: 0,
          endIndex: 5,
        },
        {
          url: `https://custent.example/api/input-attachments/${attachmentId}/content?download=1`,
          title: "Private attachment",
          startIndex: 6,
          endIndex: 14,
        },
      ],
      createdAt: "2026-08-28T08:00:00.000Z",
      files: [],
    };

    const [sanitized] = sanitizeConversationShareMessages([message]);
    expect(sanitized.content).toHaveLength(content.length);
    expect(sanitized.citations).toEqual([message.citations[0]]);
    expect(
      sanitized.content.slice(
        sanitized.citations[0].startIndex,
        sanitized.citations[0].endIndex,
      ),
    ).toBe("Buyer");
    expect(message.content).toBe(content);
    expect(message.citations).toHaveLength(2);
    expect(sanitizeConversationShareMessages([sanitized])).toEqual([
      sanitized,
    ]);
  });
});
