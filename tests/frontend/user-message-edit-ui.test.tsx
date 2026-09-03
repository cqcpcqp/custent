import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageView } from "@/components/research-message";
import type { DraftInputAttachment } from "@/components/input-attachment-state";
import type {
  ChatMessage,
  InputAttachmentLimits,
  InputAttachmentSummary,
} from "@/lib/contracts";

const inputAttachmentLimits: InputAttachmentLimits = {
  maxFilesPerMessage: 5,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytesPerMessage: 20 * 1024 * 1024,
};

const userMessage: ChatMessage = {
  id: "40000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  role: "user",
  content: "寻找德国阀门买家",
  citations: [],
  artifacts: [],
  attachments: [
    {
      id: "60000000-0000-4000-8000-000000000001",
      kind: "file",
      name: "catalog.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      downloadUrl: "/api/input-attachments/attachment-1/content",
      createdAt: "2026-08-26T08:00:00.000Z",
    },
  ],
  feedback: null,
  createdAt: "2026-08-26T08:00:00.000Z",
};

function renderUserEdit(input: {
  canEdit: boolean;
  isEditing: boolean;
  value?: string;
  isSaving?: boolean;
  error?: string | null;
  disabledReason?: string | null;
  retainedAttachments?: InputAttachmentSummary[];
  newAttachments?: DraftInputAttachment[];
  attachmentError?: string | null;
}): string {
  return renderToStaticMarkup(
    <MessageView
      events={[]}
      isFeedbackPending={false}
      message={userMessage}
      onFeedback={() => undefined}
      onOpenActivity={() => undefined}
      run={null}
      userEdit={{
        canEdit: input.canEdit,
        disabledReason: input.disabledReason ?? null,
        isEditing: input.isEditing,
        value: input.value ?? userMessage.content,
        retainedAttachments:
          input.retainedAttachments ?? userMessage.attachments,
        newAttachments: input.newAttachments ?? [],
        attachmentError: input.attachmentError ?? null,
        inputAttachmentLimits,
        isSaving: input.isSaving ?? false,
        error: input.error ?? null,
        onBegin: () => undefined,
        onChange: () => undefined,
        onFilesSelected: () => undefined,
        onRemoveRetainedAttachment: () => undefined,
        onRemoveNewAttachment: () => undefined,
        onRetryNewAttachment: () => undefined,
        onDismissAttachmentError: () => undefined,
        onCancel: () => undefined,
        onSave: () => undefined,
      }}
    />,
  );
}

describe("user message editing UI", () => {
  it("offers an accessible edit action on the selected path", () => {
    const markup = renderUserEdit({ canEdit: true, isEditing: false });

    expect(markup).toContain('aria-label="编辑这条消息"');
    expect(markup).toContain('title="编辑消息并创建新分支"');
    expect(markup).toMatch(
      /class="message-actions"[\s\S]*aria-label="复制消息"[\s\S]*aria-label="编辑这条消息"/u,
    );
    expect(markup).not.toContain("message-actions--persistent");
    expect(markup).not.toContain("user-message-editor");
    expect(markup).not.toContain("<time");
  });

  it("renders an inline editor with removable existing attachments and file input", () => {
    const markup = renderUserEdit({
      canEdit: true,
      isEditing: true,
      value: "寻找法国阀门买家",
    });

    expect(markup).toContain('class="user-message-editor"');
    expect(markup).toContain("寻找法国阀门买家");
    expect(markup).toContain("原消息附件");
    expect(markup).toContain("移除已有附件：catalog.pdf");
    expect(markup).toContain("添加附件");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("保存并提交");
    expect(markup).toContain("取消");
  });

  it("allows an attachment-only change and announces attachment failures", () => {
    const markup = renderUserEdit({
      canEdit: true,
      isEditing: true,
      retainedAttachments: [],
      attachmentError: "附件删除失败",
    });

    expect(markup).toContain("编辑后的消息不会包含附件");
    expect(markup).toContain("附件删除失败");
    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/<button type="submit">保存并提交<\/button>/);
  });

  it("disables editing and explains active/waiting run conflicts", () => {
    const reason = "研究正在运行或等待中，完成或停止后才能编辑消息";
    const markup = renderUserEdit({
      canEdit: false,
      isEditing: false,
      disabledReason: reason,
    });

    expect(markup).toContain(`aria-label="${reason}"`);
    expect(markup).toContain(`title="${reason}"`);
    expect(markup).toContain("disabled");

    const openEditorMarkup = renderUserEdit({
      canEdit: false,
      isEditing: true,
      value: "等待完成后再保存",
      disabledReason: reason,
    });
    expect(openEditorMarkup).toContain('role="status"');
    expect(openEditorMarkup).toContain(reason);
    expect(openEditorMarkup).toContain("保存并提交");
  });

  it("announces a failed edit and locks controls while saving", () => {
    const failedMarkup = renderUserEdit({
      canEdit: true,
      isEditing: true,
      value: "寻找法国阀门买家",
      error: "分支选择已经变化",
    });
    expect(failedMarkup).toContain('role="alert"');
    expect(failedMarkup).toContain("分支选择已经变化");

    const pendingMarkup = renderUserEdit({
      canEdit: true,
      isEditing: true,
      value: "寻找法国阀门买家",
      isSaving: true,
    });
    expect(pendingMarkup).toContain('aria-busy="true"');
    expect(pendingMarkup).toContain("正在保存…");
  });
});
