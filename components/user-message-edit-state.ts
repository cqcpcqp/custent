import type { DraftInputAttachment } from "@/components/input-attachment-state";

export type UserMessageEditState = {
  conversationId: string;
  messageId: string;
  value: string;
  retainedAttachmentIds: string[];
  newAttachments: DraftInputAttachment[];
  attachmentError: string | null;
  isSaving: boolean;
  error: string | null;
};

export type UserMessageEditStateMap = Record<string, UserMessageEditState>;

export function userMessageEditAttachmentIds(
  edit: UserMessageEditState,
): string[] {
  const attachmentIds = [...edit.retainedAttachmentIds];
  for (const attachment of edit.newAttachments) {
    if (attachment.status !== "uploaded") {
      throw new Error("所有新增附件必须上传完成后才能保存编辑");
    }
    attachmentIds.push(attachment.attachment.id);
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error("编辑消息的附件 ID 不能重复");
  }
  return attachmentIds;
}

export function userMessageEditHasPendingAttachments(
  edit: Pick<UserMessageEditState, "newAttachments">,
): boolean {
  return edit.newAttachments.some(
    (attachment) => attachment.status !== "uploaded",
  );
}

export function updateUserMessageEditState(
  states: UserMessageEditStateMap,
  conversationId: string,
  update: (
    current: UserMessageEditState | null,
  ) => UserMessageEditState | null,
): UserMessageEditStateMap {
  const current = states[conversationId] ?? null;
  const nextEdit = update(current);
  if (nextEdit === current) {
    return states;
  }
  if (nextEdit === null) {
    if (!Object.hasOwn(states, conversationId)) {
      return states;
    }
    const next = { ...states };
    delete next[conversationId];
    return next;
  }
  if (nextEdit.conversationId !== conversationId) {
    throw new Error("消息编辑状态的 conversationId 与索引不一致");
  }
  return { ...states, [conversationId]: nextEdit };
}
