import type { AgentInputItem } from "@openai/agents";

import {
  InputAttachmentMimeTypeSchema,
  type InputAttachmentKind,
  type InputAttachmentMimeType,
} from "@/lib/contracts";
import {
  isInputAttachmentFileMimeType,
  isInputAttachmentImageMimeType,
} from "@/lib/input-attachment-formats";

const ATTACHMENT_REFERENCE_PREFIX = "custent-attachment:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type UserMessageItem = Extract<AgentInputItem, { role: "user" }>;
type UserContentItem = Exclude<UserMessageItem["content"], string>[number];
type InputFileContent = Extract<UserContentItem, { type: "input_file" }>;
type InputImageContent = Extract<UserContentItem, { type: "input_image" }>;

export type LoadedAttachment = {
  id: string;
  kind: InputAttachmentKind;
  name: string;
  mimeType: InputAttachmentMimeType;
  bytes: Uint8Array;
};

export type AttachmentLoader = (
  id: string,
) =>
  | LoadedAttachment
  | null
  | undefined
  | Promise<LoadedAttachment | null | undefined>;

type FileDehydrationEntry = {
  kind: "file";
  reference: string;
  dataUrl: string;
  hydratedFilename: string;
  persistedFilename: string | undefined;
};

type ImageDehydrationEntry = {
  kind: "image";
  reference: string;
  dataUrl: string;
  detail: string | undefined;
};

type AttachmentDehydrationEntry =
  | FileDehydrationEntry
  | ImageDehydrationEntry;

export type AttachmentDehydrationPlan = {
  entries: readonly AttachmentDehydrationEntry[];
};

export type HydratedAttachmentReferences = {
  items: AgentInputItem[];
  plan: AttachmentDehydrationPlan;
};

export type HydratedAttachmentRunInput = {
  initialItems: AgentInputItem[];
  currentInput: AgentInputItem[];
  plan: AttachmentDehydrationPlan;
};

export function formatAttachmentReference(id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw new TypeError(`Invalid attachment UUID: ${id}`);
  }
  return `${ATTACHMENT_REFERENCE_PREFIX}${id}`;
}

export function parseAttachmentReference(reference: string): string {
  if (!reference.startsWith(ATTACHMENT_REFERENCE_PREFIX)) {
    throw new TypeError(`Invalid attachment reference: ${reference}`);
  }
  const id = reference.slice(ATTACHMENT_REFERENCE_PREFIX.length);
  if (!UUID_PATTERN.test(id)) {
    throw new TypeError(`Invalid attachment reference: ${reference}`);
  }
  return id;
}

function isUserMessageItem(item: AgentInputItem): item is UserMessageItem {
  return "role" in item && item.role === "user";
}

function attachmentIdFromReference(
  value: InputFileContent["file"] | InputImageContent["image"],
  contentType: "input_file" | "input_image",
): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `${contentType} must contain a Custent attachment reference string`,
    );
  }
  return parseAttachmentReference(value);
}

function assertLoadedAttachment(
  value: LoadedAttachment | null | undefined,
  requestedId: string,
): LoadedAttachment {
  if (value === null || value === undefined) {
    throw new Error(`Attachment loader returned no attachment for ${requestedId}`);
  }
  if (value.id !== requestedId) {
    throw new Error(
      `Attachment loader returned ${value.id} for requested attachment ${requestedId}`,
    );
  }
  if (!UUID_PATTERN.test(value.id)) {
    throw new TypeError(`Attachment loader returned an invalid UUID: ${value.id}`);
  }
  if (value.kind !== "file" && value.kind !== "image") {
    throw new TypeError(`Attachment ${requestedId} returned an invalid kind`);
  }
  if (!InputAttachmentMimeTypeSchema.safeParse(value.mimeType).success) {
    throw new TypeError(`Attachment ${requestedId} returned an invalid MIME type`);
  }
  if (value.name.length === 0) {
    throw new TypeError(`Attachment ${requestedId} returned an empty name`);
  }
  if (!(value.bytes instanceof Uint8Array)) {
    throw new TypeError(`Attachment ${requestedId} returned invalid bytes`);
  }
  return value;
}

function dataUrl(attachment: LoadedAttachment): string {
  return `data:${attachment.mimeType};base64,${Buffer.from(attachment.bytes).toString("base64")}`;
}

function assertFileAttachment(
  attachment: LoadedAttachment,
  attachmentId: string,
): void {
  if (attachment.kind !== "file") {
    throw new Error(
      `Attachment ${attachmentId} kind ${attachment.kind} does not match input_file`,
    );
  }
  if (!isInputAttachmentFileMimeType(attachment.mimeType)) {
    throw new Error(
      `Attachment ${attachmentId} MIME type ${attachment.mimeType} does not match input_file`,
    );
  }
}

function assertImageAttachment(
  attachment: LoadedAttachment,
  attachmentId: string,
): void {
  if (attachment.kind !== "image") {
    throw new Error(
      `Attachment ${attachmentId} kind ${attachment.kind} does not match input_image`,
    );
  }
  if (!isInputAttachmentImageMimeType(attachment.mimeType)) {
    throw new Error(
      `Attachment ${attachmentId} MIME type ${attachment.mimeType} does not match input_image`,
    );
  }
}

export async function hydrateAttachmentReferences(
  items: readonly AgentInputItem[],
  loader: AttachmentLoader,
): Promise<HydratedAttachmentReferences> {
  const hydratedItems = structuredClone(items) as AgentInputItem[];
  const entries: AttachmentDehydrationEntry[] = [];
  const loadedById = new Map<string, Promise<LoadedAttachment>>();

  const load = (id: string): Promise<LoadedAttachment> => {
    const existing = loadedById.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const pending = Promise.resolve(loader(id)).then((attachment) =>
      assertLoadedAttachment(attachment, id),
    );
    loadedById.set(id, pending);
    return pending;
  };

  for (const item of hydratedItems) {
    if (!isUserMessageItem(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      switch (content.type) {
        case "input_file": {
          const attachmentId = attachmentIdFromReference(
            content.file,
            content.type,
          );
          const attachment = await load(attachmentId);
          assertFileAttachment(attachment, attachmentId);
          const reference = formatAttachmentReference(attachmentId);
          const inlineData = dataUrl(attachment);
          entries.push({
            kind: "file",
            reference,
            dataUrl: inlineData,
            hydratedFilename: attachment.name,
            persistedFilename: content.filename,
          });
          content.file = inlineData;
          content.filename = attachment.name;
          break;
        }
        case "input_image": {
          const attachmentId = attachmentIdFromReference(
            content.image,
            content.type,
          );
          const attachment = await load(attachmentId);
          assertImageAttachment(attachment, attachmentId);
          const reference = formatAttachmentReference(attachmentId);
          const inlineData = dataUrl(attachment);
          entries.push({
            kind: "image",
            reference,
            dataUrl: inlineData,
            detail: content.detail,
          });
          content.image = inlineData;
          break;
        }
      }
    }
  }

  return { items: hydratedItems, plan: { entries } };
}

function nextFileEntry(
  plan: AttachmentDehydrationPlan,
  consumed: Set<number>,
  content: InputFileContent,
): [number, FileDehydrationEntry] | undefined {
  for (const [index, entry] of plan.entries.entries()) {
    if (
      !consumed.has(index) &&
      entry.kind === "file" &&
      entry.dataUrl === content.file &&
      entry.hydratedFilename === content.filename
    ) {
      return [index, entry];
    }
  }
  return undefined;
}

function nextImageEntry(
  plan: AttachmentDehydrationPlan,
  consumed: Set<number>,
  content: InputImageContent,
): [number, ImageDehydrationEntry] | undefined {
  for (const [index, entry] of plan.entries.entries()) {
    if (
      !consumed.has(index) &&
      entry.kind === "image" &&
      entry.dataUrl === content.image &&
      entry.detail === content.detail
    ) {
      return [index, entry];
    }
  }
  return undefined;
}

function assertNoInlineAttachmentData(items: readonly AgentInputItem[]): void {
  for (const item of items) {
    if (!isUserMessageItem(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (
        content.type === "input_file" &&
        typeof content.file === "string" &&
        content.file.startsWith("data:")
      ) {
        throw new Error("Dehydrated Session still contains input_file data");
      }
      if (
        content.type === "input_image" &&
        typeof content.image === "string" &&
        content.image.startsWith("data:")
      ) {
        throw new Error("Dehydrated Session still contains input_image data");
      }
    }
  }
}

export function dehydrateAttachmentData(
  items: readonly AgentInputItem[],
  plan: AttachmentDehydrationPlan,
): AgentInputItem[] {
  const dehydratedItems = structuredClone(items) as AgentInputItem[];
  const consumed = new Set<number>();

  for (const item of dehydratedItems) {
    if (!isUserMessageItem(item) || !Array.isArray(item.content)) {
      continue;
    }
    for (const content of item.content) {
      if (
        content.type === "input_file" &&
        typeof content.file === "string" &&
        content.file.startsWith("data:")
      ) {
        const match = nextFileEntry(plan, consumed, content);
        if (match === undefined) {
          throw new Error("Refusing to persist unknown inline input_file data");
        }
        const [index, entry] = match;
        consumed.add(index);
        content.file = entry.reference;
        if (entry.persistedFilename === undefined) {
          delete content.filename;
        } else {
          content.filename = entry.persistedFilename;
        }
      }
      if (
        content.type === "input_image" &&
        typeof content.image === "string" &&
        content.image.startsWith("data:")
      ) {
        const match = nextImageEntry(plan, consumed, content);
        if (match === undefined) {
          throw new Error("Refusing to persist unknown inline input_image data");
        }
        const [index, entry] = match;
        consumed.add(index);
        content.image = entry.reference;
      }
    }
  }

  if (consumed.size !== plan.entries.length) {
    throw new Error(
      `Dehydrated Session consumed ${consumed.size} of ${plan.entries.length} hydrated attachment references`,
    );
  }
  assertNoInlineAttachmentData(dehydratedItems);
  return dehydratedItems;
}

export async function hydrateAttachmentRunInput(
  persistedItems: readonly AgentInputItem[],
  currentUserItem: UserMessageItem,
  loader: AttachmentLoader,
): Promise<HydratedAttachmentRunInput> {
  const hydrated = await hydrateAttachmentReferences(
    [...persistedItems, currentUserItem],
    loader,
  );
  const initialItems = hydrated.items.slice(0, persistedItems.length);
  const currentInput = hydrated.items.slice(persistedItems.length);
  return { initialItems, currentInput, plan: hydrated.plan };
}
