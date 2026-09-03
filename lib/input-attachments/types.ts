import type {
  InputAttachmentKind,
  InputAttachmentMimeType,
} from "@/lib/contracts";

export type StoredInputAttachment = {
  id: string;
  kind: InputAttachmentKind;
  originalName: string;
  mimeType: InputAttachmentMimeType;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
};

export type InputAttachmentRecord = StoredInputAttachment & {
  userId: string;
  createdAt: string;
  attachedAt: string | null;
  expiresAt: string | null;
};

export type MessageInputAttachmentRecord = InputAttachmentRecord & {
  messageId: string;
  position: number;
};

export type InputAttachmentContentRecord = StoredInputAttachment & {
  userId: string;
};

export type InputAttachmentDeletionJob = {
  attachmentId: string;
  userId: string;
  storagePath: string;
  deletedAt: string;
  completedAt: string | null;
  attemptCount: number;
};
