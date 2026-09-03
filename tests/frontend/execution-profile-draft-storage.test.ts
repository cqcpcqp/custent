import { describe, expect, it } from "vitest";

import {
  conversationComposerDraftScope,
  newConversationComposerDraftScope,
} from "@/components/composer-draft-storage";
import {
  clearConversationExecutionProfileDrafts,
  readExecutionProfileDraft,
  writeExecutionProfileDraft,
  type ExecutionProfileDraftStorage,
} from "@/components/execution-profile-draft-storage";
import type { ExecutionProfileCatalog } from "@/lib/contracts";

class MemoryStorage implements ExecutionProfileDraftStorage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const catalog: ExecutionProfileCatalog = {
  defaultId: "standard_research",
  options: [
    {
      id: "standard_research",
      label: "标准研究",
      description: "快速查找潜在买家。",
    },
    {
      id: "pro_research",
      label: "专业研究",
      description: "执行更深入的研究。",
    },
  ],
};

describe("execution-profile draft storage", () => {
  it("clears conversation preferences without removing the new-conversation preference", () => {
    const storage = new MemoryStorage();
    const conversationA = conversationComposerDraftScope(
      "10000000-0000-4000-8000-000000000001",
    );
    const conversationB = conversationComposerDraftScope(
      "10000000-0000-4000-8000-000000000002",
    );
    writeExecutionProfileDraft(
      storage,
      newConversationComposerDraftScope,
      "pro_research",
    );
    writeExecutionProfileDraft(storage, conversationA, "pro_research");
    writeExecutionProfileDraft(storage, conversationB, "standard_research");
    storage.values.set("unrelated", "preserve me");

    const result = clearConversationExecutionProfileDrafts(storage);
    expect(result.status).toBe("cleared");
    if (result.status !== "cleared") {
      throw new Error("expected conversation profile drafts to be cleared");
    }
    expect(result.removedKeys).toHaveLength(2);
    expect(readExecutionProfileDraft(storage, conversationA, catalog)).toBeNull();
    expect(readExecutionProfileDraft(storage, conversationB, catalog)).toBeNull();
    expect(
      readExecutionProfileDraft(
        storage,
        newConversationComposerDraftScope,
        catalog,
      ),
    ).toBe("pro_research");
    expect(storage.values.get("unrelated")).toBe("preserve me");
  });
});
