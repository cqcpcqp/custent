import {
  ExecutionProfileIdSchema,
  type ExecutionProfileCatalog,
  type ExecutionProfileId,
} from "@/lib/contracts";

import type { ComposerDraftScope } from "./composer-draft-storage";
import {
  composerDraftStorageKey,
  conversationComposerDraftStorageKeyPrefix,
} from "./composer-draft-storage";

const storageVersion = 1;
const storageKeyPrefix = "custent:execution-profile";

export type ExecutionProfileDraftStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export type EnumerableExecutionProfileDraftStorage =
  ExecutionProfileDraftStorage & Pick<Storage, "key" | "length">;

export type ConversationExecutionProfileDraftClearResult =
  | Readonly<{
      status: "cleared" | "warning";
      removedKeys: readonly string[];
      failedKeys: readonly string[];
      enumerationFailureCount: number;
    }>
  | Readonly<{ status: "unavailable" }>;

function storageKey(scope: ComposerDraftScope): string {
  return `${storageKeyPrefix}:${composerDraftStorageKey(scope)}`;
}

const conversationExecutionProfileDraftStorageKeyPrefix =
  `${storageKeyPrefix}:${conversationComposerDraftStorageKeyPrefix}`;

export function executionProfileDraftIdForCatalog(
  executionProfileId: ExecutionProfileId,
  catalog: ExecutionProfileCatalog,
): ExecutionProfileId {
  return catalog.options.some((option) => option.id === executionProfileId)
    ? executionProfileId
    : catalog.defaultId;
}

export function readExecutionProfileDraft(
  storage: ExecutionProfileDraftStorage,
  scope: ComposerDraftScope,
  catalog: ExecutionProfileCatalog,
): ExecutionProfileId | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(storageKey(scope));
  } catch {
    return null;
  }
  if (serialized === null) {
    return null;
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 2 ||
    !("version" in candidate) ||
    candidate.version !== storageVersion ||
    !("executionProfileId" in candidate)
  ) {
    return null;
  }
  const parsed = ExecutionProfileIdSchema.safeParse(
    candidate.executionProfileId,
  );
  if (!parsed.success) {
    return null;
  }
  const resolvedProfileId = executionProfileDraftIdForCatalog(
    parsed.data,
    catalog,
  );
  if (resolvedProfileId === parsed.data) {
    return parsed.data;
  }

  // The persisted value still belongs to the versioned enum, but the live
  // catalog can retire individual profiles. Migrate that local preference to
  // the catalog's declared default before exposing it to the strict picker.
  writeExecutionProfileDraft(storage, scope, resolvedProfileId);
  return resolvedProfileId;
}

export function writeExecutionProfileDraft(
  storage: ExecutionProfileDraftStorage,
  scope: ComposerDraftScope,
  executionProfileId: ExecutionProfileId,
): boolean {
  const parsed = ExecutionProfileIdSchema.safeParse(executionProfileId);
  if (!parsed.success) {
    return false;
  }
  try {
    storage.setItem(
      storageKey(scope),
      JSON.stringify({
        version: storageVersion,
        executionProfileId: parsed.data,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function removeExecutionProfileDraft(
  storage: ExecutionProfileDraftStorage,
  scope: ComposerDraftScope,
): boolean {
  try {
    storage.removeItem(storageKey(scope));
    return true;
  } catch {
    return false;
  }
}

export function clearConversationExecutionProfileDrafts(
  storage: EnumerableExecutionProfileDraftStorage,
): ConversationExecutionProfileDraftClearResult {
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
        key.startsWith(conversationExecutionProfileDraftStorageKeyPrefix)
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
