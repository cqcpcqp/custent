export const composerDraftStorageVersion = 1;
export const composerDraftMaxLength = 20_000;

const composerDraftStorageKeyPrefix = "custent:composer-draft";
export const conversationComposerDraftStorageKeyPrefix =
  `${composerDraftStorageKeyPrefix}:conversation:`;

export const newConversationComposerDraftScope = {
  kind: "new_conversation",
} as const;

export type ConversationComposerDraftScope = {
  kind: "conversation";
  conversationId: string;
};

export type ComposerDraftScope =
  | typeof newConversationComposerDraftScope
  | ConversationComposerDraftScope;

export type ComposerDraftStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export type EnumerableComposerDraftStorage = ComposerDraftStorage &
  Pick<Storage, "key" | "length">;

export type ConversationComposerDraftClearResult =
  | Readonly<{
      status: "cleared" | "warning";
      removedKeys: readonly string[];
      failedKeys: readonly string[];
      enumerationFailureCount: number;
    }>
  | Readonly<{ status: "unavailable" }>;

type StoredComposerDraft = {
  version: typeof composerDraftStorageVersion;
  scope: ComposerDraftScope;
  text: string;
};

export function conversationComposerDraftScope(
  conversationId: string,
): ConversationComposerDraftScope {
  if (conversationId.length === 0) {
    throw new Error("会话草稿必须关联非空 conversationId");
  }
  return { kind: "conversation", conversationId };
}

function exactObjectKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function validComposerDraftScope(value: unknown): value is ComposerDraftScope {
  if (!exactObjectKeys(value, ["kind"])) {
    if (!exactObjectKeys(value, ["kind", "conversationId"])) {
      return false;
    }
    return (
      value.kind === "conversation" &&
      typeof value.conversationId === "string" &&
      value.conversationId.length > 0
    );
  }
  return value.kind === "new_conversation";
}

function sameComposerDraftScope(
  left: ComposerDraftScope,
  right: ComposerDraftScope,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "new_conversation") {
    return true;
  }
  return (
    right.kind === "conversation" &&
    left.conversationId === right.conversationId
  );
}

function validStoredComposerDraft(
  value: unknown,
): value is StoredComposerDraft {
  if (!exactObjectKeys(value, ["version", "scope", "text"])) {
    return false;
  }
  return (
    value.version === composerDraftStorageVersion &&
    validComposerDraftScope(value.scope) &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= composerDraftMaxLength
  );
}

export function composerDraftStorageKey(scope: ComposerDraftScope): string {
  if (!validComposerDraftScope(scope)) {
    throw new Error("草稿存储作用域不符合固定契约");
  }
  if (scope.kind === "new_conversation") {
    return `${composerDraftStorageKeyPrefix}:new-conversation`;
  }
  return `${composerDraftStorageKeyPrefix}:conversation:${encodeURIComponent(
    scope.conversationId,
  )}`;
}

export function serializeComposerDraft(
  scope: ComposerDraftScope,
  text: string,
): string | null {
  if (
    !validComposerDraftScope(scope) ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > composerDraftMaxLength
  ) {
    return null;
  }

  const storedDraft: StoredComposerDraft = {
    version: composerDraftStorageVersion,
    scope,
    text,
  };
  return JSON.stringify(storedDraft);
}

export function parseComposerDraft(
  serializedDraft: string,
  expectedScope: ComposerDraftScope,
): string | null {
  if (!validComposerDraftScope(expectedScope)) {
    return null;
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(serializedDraft);
  } catch {
    return null;
  }

  if (
    !validStoredComposerDraft(candidate) ||
    !sameComposerDraftScope(candidate.scope, expectedScope)
  ) {
    return null;
  }
  return candidate.text;
}

export function readComposerDraft(
  storage: ComposerDraftStorage,
  scope: ComposerDraftScope,
): string | null {
  try {
    const serializedDraft = storage.getItem(composerDraftStorageKey(scope));
    return serializedDraft === null
      ? null
      : parseComposerDraft(serializedDraft, scope);
  } catch {
    return null;
  }
}

export function removeComposerDraft(
  storage: ComposerDraftStorage,
  scope: ComposerDraftScope,
): boolean {
  try {
    storage.removeItem(composerDraftStorageKey(scope));
    return true;
  } catch {
    return false;
  }
}

export function writeComposerDraft(
  storage: ComposerDraftStorage,
  scope: ComposerDraftScope,
  text: string,
): boolean {
  if (typeof text !== "string") {
    return false;
  }
  if (text.length === 0) {
    return removeComposerDraft(storage, scope);
  }

  const serializedDraft = serializeComposerDraft(scope, text);
  if (serializedDraft === null) {
    return false;
  }

  try {
    storage.setItem(composerDraftStorageKey(scope), serializedDraft);
    return true;
  } catch {
    return false;
  }
}

export function clearConversationComposerDrafts(
  storage: EnumerableComposerDraftStorage,
): ConversationComposerDraftClearResult {
  let storageLength: number;
  try {
    storageLength = storage.length;
  } catch {
    return { status: "unavailable" };
  }

  const keys = new Set<string>();
  let enumerationFailureCount = 0;
  for (let index = 0; index < storageLength; index += 1) {
    try {
      const key = storage.key(index);
      if (
        key !== null &&
        key.startsWith(conversationComposerDraftStorageKeyPrefix)
      ) {
        keys.add(key);
      }
    } catch {
      enumerationFailureCount += 1;
    }
  }

  const removedKeys: string[] = [];
  const failedKeys: string[] = [];
  for (const key of keys) {
    try {
      storage.removeItem(key);
      removedKeys.push(key);
    } catch {
      failedKeys.push(key);
    }
  }
  return {
    status:
      enumerationFailureCount === 0 && failedKeys.length === 0
        ? "cleared"
        : "warning",
    removedKeys,
    failedKeys,
    enumerationFailureCount,
  };
}
