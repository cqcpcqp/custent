import { createHash } from "node:crypto";

import type { AgentInputItem } from "@openai/agents";

import {
  formatAttachmentReference,
  type LoadedAttachment,
} from "@/lib/agent/attachment-session";
import type {
  InputAttachmentRecord,
  MessageInputAttachmentRecord,
} from "@/lib/input-attachments";
import {
  isInputAttachmentFileMimeType,
  isInputAttachmentImageMimeType,
} from "@/lib/input-attachment-formats";

type UserMessageItem = Extract<AgentInputItem, { role: "user" }>;
type UserMessageContent = Exclude<UserMessageItem["content"], string>[number];

export type CurrentUserInput = [UserMessageItem];

function attachmentContent(
  attachment: InputAttachmentRecord,
): UserMessageContent {
  const reference = formatAttachmentReference(attachment.id);
  switch (attachment.kind) {
    case "file":
      if (!isInputAttachmentFileMimeType(attachment.mimeType)) {
        throw new TypeError(
          `Input attachment ${attachment.id} has an inconsistent file MIME type`,
        );
      }
      return {
        type: "input_file",
        file: reference,
        filename: attachment.originalName,
      };
    case "image":
      if (!isInputAttachmentImageMimeType(attachment.mimeType)) {
        throw new TypeError(
          `Input attachment ${attachment.id} has an inconsistent image MIME type`,
        );
      }
      return {
        type: "input_image",
        image: reference,
        detail: "auto",
      };
  }
}

export function createCurrentUserInput(input: {
  messageId: string;
  text: string;
  attachmentIds: readonly string[];
  attachments: readonly MessageInputAttachmentRecord[];
}): CurrentUserInput {
  if (input.attachmentIds.length !== input.attachments.length) {
    throw new TypeError("Claimed input attachment count is inconsistent");
  }

  const content: UserMessageContent[] = [];
  if (input.text.length > 0) {
    content.push({ type: "input_text", text: input.text });
  }
  for (const [position, attachment] of input.attachments.entries()) {
    if (attachment.id !== input.attachmentIds[position]) {
      throw new TypeError(
        `Claimed input attachment order is inconsistent at position ${position}`,
      );
    }
    if (
      attachment.messageId !== input.messageId ||
      attachment.position !== position
    ) {
      throw new TypeError(
        `Input attachment ${attachment.id} is not bound to the claimed message position`,
      );
    }
    content.push(attachmentContent(attachment));
  }

  if (content.length === 0) {
    throw new TypeError("Claimed run input has neither text nor attachments");
  }
  return [{ role: "user", content }];
}

export function verifyLoadedInputAttachment(
  attachment: InputAttachmentRecord,
  bytes: Uint8Array,
): LoadedAttachment {
  if (!Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes <= 0) {
    throw new TypeError(
      `Input attachment ${attachment.id} has an invalid stored size`,
    );
  }
  if (bytes.byteLength !== attachment.sizeBytes) {
    throw new Error(
      `Input attachment ${attachment.id} stored byte length does not match its record`,
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(attachment.sha256)) {
    throw new TypeError(
      `Input attachment ${attachment.id} has an invalid stored SHA-256`,
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== attachment.sha256) {
    throw new Error(
      `Input attachment ${attachment.id} stored SHA-256 does not match its record`,
    );
  }

  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.originalName,
    mimeType: attachment.mimeType,
    bytes,
  };
}
