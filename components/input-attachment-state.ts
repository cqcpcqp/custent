import type {
  InputAttachmentLimits,
  InputAttachmentMimeType,
  InputAttachmentSummary,
} from "@/lib/contracts";
import {
  inputAttachmentFormatSpecifications,
  inputAttachmentMimeTypeForUpload,
  INPUT_ATTACHMENT_SUPPORT_TEXT,
  isInputAttachmentImageMimeType,
} from "@/lib/input-attachment-formats";

type DraftInputAttachmentBase = {
  clientId: string;
  name: string;
  mimeType: InputAttachmentMimeType;
  sizeBytes: number;
  previewUrl: string | null;
};

type LocalDraftInputAttachmentBase = DraftInputAttachmentBase & {
  file: File;
};

export type DraftInputAttachment =
  | (LocalDraftInputAttachmentBase & { status: "uploading" })
  | (DraftInputAttachmentBase & {
      status: "uploaded";
      attachment: InputAttachmentSummary;
    })
  | (DraftInputAttachmentBase & {
      status: "deleting";
      attachment: InputAttachmentSummary;
    })
  | (LocalDraftInputAttachmentBase & {
      status: "failed";
      error: string;
    });

export type InputAttachmentCandidate = {
  name: string;
  type: string;
  size: number;
};

export function restoreUploadedDraftInputAttachments(
  attachments: readonly InputAttachmentSummary[],
): Array<Extract<DraftInputAttachment, { status: "uploaded" }>> {
  return attachments.map((attachment) => ({
    clientId: `staged:${attachment.id}`,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    previewUrl: null,
    status: "uploaded",
    attachment,
  }));
}

export function createInputAttachmentPreviewUrl(
  mimeType: InputAttachmentMimeType,
  createPreviewUrl: () => string,
): string | null {
  return isInputAttachmentImageMimeType(mimeType) ? createPreviewUrl() : null;
}

export function failedDraftInputAttachment(
  attachment: Extract<DraftInputAttachment, { status: "uploading" }>,
  error: string,
): Extract<DraftInputAttachment, { status: "failed" }> {
  return {
    ...attachment,
    status: "failed",
    error,
  };
}

export function releaseDraftInputAttachmentResources(
  attachment: DraftInputAttachment,
  abortUpload: (clientId: string) => void,
  revokePreviewUrl: (previewUrl: string) => void,
): void {
  if (attachment.status === "uploading") {
    abortUpload(attachment.clientId);
  }
  if (attachment.previewUrl !== null) {
    revokePreviewUrl(attachment.previewUrl);
  }
}

export function validateInputAttachmentCandidate(
  candidate: InputAttachmentCandidate,
  limits: InputAttachmentLimits,
): string | null {
  if (
    candidate.name.length === 0 ||
    candidate.name.length > 255 ||
    candidate.name === "." ||
    candidate.name === ".." ||
    /[\\/\u0000-\u001f\u007f]/u.test(candidate.name)
  ) {
    return "附件名称不符合要求。";
  }

  const mimeType = inputAttachmentMimeTypeForUpload(
    candidate.type,
    candidate.name,
  );
  if (mimeType === null) {
    return `仅支持 ${INPUT_ATTACHMENT_SUPPORT_TEXT} 附件。`;
  }
  const expectedExtensions =
    inputAttachmentFormatSpecifications[mimeType].extensions;
  const lastDot = candidate.name.lastIndexOf(".");
  const actualExtension =
    lastDot < 0 ? "" : candidate.name.slice(lastDot).toLowerCase();
  if (
    !expectedExtensions.some((extension) => extension === actualExtension) ||
    expectedExtensions.some(
      (extension) => candidate.name.toLowerCase() === extension,
    )
  ) {
    return `附件名称必须使用 ${expectedExtensions.join(" 或 ")} 扩展名。`;
  }

  if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0) {
    return "附件不能为空。";
  }
  if (candidate.size > limits.maxFileBytes) {
    return `单个附件不能超过 ${formatAttachmentBytes(limits.maxFileBytes)}。`;
  }
  return null;
}

export function inputAttachmentMimeTypeForCandidate(
  candidate: InputAttachmentCandidate,
): InputAttachmentMimeType {
  const mimeType = inputAttachmentMimeTypeForUpload(
    candidate.type,
    candidate.name,
  );
  if (mimeType === null) {
    throw new TypeError("Input attachment candidate has no supported MIME type");
  }
  return mimeType;
}

export function replaceDraftInputAttachment(
  attachments: DraftInputAttachment[],
  clientId: string,
  replacement: DraftInputAttachment,
): DraftInputAttachment[] {
  return attachments.map((attachment) =>
    attachment.clientId === clientId ? replacement : attachment,
  );
}

export function retryDraftInputAttachment(
  attachments: DraftInputAttachment[],
  clientId: string,
): {
  attachments: DraftInputAttachment[];
  retryAttachment: Extract<
    DraftInputAttachment,
    { status: "uploading" }
  > | null;
} {
  const failedAttachment = attachments.find(
    (attachment) =>
      attachment.clientId === clientId && attachment.status === "failed",
  );
  if (failedAttachment === undefined || failedAttachment.status !== "failed") {
    return { attachments, retryAttachment: null };
  }

  const retryAttachment: Extract<
    DraftInputAttachment,
    { status: "uploading" }
  > = {
    clientId: failedAttachment.clientId,
    file: failedAttachment.file,
    name: failedAttachment.name,
    mimeType: failedAttachment.mimeType,
    sizeBytes: failedAttachment.sizeBytes,
    previewUrl: failedAttachment.previewUrl,
    status: "uploading",
  };
  return {
    attachments: replaceDraftInputAttachment(
      attachments,
      clientId,
      retryAttachment,
    ),
    retryAttachment,
  };
}

export function removeDraftInputAttachment(
  attachments: DraftInputAttachment[],
  clientId: string,
): DraftInputAttachment[] {
  return attachments.filter((attachment) => attachment.clientId !== clientId);
}

export function attachmentIdsForSubmission(
  attachments: DraftInputAttachment[],
  limits: InputAttachmentLimits,
): string[] {
  const limitError = validateDraftInputAttachmentLimits(attachments, limits);
  if (limitError !== null) {
    throw new Error(limitError);
  }
  const attachmentIds: string[] = [];
  for (const attachment of attachments) {
    if (attachment.status !== "uploaded") {
      throw new Error("所有附件必须上传完成后才能发送");
    }
    attachmentIds.push(attachment.attachment.id);
  }
  return attachmentIds;
}

export function canSubmitDraft(
  message: string,
  attachments: DraftInputAttachment[],
  limits: InputAttachmentLimits,
): boolean {
  if (attachments.some((attachment) => attachment.status !== "uploaded")) {
    return false;
  }
  if (validateDraftInputAttachmentLimits(attachments, limits) !== null) {
    return false;
  }
  return message.trim().length > 0 || attachments.length > 0;
}

export function draftInputAttachmentTotalBytes(
  attachments: readonly Pick<DraftInputAttachmentBase, "sizeBytes">[],
): number {
  return attachments.reduce(
    (totalBytes, attachment) => totalBytes + attachment.sizeBytes,
    0,
  );
}

export function validateDraftInputAttachmentLimits(
  attachments: readonly Pick<
    DraftInputAttachmentBase,
    "name" | "sizeBytes"
  >[],
  limits: InputAttachmentLimits,
): string | null {
  if (attachments.length > limits.maxFilesPerMessage) {
    return `每条消息最多添加 ${limits.maxFilesPerMessage} 个附件。`;
  }
  const oversizedAttachment = attachments.find(
    (attachment) => attachment.sizeBytes > limits.maxFileBytes,
  );
  if (oversizedAttachment !== undefined) {
    return `${oversizedAttachment.name}：单个附件不能超过 ${formatAttachmentBytes(
      limits.maxFileBytes,
    )}。`;
  }
  if (
    draftInputAttachmentTotalBytes(attachments) >
    limits.maxTotalBytesPerMessage
  ) {
    return `每条消息的附件总大小不能超过 ${formatAttachmentBytes(
      limits.maxTotalBytesPerMessage,
    )}。`;
  }
  return null;
}

export function canAddInputAttachment(
  attachments: readonly Pick<DraftInputAttachmentBase, "sizeBytes">[],
  limits: InputAttachmentLimits,
): boolean {
  return (
    attachments.length < limits.maxFilesPerMessage &&
    draftInputAttachmentTotalBytes(attachments) <
      limits.maxTotalBytesPerMessage
  );
}

export function formatAttachmentBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function inputAttachmentTypeLabel(
  mimeType: InputAttachmentMimeType,
): string {
  return inputAttachmentFormatSpecifications[mimeType].label;
}
