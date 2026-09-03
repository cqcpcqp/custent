import { describe, expect, it } from "vitest";

import { ApiClientError } from "@/components/api-client";
import {
  reconcileRecoveredComposerAttachmentDrafts,
  recoverComposerAttachmentDrafts,
} from "@/components/composer-attachment-draft-recovery";
import type { DraftInputAttachment } from "@/components/input-attachment-state";
import type { ComposerAttachmentDraft } from "@/components/composer-attachment-draft-storage";

const first: ComposerAttachmentDraft = {
  userId: "00000000-0000-4000-8000-000000000001",
  scope: {
    kind: "conversation",
    conversationId: "10000000-0000-4000-8000-000000000001",
  },
  attachment: {
    id: "20000000-0000-4000-8000-000000000001",
    kind: "file",
    name: "buyers.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    downloadUrl:
      "/api/input-attachments/20000000-0000-4000-8000-000000000001/content",
    createdAt: "2026-08-29T08:00:00.000Z",
  },
  expiresAt: "2026-08-30T08:00:00.000Z",
  orderToken: "0001",
};

const second: ComposerAttachmentDraft = {
  ...first,
  attachment: {
    ...first.attachment,
    id: "20000000-0000-4000-8000-000000000002",
    name: "factory.txt",
    downloadUrl:
      "/api/input-attachments/20000000-0000-4000-8000-000000000002/content",
  },
  orderToken: "0002",
};

describe("composer attachment draft recovery", () => {
  it("keeps server-confirmed metadata in stored order", async () => {
    const controller = new AbortController();
    const result = await recoverComposerAttachmentDrafts(
      [first, second],
      async (attachmentId) => {
        const stored = attachmentId === first.attachment.id ? first : second;
        return {
          attachment: { ...stored.attachment, name: `${stored.attachment.name}!` },
          expiresAt: stored.expiresAt,
        };
      },
      controller.signal,
    );

    expect(result.recovered.map((item) => item.metadata.attachment.name)).toEqual([
      "buyers.txt!",
      "factory.txt!",
    ]);
    expect(result.invalidated).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("reconciles server-confirmed order while retaining local and retryable work", () => {
    const confirmedCurrent: DraftInputAttachment = {
      clientId: "local-confirmed",
      name: first.attachment.name,
      mimeType: first.attachment.mimeType,
      sizeBytes: first.attachment.sizeBytes,
      previewUrl: "blob:first",
      status: "uploaded",
      attachment: first.attachment,
    };
    const retryableCurrent: DraftInputAttachment = {
      clientId: "local-retryable",
      name: second.attachment.name,
      mimeType: second.attachment.mimeType,
      sizeBytes: second.attachment.sizeBytes,
      previewUrl: null,
      status: "uploaded",
      attachment: second.attachment,
    };
    const localFile = new File(["new"], "new.txt", { type: "text/plain" });
    const uploading: DraftInputAttachment = {
      clientId: "local-uploading",
      file: localFile,
      name: localFile.name,
      mimeType: "text/plain",
      sizeBytes: localFile.size,
      previewUrl: null,
      status: "uploading",
    };
    const recoveryError = new Error("network");
    const result = reconcileRecoveredComposerAttachmentDrafts({
      current: [confirmedCurrent, retryableCurrent, uploading],
      stored: [first, second],
      recovery: {
        recovered: [
          {
            stored: first,
            metadata: {
              attachment: { ...first.attachment, name: "server-first.txt" },
              expiresAt: first.expiresAt,
            },
          },
        ],
        invalidated: [],
        failures: [{ stored: second, error: recoveryError }],
      },
      unpersistedAttachmentIds: new Set(),
    });

    expect(result.attachments).toHaveLength(3);
    expect(result.attachments[0]).toMatchObject({
      clientId: `staged:${first.attachment.id}`,
      name: "server-first.txt",
      previewUrl: null,
      status: "uploaded",
    });
    expect(result.attachments[1]).toBe(retryableCurrent);
    expect(result.attachments[2]).toBe(uploading);
    expect(result.removed).toEqual([confirmedCurrent]);
  });

  it("drops persisted records removed by another tab but preserves unpersisted uploads", () => {
    const persisted: DraftInputAttachment = {
      clientId: "persisted",
      name: first.attachment.name,
      mimeType: first.attachment.mimeType,
      sizeBytes: first.attachment.sizeBytes,
      previewUrl: null,
      status: "uploaded",
      attachment: first.attachment,
    };
    const unpersisted: DraftInputAttachment = {
      clientId: "unpersisted",
      name: second.attachment.name,
      mimeType: second.attachment.mimeType,
      sizeBytes: second.attachment.sizeBytes,
      previewUrl: null,
      status: "uploaded",
      attachment: second.attachment,
    };
    const result = reconcileRecoveredComposerAttachmentDrafts({
      current: [persisted, unpersisted],
      stored: [],
      recovery: { recovered: [], invalidated: [], failures: [] },
      unpersistedAttachmentIds: new Set([second.attachment.id]),
    });

    expect(result.attachments).toEqual([unpersisted]);
    expect(result.removed).toEqual([persisted]);
  });

  it("classifies only a real 404 as invalid and retains retryable failures", async () => {
    const controller = new AbortController();
    const result = await recoverComposerAttachmentDrafts(
      [first, second],
      async (attachmentId) => {
        if (attachmentId === first.attachment.id) {
          throw new ApiClientError("NOT_FOUND", "附件不存在。", 404);
        }
        throw new ApiClientError("INTERNAL_ERROR", "暂时不可用。", 500);
      },
      controller.signal,
    );

    expect(result.recovered).toEqual([]);
    expect(result.invalidated).toEqual([first]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.stored).toBe(second);
  });

  it("treats identity and expiration mismatches as retryable contract failures", async () => {
    const controller = new AbortController();
    const wrongId = await recoverComposerAttachmentDrafts(
      [first],
      async () => ({
        attachment: second.attachment,
        expiresAt: first.expiresAt,
      }),
      controller.signal,
    );
    expect(wrongId.failures[0]?.error).toEqual(
      new Error(`恢复附件 ${first.attachment.id} 返回了不一致的 attachmentId`),
    );

    const wrongExpiry = await recoverComposerAttachmentDrafts(
      [first],
      async () => ({
        attachment: first.attachment,
        expiresAt: "2026-08-31T08:00:00.000Z",
      }),
      controller.signal,
    );
    expect(wrongExpiry.failures[0]?.error).toEqual(
      new Error(`恢复附件 ${first.attachment.id} 返回了不一致的 expiresAt`),
    );
  });

  it("rejects duplicate identities and propagates cancellation", async () => {
    const controller = new AbortController();
    await expect(
      recoverComposerAttachmentDrafts(
        [first, first],
        async () => ({ attachment: first.attachment, expiresAt: first.expiresAt }),
        controller.signal,
      ),
    ).rejects.toThrow("待恢复附件草稿包含重复 attachmentId");

    const cancelled = new AbortController();
    cancelled.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      recoverComposerAttachmentDrafts(
        [first],
        async () => ({ attachment: first.attachment, expiresAt: first.expiresAt }),
        cancelled.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
