import { ApiClientError } from "@/components/api-client";
import type { ComposerAttachmentDraft } from "@/components/composer-attachment-draft-storage";
import {
  restoreUploadedDraftInputAttachments,
  type DraftInputAttachment,
} from "@/components/input-attachment-state";
import type { UploadInputAttachmentResponse } from "@/lib/contracts";

export type RecoveredComposerAttachmentDraft = Readonly<{
  stored: ComposerAttachmentDraft;
  metadata: UploadInputAttachmentResponse;
}>;

export type ComposerAttachmentDraftRecoveryFailure = Readonly<{
  stored: ComposerAttachmentDraft;
  error: unknown;
}>;

export type ComposerAttachmentDraftRecoveryResult = Readonly<{
  recovered: readonly RecoveredComposerAttachmentDraft[];
  invalidated: readonly ComposerAttachmentDraft[];
  failures: readonly ComposerAttachmentDraftRecoveryFailure[];
}>;

export type ComposerAttachmentDraftReconciliation = Readonly<{
  attachments: readonly DraftInputAttachment[];
  removed: readonly DraftInputAttachment[];
}>;

function uploadedAttachmentId(
  attachment: DraftInputAttachment,
): string | null {
  return attachment.status === "uploaded" || attachment.status === "deleting"
    ? attachment.attachment.id
    : null;
}

export function reconcileRecoveredComposerAttachmentDrafts(input: {
  current: readonly DraftInputAttachment[];
  stored: readonly ComposerAttachmentDraft[];
  recovery: ComposerAttachmentDraftRecoveryResult;
  unpersistedAttachmentIds: ReadonlySet<string>;
}): ComposerAttachmentDraftReconciliation {
  const storedIds = new Set(input.stored.map((draft) => draft.attachment.id));
  if (storedIds.size !== input.stored.length) {
    throw new Error("已存储附件草稿包含重复 attachmentId");
  }

  const currentByAttachmentId = new Map<string, DraftInputAttachment>();
  for (const attachment of input.current) {
    const attachmentId = uploadedAttachmentId(attachment);
    if (attachmentId !== null) {
      currentByAttachmentId.set(attachmentId, attachment);
    }
  }
  const restoredByAttachmentId = new Map(
    restoreUploadedDraftInputAttachments(
      input.recovery.recovered.map((item) => item.metadata.attachment),
    ).map((attachment) => [attachment.attachment.id, attachment]),
  );
  const failedIds = new Set(
    input.recovery.failures.map((failure) => failure.stored.attachment.id),
  );

  const attachments: DraftInputAttachment[] = [];
  const includedClientIds = new Set<string>();
  for (const stored of input.stored) {
    const attachmentId = stored.attachment.id;
    const current = currentByAttachmentId.get(attachmentId);
    const next =
      current?.status === "deleting" || failedIds.has(attachmentId)
        ? current
        : restoredByAttachmentId.get(attachmentId);
    if (next !== undefined) {
      attachments.push(next);
      includedClientIds.add(next.clientId);
    }
  }

  for (const attachment of input.current) {
    if (includedClientIds.has(attachment.clientId)) {
      continue;
    }
    const attachmentId = uploadedAttachmentId(attachment);
    if (
      attachmentId === null ||
      input.unpersistedAttachmentIds.has(attachmentId)
    ) {
      attachments.push(attachment);
      includedClientIds.add(attachment.clientId);
    }
  }

  const retainedClientIds = new Set(
    attachments.map((attachment) => attachment.clientId),
  );
  return {
    attachments,
    removed: input.current.filter(
      (attachment) => !retainedClientIds.has(attachment.clientId),
    ),
  };
}

export async function recoverComposerAttachmentDrafts(
  drafts: readonly ComposerAttachmentDraft[],
  getMetadata: (
    attachmentId: string,
    signal: AbortSignal,
  ) => Promise<UploadInputAttachmentResponse>,
  signal: AbortSignal,
): Promise<ComposerAttachmentDraftRecoveryResult> {
  const attachmentIds = drafts.map((draft) => draft.attachment.id);
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error("待恢复附件草稿包含重复 attachmentId");
  }

  const recovered: RecoveredComposerAttachmentDraft[] = [];
  const invalidated: ComposerAttachmentDraft[] = [];
  const failures: ComposerAttachmentDraftRecoveryFailure[] = [];

  for (const stored of drafts) {
    if (signal.aborted) {
      throw signal.reason;
    }
    try {
      const metadata = await getMetadata(stored.attachment.id, signal);
      if (metadata.attachment.id !== stored.attachment.id) {
        throw new Error(
          `恢复附件 ${stored.attachment.id} 返回了不一致的 attachmentId`,
        );
      }
      if (metadata.expiresAt !== stored.expiresAt) {
        throw new Error(
          `恢复附件 ${stored.attachment.id} 返回了不一致的 expiresAt`,
        );
      }
      recovered.push({ stored, metadata });
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason;
      }
      if (
        error instanceof ApiClientError &&
        error.code === "NOT_FOUND" &&
        error.status === 404
      ) {
        invalidated.push(stored);
      } else {
        failures.push({ stored, error });
      }
    }
  }

  return { recovered, invalidated, failures };
}
