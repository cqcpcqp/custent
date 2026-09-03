import { describe, expect, it } from "vitest";

import {
  clearComposerAttachmentDraftScope,
  clearComposerAttachmentDraftConversationScopes,
  composerAttachmentDraftStorageEventAffectsScope,
  composerAttachmentDraftStorageKey,
  composerAttachmentDraftStorageScopeKeyPrefix,
  composerAttachmentDraftStorageVersion,
  parseComposerAttachmentDraft,
  parseComposerAttachmentDraftStorageKey,
  readComposerAttachmentDraft,
  readComposerAttachmentDraftScope,
  removeComposerAttachmentDraft,
  serializeComposerAttachmentDraft,
  writeComposerAttachmentDraft,
  type ComposerAttachmentDraft,
  type ComposerAttachmentDraftStorage,
} from "@/components/composer-attachment-draft-storage";
import {
  conversationComposerDraftScope,
  newConversationComposerDraftScope,
} from "@/components/composer-draft-storage";
import type { InputAttachmentSummary } from "@/lib/contracts";

class MemoryStorage implements ComposerAttachmentDraftStorage {
  readonly failedGetKeys = new Set<string>();
  readonly failedKeyIndexes = new Set<number>();
  readonly failedRemoveKeys = new Set<string>();
  readonly failedSetKeys = new Set<string>();
  failLength = false;

  constructor(readonly values = new Map<string, string>()) {}

  get length(): number {
    if (this.failLength) {
      throw new DOMException("blocked", "SecurityError");
    }
    return this.values.size;
  }

  getItem(key: string): string | null {
    if (this.failedGetKeys.has(key)) {
      throw new DOMException("blocked", "SecurityError");
    }
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    if (this.failedKeyIndexes.has(index)) {
      throw new DOMException("blocked", "SecurityError");
    }
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    if (this.failedRemoveKeys.has(key)) {
      throw new DOMException("blocked", "SecurityError");
    }
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failedSetKeys.has(key)) {
      throw new DOMException("quota", "QuotaExceededError");
    }
    this.values.set(key, value);
  }
}

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const conversationA = conversationComposerDraftScope(
  "10000000-0000-4000-8000-000000000001",
);
const conversationB = conversationComposerDraftScope(
  "10000000-0000-4000-8000-000000000002",
);
const activeNow = Date.parse("2026-08-29T08:00:00.000Z");

const attachmentA: InputAttachmentSummary = {
  id: "20000000-0000-4000-8000-000000000001",
  kind: "file",
  name: "buyers.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  downloadUrl:
    "/api/input-attachments/20000000-0000-4000-8000-000000000001/content",
  createdAt: "2026-08-29T07:00:00.000Z",
};

const attachmentB: InputAttachmentSummary = {
  id: "20000000-0000-4000-8000-000000000002",
  kind: "image",
  name: "product.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  downloadUrl:
    "/api/input-attachments/20000000-0000-4000-8000-000000000002/content",
  createdAt: "2026-08-29T07:01:00.000Z",
};

function draft(
  input: Partial<ComposerAttachmentDraft> = {},
): ComposerAttachmentDraft {
  return {
    userId: userA,
    scope: conversationA,
    attachment: attachmentA,
    expiresAt: "2026-08-30T08:00:00.000Z",
    orderToken: "0001",
    ...input,
  };
}

describe("composer attachment draft storage", () => {
  it("uses a versioned per-user, per-scope, per-attachment key", () => {
    expect(composerAttachmentDraftStorageVersion).toBe(1);
    expect(
      composerAttachmentDraftStorageScopeKeyPrefix(userA, conversationA),
    ).toBe(
      "custent:composer-attachment-draft:v1:user:00000000-0000-4000-8000-000000000001:conversation:10000000-0000-4000-8000-000000000001:attachment:",
    );

    const key = composerAttachmentDraftStorageKey(
      userA,
      conversationA,
      attachmentA.id,
    );
    expect(key).toBe(
      "custent:composer-attachment-draft:v1:user:00000000-0000-4000-8000-000000000001:conversation:10000000-0000-4000-8000-000000000001:attachment:20000000-0000-4000-8000-000000000001",
    );
    expect(parseComposerAttachmentDraftStorageKey(key)).toEqual({
      userId: userA,
      scope: conversationA,
      attachmentId: attachmentA.id,
    });

    expect(
      composerAttachmentDraftStorageKey(
        userB,
        conversationA,
        attachmentA.id,
      ),
    ).not.toBe(key);
    expect(
      composerAttachmentDraftStorageKey(
        userA,
        conversationB,
        attachmentA.id,
      ),
    ).not.toBe(key);
    expect(
      composerAttachmentDraftStorageKey(
        userA,
        conversationA,
        attachmentB.id,
      ),
    ).not.toBe(key);
  });

  it("canonically encodes a conversation scope and supports the new-conversation scope", () => {
    const encodedScope = conversationComposerDraftScope("region/eu:buyers");
    const encodedKey = composerAttachmentDraftStorageKey(
      userA,
      encodedScope,
      attachmentA.id,
    );
    expect(encodedKey).toContain("conversation:region%2Feu%3Abuyers");
    expect(parseComposerAttachmentDraftStorageKey(encodedKey)).toEqual({
      userId: userA,
      scope: encodedScope,
      attachmentId: attachmentA.id,
    });

    const newConversationKey = composerAttachmentDraftStorageKey(
      userA,
      newConversationComposerDraftScope,
      attachmentA.id,
    );
    expect(newConversationKey).toContain(
      ":new-conversation:attachment:",
    );
    expect(parseComposerAttachmentDraftStorageKey(newConversationKey)).toEqual({
      userId: userA,
      scope: newConversationComposerDraftScope,
      attachmentId: attachmentA.id,
    });
  });

  it("round-trips the exact v1 envelope without deriving the server expiration", () => {
    const source = draft({
      expiresAt: "2026-09-01T03:04:05.678Z",
      orderToken: "selection-0007",
    });
    const serialized = serializeComposerAttachmentDraft(source);
    expect(serialized).not.toBeNull();
    expect(JSON.parse(serialized!)).toEqual({
      version: 1,
      userId: userA,
      scope: conversationA,
      attachment: attachmentA,
      expiresAt: "2026-09-01T03:04:05.678Z",
      orderToken: "selection-0007",
    });
    expect(
      parseComposerAttachmentDraft(serialized!, {
        userId: userA,
        scope: conversationA,
        attachmentId: attachmentA.id,
      }),
    ).toEqual(source);
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "unsupported version",
      JSON.stringify({
        ...JSON.parse(serializeComposerAttachmentDraft(draft())!),
        version: 2,
      }),
    ],
    [
      "extra root property",
      JSON.stringify({
        ...JSON.parse(serializeComposerAttachmentDraft(draft())!),
        migrated: true,
      }),
    ],
    [
      "extra scope property",
      JSON.stringify({
        ...JSON.parse(serializeComposerAttachmentDraft(draft())!),
        scope: { ...conversationA, title: "not in contract" },
      }),
    ],
    [
      "extra attachment property",
      JSON.stringify({
        ...JSON.parse(serializeComposerAttachmentDraft(draft())!),
        attachment: { ...attachmentA, storagePath: "/tmp/private" },
      }),
    ],
    [
      "invalid expiration",
      JSON.stringify({
        ...JSON.parse(serializeComposerAttachmentDraft(draft())!),
        expiresAt: "tomorrow",
      }),
    ],
    [
      "empty order token",
      JSON.stringify({
        ...JSON.parse(serializeComposerAttachmentDraft(draft())!),
        orderToken: "",
      }),
    ],
  ])("rejects a %s record", (_label, serialized) => {
    expect(
      parseComposerAttachmentDraft(serialized, {
        userId: userA,
        scope: conversationA,
        attachmentId: attachmentA.id,
      }),
    ).toBeNull();
  });

  it("rejects a valid envelope under a different user, scope, or attachment key", () => {
    const serialized = serializeComposerAttachmentDraft(draft())!;
    expect(
      parseComposerAttachmentDraft(serialized, {
        userId: userB,
        scope: conversationA,
        attachmentId: attachmentA.id,
      }),
    ).toBeNull();
    expect(
      parseComposerAttachmentDraft(serialized, {
        userId: userA,
        scope: conversationB,
        attachmentId: attachmentA.id,
      }),
    ).toBeNull();
    expect(
      parseComposerAttachmentDraft(serialized, {
        userId: userA,
        scope: conversationA,
        attachmentId: attachmentB.id,
      }),
    ).toBeNull();
  });

  it("distinguishes an active, boundary-expired, missing, and invalid item", () => {
    const storage = new MemoryStorage();
    expect(writeComposerAttachmentDraft(storage, draft())).toMatchObject({
      status: "written",
    });
    expect(
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
        activeNow,
      ),
    ).toEqual({ status: "found", draft: draft() });
    expect(
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
        Date.parse(draft().expiresAt),
      ),
    ).toEqual({ status: "expired", draft: draft() });
    expect(
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentB.id,
        activeNow,
      ),
    ).toEqual({ status: "missing" });

    storage.values.set(
      composerAttachmentDraftStorageKey(
        userA,
        conversationA,
        attachmentA.id,
      ),
      "not-json",
    );
    expect(
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
        activeNow,
      ),
    ).toEqual({ status: "invalid" });
  });

  it("reads only the current user and scope in stable token and ID order", () => {
    const storage = new MemoryStorage();
    const sameTokenA = draft({ orderToken: "0002" });
    const sameTokenB = draft({
      attachment: attachmentB,
      orderToken: "0002",
    });
    const first = draft({
      attachment: {
        ...attachmentB,
        id: "20000000-0000-4000-8000-000000000003",
        downloadUrl:
          "/api/input-attachments/20000000-0000-4000-8000-000000000003/content",
      },
      orderToken: "0001",
    });

    writeComposerAttachmentDraft(storage, sameTokenB);
    writeComposerAttachmentDraft(storage, sameTokenA);
    writeComposerAttachmentDraft(storage, first);
    writeComposerAttachmentDraft(
      storage,
      draft({ userId: userB, orderToken: "0000" }),
    );
    writeComposerAttachmentDraft(
      storage,
      draft({ scope: conversationB, orderToken: "0000" }),
    );

    const result = readComposerAttachmentDraftScope(
      storage,
      userA,
      conversationA,
      activeNow,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("expected readable attachment drafts");
    }
    expect(result.active.map((item) => item.attachment.id)).toEqual([
      first.attachment.id,
      attachmentA.id,
      attachmentB.id,
    ]);
    expect(result.expired).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("keeps concurrent additions in the same scope as independent records", () => {
    const sharedValues = new Map<string, string>();
    const firstTab = new MemoryStorage(sharedValues);
    const secondTab = new MemoryStorage(sharedValues);

    expect(writeComposerAttachmentDraft(firstTab, draft())).toMatchObject({
      status: "written",
    });
    expect(
      writeComposerAttachmentDraft(
        secondTab,
        draft({ attachment: attachmentB, orderToken: "0002" }),
      ),
    ).toMatchObject({ status: "written" });

    expect(sharedValues).toHaveLength(2);
    const result = readComposerAttachmentDraftScope(
      firstTab,
      userA,
      conversationA,
      activeNow,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.active.map((item) => item.attachment.id)).toEqual([
        attachmentA.id,
        attachmentB.id,
      ]);
    }
  });

  it("returns expired records separately so the caller can remove them by ID", () => {
    const storage = new MemoryStorage();
    const expiredDraft = draft({ expiresAt: "2026-08-29T07:59:59.999Z" });
    writeComposerAttachmentDraft(storage, expiredDraft);

    const result = readComposerAttachmentDraftScope(
      storage,
      userA,
      conversationA,
      activeNow,
    );
    expect(result).toEqual({
      status: "ok",
      active: [],
      expired: [expiredDraft],
      issues: [],
    });
    expect(
      removeComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
      ),
    ).toMatchObject({ status: "removed" });
    expect(
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
        activeNow,
      ),
    ).toEqual({ status: "missing" });
  });

  it("reports invalid records and partial enumeration/read failures as warnings", () => {
    const storage = new MemoryStorage();
    storage.values.set("unrelated", "preserve me");
    writeComposerAttachmentDraft(storage, draft());
    const validKey = composerAttachmentDraftStorageKey(
      userA,
      conversationA,
      attachmentA.id,
    );
    const invalidRecordKey = composerAttachmentDraftStorageKey(
      userA,
      conversationA,
      attachmentB.id,
    );
    storage.values.set(invalidRecordKey, "not-json");
    const invalidKey = `${composerAttachmentDraftStorageScopeKeyPrefix(
      userA,
      conversationA,
    )}not-a-uuid`;
    storage.values.set(invalidKey, "not-json");
    storage.failedGetKeys.add(validKey);
    storage.failedKeyIndexes.add(0);

    const result = readComposerAttachmentDraftScope(
      storage,
      userA,
      conversationA,
      activeNow,
    );
    expect(result.status).toBe("warning");
    if (result.status !== "warning") {
      throw new Error("expected a partial attachment draft read");
    }
    expect(result.active).toEqual([]);
    expect(result.expired).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { key: null, reason: "enumeration_failed" },
        { key: validKey, reason: "read_failed" },
        { key: invalidRecordKey, reason: "invalid_record" },
        { key: invalidKey, reason: "invalid_key" },
      ]),
    );
  });

  it("returns distinguishable unavailable results without propagating storage failures", () => {
    const storage = new MemoryStorage();
    const key = composerAttachmentDraftStorageKey(
      userA,
      conversationA,
      attachmentA.id,
    );
    storage.failedSetKeys.add(key);
    expect(() => writeComposerAttachmentDraft(storage, draft())).not.toThrow();
    expect(writeComposerAttachmentDraft(storage, draft())).toEqual({
      status: "unavailable",
    });

    storage.failedSetKeys.clear();
    writeComposerAttachmentDraft(storage, draft());
    storage.failedGetKeys.add(key);
    expect(() =>
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
        activeNow,
      ),
    ).not.toThrow();
    expect(
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
        activeNow,
      ),
    ).toEqual({ status: "unavailable" });

    storage.failedRemoveKeys.add(key);
    expect(() =>
      removeComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
      ),
    ).not.toThrow();
    expect(
      removeComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
      ),
    ).toEqual({ status: "unavailable" });

    storage.failLength = true;
    expect(
      readComposerAttachmentDraftScope(
        storage,
        userA,
        conversationA,
        activeNow,
      ),
    ).toEqual({ status: "unavailable" });
    expect(
      clearComposerAttachmentDraftScope(storage, userA, conversationA),
    ).toEqual({ status: "unavailable" });
  });

  it("clears only the requested user and scope and reports failed removals", () => {
    const storage = new MemoryStorage();
    const currentA = draft();
    const currentB = draft({ attachment: attachmentB, orderToken: "0002" });
    const otherScope = draft({ scope: conversationB });
    const otherUser = draft({ userId: userB });
    for (const item of [currentA, currentB, otherScope, otherUser]) {
      writeComposerAttachmentDraft(storage, item);
    }
    storage.values.set("unrelated", "preserve me");
    const failedKey = composerAttachmentDraftStorageKey(
      userA,
      conversationA,
      attachmentB.id,
    );
    storage.failedRemoveKeys.add(failedKey);

    const result = clearComposerAttachmentDraftScope(
      storage,
      userA,
      conversationA,
    );
    expect(result.status).toBe("warning");
    if (result.status !== "warning") {
      throw new Error("expected a partial scope clear");
    }
    expect(result.failedKeys).toEqual([failedKey]);
    expect(storage.values.has(failedKey)).toBe(true);
    expect(
      storage.values.has(
        composerAttachmentDraftStorageKey(
          userA,
          conversationA,
          attachmentA.id,
        ),
      ),
    ).toBe(false);
    expect(
      storage.values.has(
        composerAttachmentDraftStorageKey(
          userA,
          conversationB,
          attachmentA.id,
        ),
      ),
    ).toBe(true);
    expect(
      storage.values.has(
        composerAttachmentDraftStorageKey(
          userB,
          conversationA,
          attachmentA.id,
        ),
      ),
    ).toBe(true);
    expect(storage.values.get("unrelated")).toBe("preserve me");
  });

  it("clears every conversation scope for one user while preserving new-conversation and other-user drafts", () => {
    const storage = new MemoryStorage();
    const first = draft();
    const second = draft({
      scope: conversationB,
      attachment: attachmentB,
      orderToken: "0002",
    });
    const newConversation = draft({
      scope: newConversationComposerDraftScope,
      attachment: attachmentB,
      orderToken: "0003",
    });
    const otherUser = draft({ userId: userB, orderToken: "0004" });
    for (const item of [first, second, newConversation, otherUser]) {
      writeComposerAttachmentDraft(storage, item);
    }

    expect(
      clearComposerAttachmentDraftConversationScopes(storage, userA),
    ).toEqual({
      status: "cleared",
      attachmentIds: [attachmentA.id, attachmentB.id],
      conversationIds: [
        conversationA.conversationId,
        conversationB.conversationId,
      ],
      removedKeys: [
        composerAttachmentDraftStorageKey(
          userA,
          conversationA,
          attachmentA.id,
        ),
        composerAttachmentDraftStorageKey(
          userA,
          conversationB,
          attachmentB.id,
        ),
      ],
      failedKeys: [],
      issues: [],
    });
    expect(
      storage.values.has(
        composerAttachmentDraftStorageKey(
          userA,
          newConversationComposerDraftScope,
          attachmentB.id,
        ),
      ),
    ).toBe(true);
    expect(
      storage.values.has(
        composerAttachmentDraftStorageKey(
          userB,
          conversationA,
          attachmentA.id,
        ),
      ),
    ).toBe(true);
  });

  it("matches storage events for only the current scope, including clear events", () => {
    const key = composerAttachmentDraftStorageKey(
      userA,
      conversationA,
      attachmentA.id,
    );
    expect(
      composerAttachmentDraftStorageEventAffectsScope(
        key,
        userA,
        conversationA,
      ),
    ).toBe(true);
    expect(
      composerAttachmentDraftStorageEventAffectsScope(
        null,
        userA,
        conversationA,
      ),
    ).toBe(true);
    expect(
      composerAttachmentDraftStorageEventAffectsScope(
        key,
        userA,
        conversationB,
      ),
    ).toBe(false);
    expect(
      composerAttachmentDraftStorageEventAffectsScope(
        key,
        userB,
        conversationA,
      ),
    ).toBe(false);
    expect(
      composerAttachmentDraftStorageEventAffectsScope(
        "custent:composer-draft:new-conversation",
        userA,
        conversationA,
      ),
    ).toBe(false);
  });

  it("rejects invalid caller data without replacing an existing record", () => {
    const storage = new MemoryStorage();
    writeComposerAttachmentDraft(storage, draft());
    const invalidDraft = {
      ...draft(),
      expiresAt: "not-a-date",
      unexpected: true,
    } as unknown as ComposerAttachmentDraft;

    expect(writeComposerAttachmentDraft(storage, invalidDraft)).toEqual({
      status: "invalid",
    });
    expect(
      readComposerAttachmentDraft(
        storage,
        userA,
        conversationA,
        attachmentA.id,
        activeNow,
      ),
    ).toEqual({ status: "found", draft: draft() });
    expect(
      removeComposerAttachmentDraft(
        storage,
        "not-a-user-id",
        conversationA,
        attachmentA.id,
      ),
    ).toEqual({ status: "invalid" });
    expect(
      readComposerAttachmentDraftScope(
        storage,
        userA,
        conversationA,
        Number.NaN,
      ),
    ).toEqual({ status: "invalid" });
  });
});
