import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function projectSource(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

function section(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) {
    throw new Error(`缺少源码边界 ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end);
}

describe("input attachment source preview integration", () => {
  it("routes source preview after the existing PDF/CSV viewer and before download-only files", async () => {
    const source = await projectSource("components/research-message.tsx");
    const attachmentCards = section(
      source,
      "function MessageAttachmentCards",
      "function MessageFeedbackActions",
    );
    const artifactViewerIndex = attachmentCards.indexOf("<ArtifactViewer");
    const sourceViewerIndex = attachmentCards.indexOf(
      "<InputAttachmentTextViewer",
    );
    const downloadFallbackIndex = attachmentCards.indexOf(
      '<a\n            className="message-input-attachment message-input-attachment--file"',
    );

    expect(artifactViewerIndex).toBeGreaterThan(0);
    expect(sourceViewerIndex).toBeGreaterThan(artifactViewerIndex);
    expect(downloadFallbackIndex).toBeGreaterThan(sourceViewerIndex);
    expect(attachmentCards).toContain(
      "isInputAttachmentSourcePreviewMimeType(attachment.mimeType)",
    );
    expect(attachmentCards.match(/<InputAttachmentTextViewer/gu)).toHaveLength(
      1,
    );
    expect(attachmentCards).toContain("mimeType={attachment.mimeType}");
    expect(attachmentCards).toContain("downloadUrl={attachment.downloadUrl}");
  });

  it("keeps the generated artifact contract limited to CSV and PDF", async () => {
    const [contracts, artifactViewer] = await Promise.all([
      projectSource("lib/contracts.ts"),
      projectSource("components/artifact-viewer.tsx"),
    ]);
    const artifactContract = section(
      contracts,
      "export const ArtifactSummarySchema",
      "export type ArtifactSummary",
    );

    expect(artifactContract).toContain(
      'mimeType: z.enum(["text/csv", "application/pdf"])',
    );
    expect(artifactContract).not.toContain("text/plain");
    expect(artifactContract).not.toContain("text/markdown");
    expect(artifactContract).not.toContain("application/json");
    expect(artifactViewer).toContain(
      'mimeType: ArtifactSummary["mimeType"]',
    );
  });

  it("provides dedicated scrollable, dark-theme, and narrow-screen source styles", async () => {
    const styles = await projectSource("app/globals.css");
    const sourceRule = section(
      styles,
      ".input-attachment-text-viewer__source {",
      ".input-attachment-text-viewer__source:focus-visible",
    );

    expect(sourceRule).toContain("overflow: auto");
    expect(sourceRule).toContain("overscroll-behavior: contain");
    expect(styles).toContain(
      'html[data-theme="dark"] .input-attachment-text-viewer__source',
    );
    expect(styles).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]*?\.input-attachment-text-viewer__source pre \{[\s\S]*?font-size: 12px;/u,
    );
    expect(styles).toMatch(
      /\.input-attachment-text-viewer__source code \{[\s\S]*?white-space: pre;/u,
    );
  });
});
