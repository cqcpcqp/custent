import { z } from "zod";

import type { ComposerDraftScope } from "@/components/composer-draft-storage";
import {
  InputAttachmentSummarySchema,
  type InputAttachmentSummary,
} from "@/lib/contracts";

export const composerAttachmentDraftStorageVersion = 1;

const composerAttachmentDraftStorageKeyPrefix =
  `custent:composer-attachment-draft:v${composerAttachmentDraftStorageVersion}`;

const composerAttachmentDraftUserIdSchema = z.string().uuid();
const composerAttachmentDraftAttachmentIdSchema = z.string().uuid();
const composerAttachmentDraftScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new_conversation") }).strict(),
  z
    .object({
      kind: z.literal("conversation"),
      conversationId: z.string().min(1),
    })
    .strict(),
]);

const storedComposerAttachmentDraftSchema = z
  .object({
    version: z.literal(composerAttachmentDraftStorageVersion),
    userId: composerAttachmentDraftUserIdSchema,
    scope: composerAttachmentDraftScopeSchema,
    attachment: InputAttachmentSummarySchema,
    expiresAt: z.string().datetime(),
    orderToken: z.string().min(1),
  })
  .strict();

export type ComposerAttachmentDraft = Readonly<{
  userId: string;
  scope: ComposerDraftScope;
  attachment: InputAttachmentSummary;
  expiresAt: string;
  orderToken: string;
}>;

export type ComposerAttachmentDraftStorage = Pick<
  Storage,
  "getItem" | "key" | "length" | "removeItem" | "setItem"
>;

export type ComposerAttachmentDraftStorageIdentity = Readonly<{
  userId: string;
  scope: ComposerDraftScope;
  attachmentId: string;
}>;

export type ComposerAttachmentDraftReadResult =
  | Readonly<{ status: "found"; draft: ComposerAttachmentDraft }>
  | Readonly<{ status: "expired"; draft: ComposerAttachmentDraft }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unavailable" }>;

export type ComposerAttachmentDraftScopeReadIssue = Readonly<{
  key: string | null;
  reason:
    | "enumeration_failed"
    | "invalid_key"
    | "invalid_record"
    | "read_failed";
}>;

export type ComposerAttachmentDraftScopeReadResult =
  | Readonly<{
      status: "ok" | "warning";
      active: readonly ComposerAttachmentDraft[];
      expired: readonly ComposerAttachmentDraft[];
      issues: readonly ComposerAttachmentDraftScopeReadIssue[];
    }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unavailable" }>;

export type ComposerAttachmentDraftWriteResult =
  | Readonly<{ status: "written"; key: string }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unavailable" }>;

export type ComposerAttachmentDraftRemoveResult =
  | Readonly<{ status: "removed"; key: string }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unavailable" }>;

export type ComposerAttachmentDraftScopeClearResult =
  | Readonly<{
      status: "cleared" | "warning";
      removedKeys: readonly string[];
      failedKeys: readonly string[];
      issues: readonly ComposerAttachmentDraftScopeReadIssue[];
    }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unavailable" }>;

export type ComposerAttachmentDraftConversationScopesClearResult =
  | Readonly<{
      status: "cleared" | "warning";
      attachmentIds: readonly string[];
      conversationIds: readonly string[];
      removedKeys: readonly string[];
      failedKeys: readonly string[];
      issues: readonly ComposerAttachmentDraftScopeReadIssue[];
    }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "unavailable" }>;

function validComposerAttachmentDraftScope(
  value: unknown,
): value is ComposerDraftScope {
  return composerAttachmentDraftScopeSchema.safeParse(value).success;
}

function sameComposerAttachmentDraftScope(
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

function validComposerAttachmentDraftIdentity(
  identity: ComposerAttachmentDraftStorageIdentity,
): boolean {
  return (
    composerAttachmentDraftUserIdSchema.safeParse(identity.userId).success &&
    validComposerAttachmentDraftScope(identity.scope) &&
    composerAttachmentDraftAttachmentIdSchema.safeParse(identity.attachmentId)
      .success
  );
}

function composerAttachmentDraftScopeStorageSegment(
  scope: ComposerDraftScope,
): string {
  return scope.kind === "new_conversation"
    ? "new-conversation"
    : `conversation:${encodeURIComponent(scope.conversationId)}`;
}

function validComposerAttachmentDraftOwnerAndScope(
  userId: string,
  scope: ComposerDraftScope,
): boolean {
  return (
    composerAttachmentDraftUserIdSchema.safeParse(userId).success &&
    validComposerAttachmentDraftScope(scope)
  );
}

export function composerAttachmentDraftStorageScopeKeyPrefix(
  userId: string,
  scope: ComposerDraftScope,
): string {
  if (!validComposerAttachmentDraftOwnerAndScope(userId, scope)) {
    throw new Error("附件草稿存储作用域不符合固定契约");
  }
  return `${composerAttachmentDraftStorageKeyPrefix}:user:${encodeURIComponent(
    userId,
  )}:${composerAttachmentDraftScopeStorageSegment(scope)}:attachment:`;
}

export function composerAttachmentDraftStorageKey(
  userId: string,
  scope: ComposerDraftScope,
  attachmentId: string,
): string {
  const identity = { userId, scope, attachmentId };
  if (!validComposerAttachmentDraftIdentity(identity)) {
    throw new Error("附件草稿存储标识不符合固定契约");
  }
  return `${composerAttachmentDraftStorageScopeKeyPrefix(
    userId,
    scope,
  )}${encodeURIComponent(attachmentId)}`;
}

function decodedKeySegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseComposerAttachmentDraftStorageKey(
  key: string,
): ComposerAttachmentDraftStorageIdentity | null {
  const parts = key.split(":");
  if (
    parts[0] !== "custent" ||
    parts[1] !== "composer-attachment-draft" ||
    parts[2] !== `v${composerAttachmentDraftStorageVersion}` ||
    parts[3] !== "user"
  ) {
    return null;
  }

  const userId = decodedKeySegment(parts[4] ?? "");
  let scope: ComposerDraftScope;
  let attachmentIdPart: string;
  if (
    parts.length === 8 &&
    parts[5] === "new-conversation" &&
    parts[6] === "attachment"
  ) {
    scope = { kind: "new_conversation" };
    attachmentIdPart = parts[7];
  } else if (
    parts.length === 9 &&
    parts[5] === "conversation" &&
    parts[7] === "attachment"
  ) {
    const conversationId = decodedKeySegment(parts[6]);
    if (conversationId === null) {
      return null;
    }
    scope = { kind: "conversation", conversationId };
    attachmentIdPart = parts[8];
  } else {
    return null;
  }

  const attachmentId = decodedKeySegment(attachmentIdPart);
  if (userId === null || attachmentId === null) {
    return null;
  }
  const identity = { userId, scope, attachmentId };
  if (
    !validComposerAttachmentDraftIdentity(identity) ||
    composerAttachmentDraftStorageKey(userId, scope, attachmentId) !== key
  ) {
    return null;
  }
  return identity;
}

export function composerAttachmentDraftStorageEventAffectsScope(
  key: string | null,
  userId: string,
  scope: ComposerDraftScope,
): boolean {
  if (!validComposerAttachmentDraftOwnerAndScope(userId, scope)) {
    return false;
  }
  if (key === null) {
    return true;
  }
  return key.startsWith(
    composerAttachmentDraftStorageScopeKeyPrefix(userId, scope),
  );
}

export function serializeComposerAttachmentDraft(
  draft: ComposerAttachmentDraft,
): string | null {
  try {
    const parsed = storedComposerAttachmentDraftSchema.safeParse({
      version: composerAttachmentDraftStorageVersion,
      ...draft,
    });
    return parsed.success ? JSON.stringify(parsed.data) : null;
  } catch {
    return null;
  }
}

export function parseComposerAttachmentDraft(
  serializedDraft: string,
  expectedIdentity: ComposerAttachmentDraftStorageIdentity,
): ComposerAttachmentDraft | null {
  if (!validComposerAttachmentDraftIdentity(expectedIdentity)) {
    return null;
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(serializedDraft);
  } catch {
    return null;
  }
  const parsed = storedComposerAttachmentDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }

  const draft: ComposerAttachmentDraft = {
    userId: parsed.data.userId,
    scope: parsed.data.scope,
    attachment: parsed.data.attachment,
    expiresAt: parsed.data.expiresAt,
    orderToken: parsed.data.orderToken,
  };
  if (
    draft.userId !== expectedIdentity.userId ||
    !sameComposerAttachmentDraftScope(draft.scope, expectedIdentity.scope) ||
    draft.attachment.id !== expectedIdentity.attachmentId
  ) {
    return null;
  }
  return draft;
}

function composerAttachmentDraftIsExpired(
  draft: ComposerAttachmentDraft,
  now: number,
): boolean {
  return Date.parse(draft.expiresAt) <= now;
}

export function readComposerAttachmentDraft(
  storage: ComposerAttachmentDraftStorage,
  userId: string,
  scope: ComposerDraftScope,
  attachmentId: string,
  now = Date.now(),
): ComposerAttachmentDraftReadResult {
  const identity = { userId, scope, attachmentId };
  if (!validComposerAttachmentDraftIdentity(identity) || !Number.isFinite(now)) {
    return { status: "invalid" };
  }

  let serializedDraft: string | null;
  try {
    serializedDraft = storage.getItem(
      composerAttachmentDraftStorageKey(userId, scope, attachmentId),
    );
  } catch {
    return { status: "unavailable" };
  }
  if (serializedDraft === null) {
    return { status: "missing" };
  }

  const draft = parseComposerAttachmentDraft(serializedDraft, identity);
  if (draft === null) {
    return { status: "invalid" };
  }
  return composerAttachmentDraftIsExpired(draft, now)
    ? { status: "expired", draft }
    : { status: "found", draft };
}

type ComposerAttachmentDraftScopeKeysResult =
  | Readonly<{
      status: "ok";
      keys: readonly string[];
      issues: readonly ComposerAttachmentDraftScopeReadIssue[];
    }>
  | Readonly<{ status: "unavailable" }>;

function composerAttachmentDraftScopeKeys(
  storage: ComposerAttachmentDraftStorage,
  userId: string,
  scope: ComposerDraftScope,
): ComposerAttachmentDraftScopeKeysResult {
  let storageLength: number;
  try {
    storageLength = storage.length;
  } catch {
    return { status: "unavailable" };
  }

  const prefix = composerAttachmentDraftStorageScopeKeyPrefix(userId, scope);
  const keys = new Set<string>();
  const issues: ComposerAttachmentDraftScopeReadIssue[] = [];
  for (let index = 0; index < storageLength; index += 1) {
    let key: string | null;
    try {
      key = storage.key(index);
    } catch {
      issues.push({ key: null, reason: "enumeration_failed" });
      continue;
    }
    if (key !== null && key.startsWith(prefix)) {
      keys.add(key);
    }
  }
  return { status: "ok", keys: Array.from(keys), issues };
}

function compareComposerAttachmentDraftOrder(
  left: ComposerAttachmentDraft,
  right: ComposerAttachmentDraft,
): number {
  if (left.orderToken < right.orderToken) {
    return -1;
  }
  if (left.orderToken > right.orderToken) {
    return 1;
  }
  if (left.attachment.id < right.attachment.id) {
    return -1;
  }
  if (left.attachment.id > right.attachment.id) {
    return 1;
  }
  return 0;
}

export function readComposerAttachmentDraftScope(
  storage: ComposerAttachmentDraftStorage,
  userId: string,
  scope: ComposerDraftScope,
  now = Date.now(),
): ComposerAttachmentDraftScopeReadResult {
  if (
    !validComposerAttachmentDraftOwnerAndScope(userId, scope) ||
    !Number.isFinite(now)
  ) {
    return { status: "invalid" };
  }

  const scopeKeys = composerAttachmentDraftScopeKeys(storage, userId, scope);
  if (scopeKeys.status === "unavailable") {
    return scopeKeys;
  }

  const active: ComposerAttachmentDraft[] = [];
  const expired: ComposerAttachmentDraft[] = [];
  const issues = [...scopeKeys.issues];
  for (const key of scopeKeys.keys) {
    const identity = parseComposerAttachmentDraftStorageKey(key);
    if (identity === null) {
      issues.push({ key, reason: "invalid_key" });
      continue;
    }

    let serializedDraft: string | null;
    try {
      serializedDraft = storage.getItem(key);
    } catch {
      issues.push({ key, reason: "read_failed" });
      continue;
    }
    if (serializedDraft === null) {
      continue;
    }

    const draft = parseComposerAttachmentDraft(serializedDraft, identity);
    if (draft === null) {
      issues.push({ key, reason: "invalid_record" });
      continue;
    }
    (composerAttachmentDraftIsExpired(draft, now) ? expired : active).push(
      draft,
    );
  }

  active.sort(compareComposerAttachmentDraftOrder);
  expired.sort(compareComposerAttachmentDraftOrder);
  return {
    status: issues.length === 0 ? "ok" : "warning",
    active,
    expired,
    issues,
  };
}

export function writeComposerAttachmentDraft(
  storage: ComposerAttachmentDraftStorage,
  draft: ComposerAttachmentDraft,
): ComposerAttachmentDraftWriteResult {
  const serializedDraft = serializeComposerAttachmentDraft(draft);
  if (serializedDraft === null) {
    return { status: "invalid" };
  }

  let key: string;
  try {
    key = composerAttachmentDraftStorageKey(
      draft.userId,
      draft.scope,
      draft.attachment.id,
    );
    storage.setItem(key, serializedDraft);
  } catch {
    return { status: "unavailable" };
  }
  return { status: "written", key };
}

export function removeComposerAttachmentDraft(
  storage: ComposerAttachmentDraftStorage,
  userId: string,
  scope: ComposerDraftScope,
  attachmentId: string,
): ComposerAttachmentDraftRemoveResult {
  const identity = { userId, scope, attachmentId };
  if (!validComposerAttachmentDraftIdentity(identity)) {
    return { status: "invalid" };
  }

  const key = composerAttachmentDraftStorageKey(
    userId,
    scope,
    attachmentId,
  );
  try {
    storage.removeItem(key);
  } catch {
    return { status: "unavailable" };
  }
  return { status: "removed", key };
}

export function clearComposerAttachmentDraftScope(
  storage: ComposerAttachmentDraftStorage,
  userId: string,
  scope: ComposerDraftScope,
): ComposerAttachmentDraftScopeClearResult {
  if (!validComposerAttachmentDraftOwnerAndScope(userId, scope)) {
    return { status: "invalid" };
  }

  const scopeKeys = composerAttachmentDraftScopeKeys(storage, userId, scope);
  if (scopeKeys.status === "unavailable") {
    return scopeKeys;
  }

  const removedKeys: string[] = [];
  const failedKeys: string[] = [];
  for (const key of scopeKeys.keys) {
    try {
      storage.removeItem(key);
      removedKeys.push(key);
    } catch {
      failedKeys.push(key);
    }
  }
  return {
    status:
      scopeKeys.issues.length === 0 && failedKeys.length === 0
        ? "cleared"
        : "warning",
    removedKeys,
    failedKeys,
    issues: scopeKeys.issues,
  };
}

export function clearComposerAttachmentDraftConversationScopes(
  storage: ComposerAttachmentDraftStorage,
  userId: string,
): ComposerAttachmentDraftConversationScopesClearResult {
  if (!composerAttachmentDraftUserIdSchema.safeParse(userId).success) {
    return { status: "invalid" };
  }

  let storageLength: number;
  try {
    storageLength = storage.length;
  } catch {
    return { status: "unavailable" };
  }

  const conversationPrefix =
    `${composerAttachmentDraftStorageKeyPrefix}:user:${encodeURIComponent(
      userId,
    )}:conversation:`;
  const keys = new Set<string>();
  const issues: ComposerAttachmentDraftScopeReadIssue[] = [];
  for (let index = 0; index < storageLength; index += 1) {
    try {
      const key = storage.key(index);
      if (key !== null && key.startsWith(conversationPrefix)) {
        keys.add(key);
      }
    } catch {
      issues.push({ key: null, reason: "enumeration_failed" });
    }
  }

  const attachmentIds = new Set<string>();
  const conversationIds = new Set<string>();
  const removedKeys: string[] = [];
  const failedKeys: string[] = [];
  for (const key of keys) {
    const identity = parseComposerAttachmentDraftStorageKey(key);
    if (
      identity === null ||
      identity.userId !== userId ||
      identity.scope.kind !== "conversation"
    ) {
      issues.push({ key, reason: "invalid_key" });
    } else {
      attachmentIds.add(identity.attachmentId);
      conversationIds.add(identity.scope.conversationId);
    }

    try {
      storage.removeItem(key);
      removedKeys.push(key);
    } catch {
      failedKeys.push(key);
    }
  }

  return {
    status:
      issues.length === 0 && failedKeys.length === 0
        ? "cleared"
        : "warning",
    attachmentIds: Array.from(attachmentIds),
    conversationIds: Array.from(conversationIds),
    removedKeys,
    failedKeys,
    issues,
  };
}
