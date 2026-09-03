import { describe, expect, it, vi } from "vitest";

import {
  attachmentIdsForSubmission,
  canAddInputAttachment,
  canSubmitDraft,
  createInputAttachmentPreviewUrl,
  draftInputAttachmentTotalBytes,
  failedDraftInputAttachment,
  formatAttachmentBytes,
  inputAttachmentMimeTypeForCandidate,
  inputAttachmentTypeLabel,
  releaseDraftInputAttachmentResources,
  removeDraftInputAttachment,
  replaceDraftInputAttachment,
  restoreUploadedDraftInputAttachments,
  retryDraftInputAttachment,
  validateDraftInputAttachmentLimits,
  validateInputAttachmentCandidate,
  type InputAttachmentCandidate,
  type DraftInputAttachment,
} from "@/components/input-attachment-state";
import type {
  InputAttachmentLimits,
  InputAttachmentSummary,
} from "@/lib/contracts";
import {
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_MIME_TYPES,
  INPUT_ATTACHMENT_SUPPORT_TEXT,
} from "@/lib/input-attachment-formats";

const attachmentA: InputAttachmentSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "file",
  name: "buyers.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  downloadUrl:
    "/api/input-attachments/10000000-0000-4000-8000-000000000001/content",
  createdAt: "2026-08-25T01:00:00.000Z",
};

const attachmentB: InputAttachmentSummary = {
  id: "10000000-0000-4000-8000-000000000002",
  kind: "image",
  name: "product.png",
  mimeType: "image/png",
  sizeBytes: 2048,
  downloadUrl:
    "/api/input-attachments/10000000-0000-4000-8000-000000000002/content",
  createdAt: "2026-08-25T01:01:00.000Z",
};

const attachmentLimits: InputAttachmentLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFilesPerMessage: 5,
  maxTotalBytesPerMessage: 20 * 1024 * 1024,
};

function validateCandidate(candidate: InputAttachmentCandidate): string | null {
  return validateInputAttachmentCandidate(candidate, attachmentLimits);
}

function uploaded(
  clientId: string,
  attachment: InputAttachmentSummary,
): DraftInputAttachment {
  return {
    clientId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: null,
    status: "uploaded",
    attachment,
  };
}

describe("input attachment validation", () => {
  it("接受固定契约里的全部格式并显示对应标签", () => {
    for (const mimeType of INPUT_ATTACHMENT_MIME_TYPES) {
      const specification = inputAttachmentFormatSpecifications[mimeType];
      for (const extension of specification.extensions) {
        expect(
          validateCandidate({
            name: `buyers${extension}`,
            type: mimeType,
            size: 12,
          }),
        ).toBeNull();
      }
      expect(inputAttachmentTypeLabel(mimeType)).toBe(specification.label);
    }
  });

  it("接受大小写扩展及浏览器通用 MIME，并拒绝冲突声明", () => {
    expect(
      validateCandidate({
        name: "product.PNG",
        type: "image/png",
        size: 20,
      }),
    ).toBeNull();
    expect(
      validateCandidate({
        name: "buyers.DOCX",
        type: "application/octet-stream",
        size: 20,
      }),
    ).toBeNull();
    expect(
      inputAttachmentMimeTypeForCandidate({
        name: "buyers.DOCX",
        type: "application/octet-stream",
        size: 20,
      }),
    ).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(
      validateCandidate({
        name: "notes.md",
        type: "",
        size: 20,
      }),
    ).toBeNull();
    expect(
      validateCandidate({
        name: "product.png",
        type: "image/jpeg",
        size: 20,
      }),
    ).toBe("附件名称必须使用 .jpg 或 .jpeg 扩展名。");
  });

  it("拒绝错误 MIME、扩展名、空文件和非法名称", () => {
    expect(
      validateCandidate({
        name: "product.svg",
        type: "image/svg+xml",
        size: 20,
      }),
    ).toBe(`仅支持 ${INPUT_ATTACHMENT_SUPPORT_TEXT} 附件。`);
    expect(
      validateCandidate({
        name: "product.png",
        type: "image/png",
        size: 0,
      }),
    ).toBe("附件不能为空。");
    expect(
      validateCandidate({
        name: "folder/product.png",
        type: "image/png",
        size: 20,
      }),
    ).toBe("附件名称不符合要求。");
    expect(
      validateInputAttachmentCandidate(
        { name: "large.png", type: "image/png", size: 101 },
        {
          maxFileBytes: 100,
          maxFilesPerMessage: 2,
          maxTotalBytesPerMessage: 150,
        },
      ),
    ).toBe("单个附件不能超过 100 B。");
  });

  it("为静态 GIF 等所有图片创建发送前缩略图，文件不创建", () => {
    const createPreviewUrl = vi.fn(() => "blob:attachment-preview");

    expect(createInputAttachmentPreviewUrl("image/gif", createPreviewUrl)).toBe(
      "blob:attachment-preview",
    );
    expect(createInputAttachmentPreviewUrl("image/webp", createPreviewUrl)).toBe(
      "blob:attachment-preview",
    );
    expect(createInputAttachmentPreviewUrl("text/plain", createPreviewUrl)).toBeNull();
    expect(createPreviewUrl).toHaveBeenCalledTimes(2);
  });
});

describe("input attachment draft state", () => {
  it("从权威 staged metadata 恢复稳定且唯一的已上传草稿附件", () => {
    const restored = restoreUploadedDraftInputAttachments([
      attachmentA,
      attachmentB,
    ]);

    expect(restored).toEqual([
      {
        clientId: `staged:${attachmentA.id}`,
        name: attachmentA.name,
        mimeType: attachmentA.mimeType,
        sizeBytes: attachmentA.sizeBytes,
        previewUrl: null,
        status: "uploaded",
        attachment: attachmentA,
      },
      {
        clientId: `staged:${attachmentB.id}`,
        name: attachmentB.name,
        mimeType: attachmentB.mimeType,
        sizeBytes: attachmentB.sizeBytes,
        previewUrl: null,
        status: "uploaded",
        attachment: attachmentB,
      },
    ]);
    expect(restoreUploadedDraftInputAttachments([attachmentA])).toEqual([
      restored[0],
    ]);
    expect(new Set(restored.map((attachment) => attachment.clientId)).size).toBe(
      restored.length,
    );
  });

  it("保持用户选择顺序生成 attachmentIds", () => {
    const attachments = [
      uploaded("local-a", attachmentA),
      uploaded("local-b", attachmentB),
    ];
    expect(attachmentIdsForSubmission(attachments, attachmentLimits)).toEqual([
      attachmentA.id,
      attachmentB.id,
    ]);
    expect(canSubmitDraft("", attachments, attachmentLimits)).toBe(true);
  });

  it("上传未完成或失败时禁止发送", () => {
    const file = new File(["buyers"], "buyers.txt", { type: "text/plain" });
    const uploading: DraftInputAttachment = {
      clientId: "local-a",
      file,
      name: "buyers.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      previewUrl: null,
      status: "uploading",
    };
    expect(
      canSubmitDraft("研究这些客户", [uploading], attachmentLimits),
    ).toBe(false);
    expect(() =>
      attachmentIdsForSubmission([uploading], attachmentLimits),
    ).toThrow(
      "所有附件必须上传完成后才能发送",
    );
  });

  it("上传失败时保留原始文件与图片缩略图供原位重试", () => {
    const file = new File(["gif"], "product.gif", { type: "image/gif" });
    const uploading: Extract<
      DraftInputAttachment,
      { status: "uploading" }
    > = {
      clientId: "local-gif",
      file,
      name: "product.gif",
      mimeType: "image/gif",
      sizeBytes: 24,
      previewUrl: "blob:gif-preview",
      status: "uploading",
    };

    const failed = failedDraftInputAttachment(uploading, "上传失败");
    expect(failed).toEqual({
      ...uploading,
      status: "failed",
      error: "上传失败",
    });
    expect(failed.file).toBe(file);
    expect(failed.previewUrl).toBe("blob:gif-preview");
  });

  it("用同一卡片和 clientId 重试，并拒绝上传中的重复激活", () => {
    const file = new File(["gif"], "product.gif", { type: "image/gif" });
    const failed = failedDraftInputAttachment(
      {
        clientId: "local-gif",
        file,
        name: "product.gif",
        mimeType: "image/gif",
        sizeBytes: file.size,
        previewUrl: "blob:gif-preview",
        status: "uploading",
      },
      "首次上传失败",
    );

    const retry = retryDraftInputAttachment([failed], failed.clientId);
    expect(retry.retryAttachment).toEqual({
      clientId: failed.clientId,
      file,
      name: failed.name,
      mimeType: failed.mimeType,
      sizeBytes: failed.sizeBytes,
      previewUrl: failed.previewUrl,
      status: "uploading",
    });
    expect(retry.attachments).toEqual([retry.retryAttachment]);
    expect(retry.retryAttachment?.clientId).toBe(failed.clientId);
    expect(retry.retryAttachment?.file).toBe(file);

    const duplicateRetry = retryDraftInputAttachment(
      retry.attachments,
      failed.clientId,
    );
    expect(duplicateRetry.retryAttachment).toBeNull();
    expect(duplicateRetry.attachments).toBe(retry.attachments);

    if (retry.retryAttachment === null) {
      throw new Error("Expected the failed attachment to enter uploading");
    }
    const failedAgain = failedDraftInputAttachment(
      retry.retryAttachment,
      "再次上传失败",
    );
    const secondRetry = retryDraftInputAttachment(
      [failedAgain],
      failedAgain.clientId,
    );
    expect(secondRetry.retryAttachment?.file).toBe(file);
    expect(secondRetry.retryAttachment?.previewUrl).toBe("blob:gif-preview");
  });

  it("移除或清空本地附件时中断上传并释放仍保留的预览 URL", () => {
    const abortUpload = vi.fn();
    const revokePreviewUrl = vi.fn();
    const file = new File(["gif"], "product.gif", { type: "image/gif" });
    const uploading: Extract<
      DraftInputAttachment,
      { status: "uploading" }
    > = {
      clientId: "local-uploading",
      file,
      name: file.name,
      mimeType: "image/gif",
      sizeBytes: file.size,
      previewUrl: "blob:uploading-preview",
      status: "uploading",
    };
    const failed = failedDraftInputAttachment(
      {
        ...uploading,
        clientId: "local-failed",
        previewUrl: "blob:failed-preview",
      },
      "上传失败",
    );

    releaseDraftInputAttachmentResources(
      uploading,
      abortUpload,
      revokePreviewUrl,
    );
    releaseDraftInputAttachmentResources(
      failed,
      abortUpload,
      revokePreviewUrl,
    );
    releaseDraftInputAttachmentResources(
      restoreUploadedDraftInputAttachments([attachmentB])[0],
      abortUpload,
      revokePreviewUrl,
    );

    expect(abortUpload).toHaveBeenCalledOnce();
    expect(abortUpload).toHaveBeenCalledWith(uploading.clientId);
    expect(revokePreviewUrl.mock.calls).toEqual([
      ["blob:uploading-preview"],
      ["blob:failed-preview"],
    ]);
  });

  it("纯文字可发送，空文字和空附件不可发送", () => {
    expect(canSubmitDraft("  找客户  ", [], attachmentLimits)).toBe(true);
    expect(canSubmitDraft("   ", [], attachmentLimits)).toBe(false);
  });

  it("严格按 bootstrap 限制校验数量、单文件和总大小", () => {
    const limits: InputAttachmentLimits = {
      maxFileBytes: 100,
      maxFilesPerMessage: 2,
      maxTotalBytesPerMessage: 150,
    };
    const first = { name: "first.txt", sizeBytes: 80 };
    const second = { name: "second.txt", sizeBytes: 70 };

    expect(draftInputAttachmentTotalBytes([first, second])).toBe(150);
    expect(validateDraftInputAttachmentLimits([first, second], limits)).toBeNull();
    expect(canAddInputAttachment([first], limits)).toBe(true);
    expect(canAddInputAttachment([first, second], limits)).toBe(false);
    expect(
      validateDraftInputAttachmentLimits(
        [...[first, second], { name: "third.txt", sizeBytes: 1 }],
        limits,
      ),
    ).toBe("每条消息最多添加 2 个附件。");
    expect(
      validateDraftInputAttachmentLimits(
        [{ name: "large.txt", sizeBytes: 101 }],
        limits,
      ),
    ).toBe("large.txt：单个附件不能超过 100 B。");
    expect(
      validateDraftInputAttachmentLimits(
        [first, { name: "second.txt", sizeBytes: 71 }],
        limits,
      ),
    ).toBe("每条消息的附件总大小不能超过 150 B。");
  });

  it("按 clientId 原位替换和移除，不改变其他附件顺序", () => {
    const file = new File(["buyers"], "buyers.txt", { type: "text/plain" });
    const first: DraftInputAttachment = {
      clientId: "local-a",
      file,
      name: "buyers.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      previewUrl: null,
      status: "uploading",
    };
    const second = uploaded("local-b", attachmentB);
    const completedFirst = uploaded("local-a", attachmentA);
    const replaced = replaceDraftInputAttachment(
      [first, second],
      first.clientId,
      completedFirst,
    );
    expect(replaced).toEqual([completedFirst, second]);
    expect(removeDraftInputAttachment(replaced, second.clientId)).toEqual([
      completedFirst,
    ]);
  });

  it("格式化契约里的字节数", () => {
    expect(formatAttachmentBytes(12)).toBe("12 B");
    expect(formatAttachmentBytes(2048)).toBe("2.0 KB");
    expect(formatAttachmentBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
