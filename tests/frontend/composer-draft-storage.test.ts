import { describe, expect, it } from "vitest";

import {
  composerDraftMaxLength,
  composerDraftStorageKey,
  composerDraftStorageVersion,
  clearConversationComposerDrafts,
  conversationComposerDraftScope,
  newConversationComposerDraftScope,
  parseComposerDraft,
  readComposerDraft,
  removeComposerDraft,
  serializeComposerDraft,
  writeComposerDraft,
  type ComposerDraftStorage,
} from "@/components/composer-draft-storage";

class MemoryStorage implements ComposerDraftStorage {
  readonly values = new Map<string, string>();
  readonly removedKeys: string[] = [];
  readonly writtenKeys: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.removedKeys.push(key);
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writtenKeys.push(key);
    this.values.set(key, value);
  }

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
}

const conversationA = conversationComposerDraftScope(
  "10000000-0000-4000-8000-000000000001",
);
const conversationB = conversationComposerDraftScope(
  "10000000-0000-4000-8000-000000000002",
);

function storedDraft(input?: {
  scope?: unknown;
  text?: unknown;
  version?: unknown;
}): string {
  return JSON.stringify({
    version:
      input?.version === undefined
        ? composerDraftStorageVersion
        : input.version,
    scope: input?.scope === undefined ? conversationA : input.scope,
    text: input?.text === undefined ? "待恢复草稿" : input.text,
  });
}

describe("composer draft storage", () => {
  it("uses a fixed v1 envelope and disjoint keys for new and existing conversations", () => {
    expect(composerDraftStorageVersion).toBe(1);
    expect(composerDraftMaxLength).toBe(20_000);

    const newConversationKey = composerDraftStorageKey(
      newConversationComposerDraftScope,
    );
    const conversationKey = composerDraftStorageKey(conversationA);
    expect(newConversationKey).toBe(
      "custent:composer-draft:new-conversation",
    );
    expect(conversationKey).toBe(
      "custent:composer-draft:conversation:10000000-0000-4000-8000-000000000001",
    );
    expect(newConversationKey).not.toBe(conversationKey);
  });

  it("encodes a conversation ID in its storage key without changing its envelope identity", () => {
    const scope = conversationComposerDraftScope("region/eu:prospects");
    expect(composerDraftStorageKey(scope)).toBe(
      "custent:composer-draft:conversation:region%2Feu%3Aprospects",
    );
    expect(parseComposerDraft(serializeComposerDraft(scope, "内容")!, scope)).toBe(
      "内容",
    );
  });

  it("round-trips exact draft text for both scope kinds", () => {
    const text = "  第一行\n第二行 😀  ";

    for (const scope of [newConversationComposerDraftScope, conversationA]) {
      const serialized = serializeComposerDraft(scope, text);
      expect(serialized).not.toBeNull();
      expect(JSON.parse(serialized!)).toEqual({
        version: 1,
        scope,
        text,
      });
      expect(parseComposerDraft(serialized!, scope)).toBe(text);
    }
  });

  it("persists and restores each conversation independently", () => {
    const storage = new MemoryStorage();

    expect(
      writeComposerDraft(storage, newConversationComposerDraftScope, "新会话"),
    ).toBe(true);
    expect(writeComposerDraft(storage, conversationA, "A 草稿")).toBe(true);
    expect(writeComposerDraft(storage, conversationB, "B 草稿")).toBe(true);

    expect(readComposerDraft(storage, newConversationComposerDraftScope)).toBe(
      "新会话",
    );
    expect(readComposerDraft(storage, conversationA)).toBe("A 草稿");
    expect(readComposerDraft(storage, conversationB)).toBe("B 草稿");
  });

  it("removes only the requested scope when text becomes empty or submission succeeds", () => {
    const storage = new MemoryStorage();
    writeComposerDraft(storage, conversationA, "A 草稿");
    writeComposerDraft(storage, conversationB, "B 草稿");

    expect(writeComposerDraft(storage, conversationA, "")).toBe(true);
    expect(readComposerDraft(storage, conversationA)).toBeNull();
    expect(readComposerDraft(storage, conversationB)).toBe("B 草稿");
    expect(storage.removedKeys).toEqual([
      composerDraftStorageKey(conversationA),
    ]);

    expect(removeComposerDraft(storage, conversationB)).toBe(true);
    expect(readComposerDraft(storage, conversationB)).toBeNull();
  });

  it("clears every conversation draft while preserving the new-conversation draft and unrelated storage", () => {
    const storage = new MemoryStorage();
    writeComposerDraft(storage, newConversationComposerDraftScope, "新会话草稿");
    writeComposerDraft(storage, conversationA, "A 草稿");
    writeComposerDraft(storage, conversationB, "B 草稿");
    storage.values.set("unrelated", "preserve me");

    expect(clearConversationComposerDrafts(storage)).toEqual({
      status: "cleared",
      removedKeys: [
        composerDraftStorageKey(conversationA),
        composerDraftStorageKey(conversationB),
      ],
      failedKeys: [],
      enumerationFailureCount: 0,
    });
    expect(readComposerDraft(storage, newConversationComposerDraftScope)).toBe(
      "新会话草稿",
    );
    expect(readComposerDraft(storage, conversationA)).toBeNull();
    expect(readComposerDraft(storage, conversationB)).toBeNull();
    expect(storage.values.get("unrelated")).toBe("preserve me");
  });

  it("accepts exactly 20,000 UTF-16 code units and refuses a larger draft without replacing the last valid value", () => {
    const storage = new MemoryStorage();
    const maximumDraft = "中".repeat(composerDraftMaxLength);

    expect(writeComposerDraft(storage, conversationA, maximumDraft)).toBe(true);
    expect(readComposerDraft(storage, conversationA)).toBe(maximumDraft);
    expect(
      writeComposerDraft(storage, conversationA, `${maximumDraft}超`),
    ).toBe(false);
    expect(readComposerDraft(storage, conversationA)).toBe(maximumDraft);
  });

  it.each([
    ["malformed JSON", "{"],
    ["unsupported version", storedDraft({ version: 2 })],
    ["string version", storedDraft({ version: "1" })],
    ["missing text", JSON.stringify({ version: 1, scope: conversationA })],
    ["non-string text", storedDraft({ text: 42 })],
    ["empty text", storedDraft({ text: "" })],
    [
      "oversized text",
      storedDraft({ text: "x".repeat(composerDraftMaxLength + 1) }),
    ],
    ["null scope", storedDraft({ scope: null })],
    ["array scope", storedDraft({ scope: [] })],
    ["empty conversation ID", storedDraft({
      scope: { kind: "conversation", conversationId: "" },
    })],
    ["wrong scope kind", storedDraft({ scope: { kind: "new" } })],
    [
      "extra root property",
      JSON.stringify({
        version: 1,
        scope: conversationA,
        text: "草稿",
        migrated: true,
      }),
    ],
    [
      "extra scope property",
      storedDraft({
        scope: {
          kind: "conversation",
          conversationId: conversationA.conversationId,
          title: "不属于契约",
        },
      }),
    ],
  ])("rejects %s without propagating an exception", (_label, serialized) => {
    expect(() => parseComposerDraft(serialized, conversationA)).not.toThrow();
    expect(parseComposerDraft(serialized, conversationA)).toBeNull();
  });

  it("rejects a valid record stored under a different scope", () => {
    expect(parseComposerDraft(storedDraft(), conversationB)).toBeNull();
    expect(
      parseComposerDraft(
        storedDraft({ scope: newConversationComposerDraftScope }),
        conversationA,
      ),
    ).toBeNull();
  });

  it("does not propagate localStorage read, write, or removal failures", () => {
    const unavailableStorage: ComposerDraftStorage = {
      getItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      removeItem() {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem() {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };

    expect(() => readComposerDraft(unavailableStorage, conversationA)).not.toThrow();
    expect(readComposerDraft(unavailableStorage, conversationA)).toBeNull();
    expect(writeComposerDraft(unavailableStorage, conversationA, "草稿")).toBe(
      false,
    );
    expect(writeComposerDraft(unavailableStorage, conversationA, "")).toBe(
      false,
    );
    expect(removeComposerDraft(unavailableStorage, conversationA)).toBe(false);
  });

  it("rejects invalid caller data without writing or deleting an existing draft", () => {
    const storage = new MemoryStorage();
    writeComposerDraft(storage, conversationA, "原草稿");
    const writesBeforeInvalidValue = storage.writtenKeys.length;
    const removalsBeforeInvalidValue = storage.removedKeys.length;

    expect(
      writeComposerDraft(
        storage,
        conversationA,
        123 as unknown as string,
      ),
    ).toBe(false);
    expect(storage.writtenKeys).toHaveLength(writesBeforeInvalidValue);
    expect(storage.removedKeys).toHaveLength(removalsBeforeInvalidValue);
    expect(readComposerDraft(storage, conversationA)).toBe("原草稿");
  });

  it("requires a non-empty ID when constructing a conversation scope", () => {
    expect(() => conversationComposerDraftScope("")).toThrow(
      "会话草稿必须关联非空 conversationId",
    );
  });
});
