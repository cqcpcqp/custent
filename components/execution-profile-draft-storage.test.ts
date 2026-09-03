import { describe, expect, it } from "vitest";

import type { ExecutionProfileCatalog } from "@/lib/contracts";

import {
  conversationComposerDraftScope,
  newConversationComposerDraftScope,
} from "./composer-draft-storage";
import {
  readExecutionProfileDraft,
  writeExecutionProfileDraft,
} from "./execution-profile-draft-storage";

const executionProfileCatalog: ExecutionProfileCatalog = {
  defaultId: "standard_research",
  options: [
    {
      id: "standard_research",
      label: "标准研究",
      description: "适合快速查找和整理潜在买家。",
    },
    {
      id: "pro_research",
      label: "专业研究",
      description: "投入更多推理与检索，适合复杂市场研究。",
    },
  ],
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("execution profile draft storage", () => {
  it("keeps new and existing conversation selections independent", () => {
    const storage = memoryStorage();
    const conversationScope = conversationComposerDraftScope("conversation-1");

    expect(
      writeExecutionProfileDraft(
        storage,
        newConversationComposerDraftScope,
        "pro_research",
      ),
    ).toBe(true);
    expect(
      writeExecutionProfileDraft(
        storage,
        conversationScope,
        "standard_research",
      ),
    ).toBe(true);
    expect(
      readExecutionProfileDraft(
        storage,
        newConversationComposerDraftScope,
        executionProfileCatalog,
      ),
    ).toBe("pro_research");
    expect(
      readExecutionProfileDraft(
        storage,
        conversationScope,
        executionProfileCatalog,
      ),
    ).toBe("standard_research");
  });

  it("rejects malformed or unknown stored values", () => {
    const storage = memoryStorage();
    storage.setItem(
      "custent:execution-profile:custent:composer-draft:new-conversation",
      JSON.stringify({ version: 1, executionProfileId: "unknown" }),
    );
    expect(
      readExecutionProfileDraft(
        storage,
        newConversationComposerDraftScope,
        executionProfileCatalog,
      ),
    ).toBeNull();
  });

  it("migrates a retired enum member to the live catalog default", () => {
    const storage = memoryStorage();
    const storageKey =
      "custent:execution-profile:custent:composer-draft:new-conversation";
    storage.setItem(
      storageKey,
      JSON.stringify({ version: 1, executionProfileId: "pro_research" }),
    );
    const catalogWithoutPro: ExecutionProfileCatalog = {
      defaultId: "standard_research",
      options: [executionProfileCatalog.options[0]],
    };

    expect(
      readExecutionProfileDraft(
        storage,
        newConversationComposerDraftScope,
        catalogWithoutPro,
      ),
    ).toBe("standard_research");
    expect(JSON.parse(storage.getItem(storageKey) ?? "null")).toEqual({
      version: 1,
      executionProfileId: "standard_research",
    });
  });
});
