import { describe, expect, it } from "vitest";

import {
  userMessageEditAttachmentIds,
  userMessageEditHasPendingAttachments,
  updateUserMessageEditState,
  type UserMessageEditState,
} from "@/components/user-message-edit-state";
import type { DraftInputAttachment } from "@/components/input-attachment-state";

function edit(
  conversationId: string,
  messageId: string,
  value: string,
): UserMessageEditState {
  return {
    conversationId,
    messageId,
    value,
    retainedAttachmentIds: [],
    newAttachments: [],
    attachmentError: null,
    isSaving: false,
    error: null,
  };
}

function uploadedAttachment(
  clientId: string,
  attachmentId: string,
): Extract<DraftInputAttachment, { status: "uploaded" }> {
  return {
    clientId,
    name: "new-catalog.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    previewUrl: null,
    status: "uploaded",
    attachment: {
      id: attachmentId,
      kind: "file",
      name: "new-catalog.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      downloadUrl: `/api/input-attachments/${attachmentId}/content`,
      createdAt: "2026-08-27T08:00:00.000Z",
    },
  };
}

describe("user message edit state", () => {
  it("preserves independent unsaved edits while conversations switch", () => {
    let states = updateUserMessageEditState({}, "conversation-a", () =>
      edit("conversation-a", "message-a", "A 的未保存修改"),
    );
    states = updateUserMessageEditState(states, "conversation-b", () =>
      edit("conversation-b", "message-b", "B 的未保存修改"),
    );

    expect(states["conversation-a"].value).toBe("A 的未保存修改");
    expect(states["conversation-b"].value).toBe("B 的未保存修改");
  });

  it("updates and clears only the targeted conversation", () => {
    const initial = {
      "conversation-a": edit("conversation-a", "message-a", "A"),
      "conversation-b": edit("conversation-b", "message-b", "B"),
    };
    const changed = updateUserMessageEditState(
      initial,
      "conversation-a",
      (current) =>
        current === null ? current : { ...current, value: "A changed" },
    );
    const cleared = updateUserMessageEditState(
      changed,
      "conversation-a",
      () => null,
    );

    expect(changed["conversation-a"].value).toBe("A changed");
    expect(changed["conversation-b"]).toBe(initial["conversation-b"]);
    expect(cleared).toEqual({
      "conversation-b": initial["conversation-b"],
    });
  });

  it("rejects an edit stored under the wrong conversation key", () => {
    expect(() =>
      updateUserMessageEditState({}, "conversation-a", () =>
        edit("conversation-b", "message-b", "wrong"),
      ),
    ).toThrow("conversationId 与索引不一致");
  });

  it("orders retained attachments before newly uploaded attachments", () => {
    const state = edit("conversation-a", "message-a", "changed");
    state.retainedAttachmentIds = ["retained-1", "retained-2"];
    state.newAttachments = [uploadedAttachment("client-1", "uploaded-1")];

    expect(userMessageEditAttachmentIds(state)).toEqual([
      "retained-1",
      "retained-2",
      "uploaded-1",
    ]);
    expect(userMessageEditHasPendingAttachments(state)).toBe(false);
  });

  it("rejects submission while a new attachment is not uploaded", () => {
    const state = edit("conversation-a", "message-a", "changed");
    state.newAttachments = [
      {
        ...uploadedAttachment("client-1", "uploaded-1"),
        status: "deleting",
      },
    ];

    expect(userMessageEditHasPendingAttachments(state)).toBe(true);
    expect(() => userMessageEditAttachmentIds(state)).toThrow(
      "所有新增附件必须上传完成",
    );
  });
});
