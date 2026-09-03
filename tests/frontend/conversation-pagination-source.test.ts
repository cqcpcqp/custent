import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("conversation pagination orchestration", () => {
  it("restores server-loaded depth without counting local summary upserts", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const conversationLoadedDepthRef = useRef(0);",
    );
    expect(source).not.toContain(
      "bootstrapAtRequestStart.conversations.length",
    );
    expect(
      source.match(/targetDepth: loadedDepthAtRequestStart/gu),
    ).toHaveLength(2);
    expect(source).toMatch(
      /advanceConversationLoadedDepth\(\s*loadedDepthAtRequestStart,\s*response\.items\.length/gu,
    );
  });

  it("routes successful archive and delete removal through both summary sources", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );
    const removalStart = source.indexOf(
      "const removeConversationAndAdvance",
    );
    const archiveStart = source.indexOf(
      "const mutateConversationArchiveState",
      removalStart,
    );
    const deleteStart = source.indexOf(
      "const handleDeleteConversation",
      archiveStart,
    );
    const deleteEnd = source.indexOf(
      "const closeRenameDialog",
      deleteStart,
    );
    const removalSource = source.slice(removalStart, archiveStart);
    const archiveSource = source.slice(archiveStart, deleteStart);
    const deleteSource = source.slice(deleteStart, deleteEnd);

    expect(removalStart).toBeGreaterThan(0);
    expect(archiveStart).toBeGreaterThan(removalStart);
    expect(deleteStart).toBeGreaterThan(archiveStart);
    expect(deleteEnd).toBeGreaterThan(deleteStart);
    expect(removalSource).toContain(
      "removeConversationFromSummarySources",
    );
    expect(archiveSource).toContain(
      "removeConversationAndAdvance(conversation.id)",
    );
    expect(deleteSource).toContain(
      "removeConversationAndAdvance(conversation.id)",
    );
  });
});
