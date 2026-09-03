import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ChatComposer,
  chatComposerControlState,
  chatComposerShowsFileDropZone,
  consumeChatComposerFocusRequest,
  nextChatComposerFileDragDepth,
  nextChatComposerFocusRequestToken,
} from "@/components/chat-composer";
import type { DraftInputAttachment } from "@/components/input-attachment-state";
import type {
  ExecutionProfileOption,
  InputAttachmentLimits,
} from "@/lib/contracts";
import {
  INPUT_ATTACHMENT_ACCEPT,
  INPUT_ATTACHMENT_SUPPORT_TEXT,
} from "@/lib/input-attachment-formats";

const uploadedAttachment: DraftInputAttachment = {
  clientId: "local-attachment",
  name: "buyers.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
  previewUrl: null,
  status: "uploaded",
  attachment: {
    id: "10000000-0000-4000-8000-000000000001",
    kind: "file",
    name: "buyers.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    downloadUrl: "/api/input-attachments/10000000-0000-4000-8000-000000000001",
    createdAt: "2026-08-25T08:00:00.000Z",
  },
};

const uploadedJpeg: DraftInputAttachment = {
  clientId: "local-image",
  name: "factory.jpeg",
  mimeType: "image/jpeg",
  sizeBytes: 2048,
  previewUrl: "blob:factory-preview",
  status: "uploaded",
  attachment: {
    id: "10000000-0000-4000-8000-000000000002",
    kind: "image",
    name: "factory.jpeg",
    mimeType: "image/jpeg",
    sizeBytes: 2048,
    downloadUrl: "/api/input-attachments/10000000-0000-4000-8000-000000000002",
    createdAt: "2026-08-25T08:00:00.000Z",
  },
};

const restoredJpeg: DraftInputAttachment = {
  ...uploadedJpeg,
  clientId: `staged:${uploadedJpeg.attachment.id}`,
  previewUrl: null,
};

const failedJpeg: DraftInputAttachment = {
  clientId: "local-failed-image",
  file: new File(["jpeg"], "failed-factory.jpeg", {
    type: "image/jpeg",
  }),
  name: "failed-factory.jpeg",
  mimeType: "image/jpeg",
  sizeBytes: 4,
  previewUrl: "blob:failed-factory-preview",
  status: "failed",
  error: "网络连接中断",
};

const inputAttachmentLimits: InputAttachmentLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxFilesPerMessage: 5,
  maxTotalBytesPerMessage: 20 * 1024 * 1024,
};

const executionProfiles: ExecutionProfileOption[] = [
  {
    id: "standard_research",
    label: "标准研究",
    description: "适合快速查找和整理潜在买家。",
  },
  {
    id: "pro_research",
    label: "专业研究",
    description: "投入更多推理与检索，适合复杂市场研究。",
  },
];

function renderComposer(input: {
  attachments?: DraftInputAttachment[];
  disabled?: boolean;
  isStopping?: boolean;
  isStreaming?: boolean;
  inputAttachmentLimits?: InputAttachmentLimits;
  value?: string;
} = {}): string {
  return renderToStaticMarkup(
    <ChatComposer
      attachmentError={null}
      attachments={input.attachments ?? []}
      disabled={input.disabled ?? false}
      executionProfileScopeKey="test-draft"
      executionProfiles={executionProfiles}
      focusRequestToken={0}
      inputAttachmentLimits={
        input.inputAttachmentLimits ?? inputAttachmentLimits
      }
      isStopping={input.isStopping ?? false}
      isStreaming={input.isStreaming ?? false}
      onChange={() => undefined}
      onDismissAttachmentError={() => undefined}
      onExecutionProfileChange={() => undefined}
      onFilesSelected={() => undefined}
      onRemoveAttachment={() => undefined}
      onRetryAttachment={() => undefined}
      onStop={() => undefined}
      onSubmit={() => undefined}
      selectedExecutionProfileId="standard_research"
      value={input.value ?? "寻找德国泵类采购经理"}
    />,
  );
}

function openingTag(markup: string, marker: string): string {
  const markerIndex = markup.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find markup marker: ${marker}`);
  }
  const start = markup.lastIndexOf("<", markerIndex);
  const end = markup.indexOf(">", markerIndex);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find opening tag for marker: ${marker}`);
  }
  return markup.slice(start, end + 1);
}

describe("chat composer controls", () => {
  it("focuses only a new explicit request and places the cursor at the end", () => {
    const target = {
      value: "寻找德国采购经理",
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };

    const focused = consumeChatComposerFocusRequest({
      requestToken: 2,
      handledRequestToken: 1,
      disabled: false,
      hasOpenModal: false,
      target,
    });

    expect(focused).toEqual({ handledRequestToken: 2, didFocus: true });
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(target.setSelectionRange).toHaveBeenCalledWith(8, 8);

    const repeated = consumeChatComposerFocusRequest({
      requestToken: 2,
      handledRequestToken: focused.handledRequestToken,
      disabled: false,
      hasOpenModal: false,
      target,
    });
    expect(repeated).toEqual({ handledRequestToken: 2, didFocus: false });
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it("consumes blocked requests instead of stealing focus after a modal closes", () => {
    const target = {
      value: "保留草稿",
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };
    const blocked = consumeChatComposerFocusRequest({
      requestToken: 4,
      handledRequestToken: 3,
      disabled: false,
      hasOpenModal: true,
      target,
    });

    expect(blocked).toEqual({ handledRequestToken: 4, didFocus: false });
    expect(
      consumeChatComposerFocusRequest({
        requestToken: 4,
        handledRequestToken: blocked.handledRequestToken,
        disabled: false,
        hasOpenModal: false,
        target,
      }),
    ).toEqual({ handledRequestToken: 4, didFocus: false });
    expect(target.focus).not.toHaveBeenCalled();
  });

  it("retries an explicit focus request after a temporary disabled state clears", () => {
    const target = {
      value: "分支后的新问题",
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };

    const delayed = consumeChatComposerFocusRequest({
      requestToken: 6,
      handledRequestToken: 5,
      disabled: true,
      hasOpenModal: false,
      target,
    });
    expect(delayed).toEqual({ handledRequestToken: 5, didFocus: false });
    expect(target.focus).not.toHaveBeenCalled();

    const focused = consumeChatComposerFocusRequest({
      requestToken: 6,
      handledRequestToken: delayed.handledRequestToken,
      disabled: false,
      hasOpenModal: false,
      target,
    });
    expect(focused).toEqual({ handledRequestToken: 6, didFocus: true });
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(target.setSelectionRange).toHaveBeenCalledWith(7, 7);
  });

  it("advances focus request tokens without wrapping unsafe integers", () => {
    expect(nextChatComposerFocusRequestToken(0)).toBe(1);
    expect(() =>
      nextChatComposerFocusRequestToken(Number.MAX_SAFE_INTEGER),
    ).toThrow("输入框焦点请求 token 已超出安全整数范围");
  });

  it("advertises the global focus shortcut on the existing composer target", () => {
    const markup = renderComposer({ value: "保留草稿" });

    expect(openingTag(markup, 'aria-label="输入研究问题"')).toContain(
      'aria-keyshortcuts="Shift+Escape"',
    );
  });

  it("renders the selected execution profile instead of a static research-mode badge", () => {
    const markup = renderComposer();

    expect(markup).toContain("标准研究");
    expect(openingTag(markup, 'aria-label="执行模式：标准研究"')).toContain(
      'aria-haspopup="listbox"',
    );
    expect(markup).not.toContain("composer__context");
    expect(markup).not.toContain(">研究模式<");
  });

  it("clears file drag state when the draft is disabled before dragleave", () => {
    let dragDepth = nextChatComposerFileDragDepth({
      currentDepth: 0,
      action: "drag_enter",
      draftDisabled: false,
    });
    expect(dragDepth).toBe(1);
    expect(
      chatComposerShowsFileDropZone({ dragDepth, draftDisabled: false }),
    ).toBe(true);

    dragDepth = nextChatComposerFileDragDepth({
      currentDepth: dragDepth,
      action: "draft_disabled_change",
      draftDisabled: true,
    });
    expect(dragDepth).toBe(0);
    expect(
      chatComposerShowsFileDropZone({ dragDepth, draftDisabled: true }),
    ).toBe(false);

    dragDepth = nextChatComposerFileDragDepth({
      currentDepth: dragDepth,
      action: "drag_leave",
      draftDisabled: true,
    });
    dragDepth = nextChatComposerFileDragDepth({
      currentDepth: dragDepth,
      action: "draft_disabled_change",
      draftDisabled: false,
    });

    expect(dragDepth).toBe(0);
    expect(
      chatComposerShowsFileDropZone({ dragDepth, draftDisabled: false }),
    ).toBe(false);
  });

  it("keeps drafting and sending enabled while exposing a separate stop control", () => {
    expect(
      chatComposerControlState({
        disabled: false,
        draftCanSubmit: true,
        isStreaming: true,
        isStopping: false,
      }),
    ).toEqual({
      draftDisabled: false,
      sendDisabled: false,
      showStop: true,
      stopDisabled: false,
    });
  });

  it("lets isStopping disable only stop and leaves disabled responsible for the draft", () => {
    expect(
      chatComposerControlState({
        disabled: false,
        draftCanSubmit: true,
        isStreaming: true,
        isStopping: true,
      }),
    ).toEqual({
      draftDisabled: false,
      sendDisabled: false,
      showStop: true,
      stopDisabled: true,
    });
    expect(
      chatComposerControlState({
        disabled: true,
        draftCanSubmit: true,
        isStreaming: true,
        isStopping: false,
      }),
    ).toEqual({
      draftDisabled: true,
      sendDisabled: true,
      showStop: true,
      stopDisabled: false,
    });
  });

  it("renders independent stop and send buttons without disabling draft interactions", () => {
    const markup = renderComposer({
      attachments: [uploadedAttachment],
      isStreaming: true,
    });

    expect(openingTag(markup, 'aria-label="停止生成"')).not.toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="发送消息"')).not.toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="输入研究问题"')).not.toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="添加附件"')).not.toContain(
      "disabled",
    );
    expect(
      openingTag(markup, 'aria-label="移除附件：buyers.txt"'),
    ).not.toContain("disabled");
    expect(openingTag(markup, 'class="composer__file-input"')).not.toContain(
      "disabled",
    );
  });

  it("disables only the stop button while a stop request is pending", () => {
    const markup = renderComposer({ isStopping: true, isStreaming: true });

    expect(openingTag(markup, 'aria-label="正在停止"')).toContain("disabled");
    expect(openingTag(markup, 'aria-label="发送消息"')).not.toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="输入研究问题"')).not.toContain(
      "disabled",
    );
  });

  it("keeps stop available while disabled locks drafting and sending", () => {
    const markup = renderComposer({ disabled: true, isStreaming: true });

    expect(openingTag(markup, 'aria-label="停止生成"')).not.toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="发送消息"')).toContain("disabled");
    expect(openingTag(markup, 'aria-label="输入研究问题"')).toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="添加附件"')).toContain("disabled");
  });

  it("advertises the exact expanded accept contract and previews JPEG", () => {
    const markup = renderComposer({ attachments: [uploadedJpeg] });

    expect(openingTag(markup, 'class="composer__file-input"')).toContain(
      `accept="${INPUT_ATTACHMENT_ACCEPT}"`,
    );
    expect(openingTag(markup, 'aria-label="添加附件"')).toContain(
      `title="添加 ${INPUT_ATTACHMENT_SUPPORT_TEXT}"`,
    );
    expect(markup).toContain('src="blob:factory-preview"');
    expect(markup).toContain("上传完成 · JPG/JPEG · 2.0 KB");
    expect(openingTag(markup, "上传完成 · JPG/JPEG · 2.0 KB")).toContain(
      'aria-live="polite"',
    );
    expect(openingTag(markup, "上传完成 · JPG/JPEG · 2.0 KB")).toContain(
      'role="status"',
    );
  });

  it("previews restored uploaded and deleting images from the staged download URL", () => {
    const deletingJpeg: DraftInputAttachment = {
      ...restoredJpeg,
      clientId: `${restoredJpeg.clientId}:deleting`,
      status: "deleting",
    };
    const markup = renderComposer({
      attachments: [restoredJpeg, deletingJpeg],
    });

    expect(
      markup.match(
        new RegExp(`src="${restoredJpeg.attachment.downloadUrl}"`, "gu"),
      ),
    ).toHaveLength(2);
    expect(
      openingTag(markup, "composer-attachment--deleting"),
    ).toContain('aria-busy="true"');
    expect(markup).not.toContain("blob:");
  });

  it("keeps a failed image preview and exposes independent retry and remove controls", () => {
    const markup = renderComposer({ attachments: [failedJpeg] });

    expect(markup).toContain('src="blob:failed-factory-preview"');
    expect(markup).toContain("网络连接中断");
    expect(openingTag(markup, "网络连接中断")).toContain('role="alert"');
    expect(
      openingTag(markup, 'aria-label="重试上传：failed-factory.jpeg"'),
    ).not.toContain("disabled");
    expect(markup).toContain(">重试上传</button>");
    expect(
      openingTag(markup, 'aria-label="移除附件：failed-factory.jpeg"'),
    ).not.toContain("disabled");
    expect(openingTag(markup, 'aria-label="发送消息"')).toContain("disabled");
  });

  it("locks retry together with other draft interactions without changing stop", () => {
    const markup = renderComposer({
      attachments: [failedJpeg],
      disabled: true,
      isStreaming: true,
    });

    expect(
      openingTag(markup, 'aria-label="重试上传：failed-factory.jpeg"'),
    ).toContain("disabled");
    expect(
      openingTag(markup, 'aria-label="移除附件：failed-factory.jpeg"'),
    ).toContain("disabled");
    expect(openingTag(markup, 'aria-label="停止生成"')).not.toContain(
      "disabled",
    );
  });

  it("uses the bootstrap limits for attachment and send controls", () => {
    const markup = renderComposer({
      attachments: [uploadedAttachment],
      inputAttachmentLimits: {
        maxFileBytes: 10,
        maxFilesPerMessage: 1,
        maxTotalBytesPerMessage: 10,
      },
    });

    expect(openingTag(markup, 'aria-label="添加附件"')).toContain("disabled");
    expect(openingTag(markup, 'class="composer__file-input"')).toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="发送消息"')).toContain("disabled");
  });
});
