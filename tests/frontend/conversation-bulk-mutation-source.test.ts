import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");

describe("bulk conversation mutation local exclusion", () => {
  it("does not reset the workspace while a new conversation request is unresolved", async () => {
    const source = await readFile(
      path.join(projectRoot, "components/research-workspace.tsx"),
      "utf8",
    );
    const bulkMutationStart = source.indexOf(
      "const performBulkConversationMutation = useCallback",
    );
    const archiveHandlerStart = source.indexOf(
      "const handleArchiveAllConversations = useCallback",
      bulkMutationStart,
    );

    expect(bulkMutationStart).toBeGreaterThanOrEqual(0);
    expect(archiveHandlerStart).toBeGreaterThan(bulkMutationStart);

    const implementation = source.slice(
      bulkMutationStart,
      archiveHandlerStart,
    );
    const newConversationGuard = implementation.indexOf(
      "isCreating ||\n        pendingChatRequestsRef.current.has(newConversationDraftKey)",
    );
    const requestStart = implementation.indexOf(
      "await archiveAllConversations()",
    );

    expect(newConversationGuard).toBeGreaterThanOrEqual(0);
    expect(requestStart).toBeGreaterThan(newConversationGuard);
    expect(implementation).toContain(
      'error: "新对话仍在提交或等待确认，请稍候再试。"',
    );
    expect(implementation).toContain(
      "[isCreating, resetWorkspaceAfterBulkConversationMutation]",
    );
  });
});
