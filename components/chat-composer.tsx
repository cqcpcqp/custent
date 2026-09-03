"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import {
  canAddInputAttachment,
  canSubmitDraft,
  formatAttachmentBytes,
  inputAttachmentTypeLabel,
  type DraftInputAttachment,
} from "@/components/input-attachment-state";
import {
  documentHasOpenModal,
  workspaceKeyboardShortcutAriaKeyShortcuts,
} from "@/components/workspace-ux-state";
import { ExecutionProfilePicker } from "@/components/execution-profile-picker";
import {
  ArrowUpIcon,
  AttachmentIcon,
  CloseIcon,
  DocumentIcon,
  ImageIcon,
  StopIcon,
} from "@/components/icons";
import {
  inputAttachmentFormatSpecifications,
  inputAttachmentMimeTypeForUpload,
  INPUT_ATTACHMENT_ACCEPT,
  INPUT_ATTACHMENT_SUPPORT_TEXT,
  isInputAttachmentImageMimeType,
  type InputAttachmentImageMimeType,
} from "@/lib/input-attachment-formats";
import type {
  ExecutionProfileId,
  ExecutionProfileOption,
  InputAttachmentLimits,
} from "@/lib/contracts";

type ChatComposerProps = {
  value: string;
  focusRequestToken: number;
  attachments: DraftInputAttachment[];
  attachmentError: string | null;
  inputAttachmentLimits: InputAttachmentLimits;
  executionProfiles: ExecutionProfileOption[];
  selectedExecutionProfileId: ExecutionProfileId;
  executionProfileScopeKey: string;
  disabled: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  onChange: (value: string) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (clientId: string) => void;
  onRetryAttachment: (clientId: string) => void;
  onDismissAttachmentError: () => void;
  onExecutionProfileChange: (id: ExecutionProfileId) => void;
  onSubmit: () => void;
  onStop: () => void;
};

type ChatComposerFocusTarget = Pick<
  HTMLTextAreaElement,
  "focus" | "setSelectionRange" | "value"
>;

export type ChatComposerFocusRequestResult = {
  handledRequestToken: number;
  didFocus: boolean;
};

export function nextChatComposerFocusRequestToken(current: number): number {
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("输入框焦点请求 token 已超出安全整数范围");
  }
  return next;
}

export function consumeChatComposerFocusRequest(input: {
  requestToken: number;
  handledRequestToken: number;
  disabled: boolean;
  hasOpenModal: boolean;
  target: ChatComposerFocusTarget | null;
}): ChatComposerFocusRequestResult {
  if (input.requestToken === input.handledRequestToken) {
    return {
      handledRequestToken: input.handledRequestToken,
      didFocus: false,
    };
  }
  if (input.disabled) {
    return {
      handledRequestToken: input.handledRequestToken,
      didFocus: false,
    };
  }
  if (input.hasOpenModal || input.target === null) {
    return {
      handledRequestToken: input.requestToken,
      didFocus: false,
    };
  }

  input.target.focus({ preventScroll: true });
  const cursorPosition = input.target.value.length;
  input.target.setSelectionRange(cursorPosition, cursorPosition);
  return {
    handledRequestToken: input.requestToken,
    didFocus: true,
  };
}

export function chatComposerControlState(input: {
  disabled: boolean;
  draftCanSubmit: boolean;
  isStreaming: boolean;
  isStopping: boolean;
}): {
  draftDisabled: boolean;
  sendDisabled: boolean;
  showStop: boolean;
  stopDisabled: boolean;
} {
  return {
    draftDisabled: input.disabled,
    sendDisabled: input.disabled || !input.draftCanSubmit,
    showStop: input.isStreaming,
    stopDisabled: input.isStopping,
  };
}

type ChatComposerFileDragAction =
  | "draft_disabled_change"
  | "drag_enter"
  | "drag_leave"
  | "drop";

export function nextChatComposerFileDragDepth(input: {
  currentDepth: number;
  action: ChatComposerFileDragAction;
  draftDisabled: boolean;
}): number {
  if (input.draftDisabled || input.action === "drop") {
    return 0;
  }

  switch (input.action) {
    case "draft_disabled_change":
      return input.currentDepth;
    case "drag_enter":
      return input.currentDepth + 1;
    case "drag_leave":
      return Math.max(0, input.currentDepth - 1);
  }
}

export function chatComposerShowsFileDropZone(input: {
  dragDepth: number;
  draftDisabled: boolean;
}): boolean {
  return input.dragDepth > 0 && !input.draftDisabled;
}

function attachmentStatusText(attachment: DraftInputAttachment): string {
  switch (attachment.status) {
    case "uploading":
      return "正在上传";
    case "uploaded":
      return `上传完成 · ${inputAttachmentTypeLabel(attachment.mimeType)} · ${formatAttachmentBytes(
        attachment.sizeBytes,
      )}`;
    case "deleting":
      return "正在移除";
    case "failed":
      return attachment.error;
  }
}

function attachmentImagePreviewUrl(
  attachment: DraftInputAttachment,
): string | null {
  if (attachment.previewUrl !== null) {
    return attachment.previewUrl;
  }
  if (
    attachment.status === "uploaded" ||
    attachment.status === "deleting"
  ) {
    return attachment.attachment.downloadUrl;
  }
  return null;
}

function normalizedPastedImage(
  file: File,
  mimeType: InputAttachmentImageMimeType,
  index: number,
): File {
  const extensions = inputAttachmentFormatSpecifications[mimeType].extensions;
  const actualExtension = file.name
    .slice(file.name.lastIndexOf("."))
    .toLowerCase();
  if (
    extensions.some((extension) => extension === actualExtension) &&
    extensions.every((extension) => file.name.toLowerCase() !== extension)
  ) {
    return file;
  }
  const extension = extensions[0];
  return new File(
    [file],
    `pasted-image-${Date.now()}-${index + 1}${extension}`,
    { type: mimeType, lastModified: file.lastModified },
  );
}

export function ChatComposer({
  value,
  focusRequestToken,
  attachments,
  attachmentError,
  inputAttachmentLimits,
  executionProfiles,
  selectedExecutionProfileId,
  executionProfileScopeKey,
  disabled,
  isStreaming,
  isStopping,
  onChange,
  onFilesSelected,
  onRemoveAttachment,
  onRetryAttachment,
  onDismissAttachmentError,
  onExecutionProfileChange,
  onSubmit,
  onStop,
}: ChatComposerProps) {
  const [fileDragDepth, setFileDragDepth] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handledFocusRequestTokenRef = useRef(focusRequestToken);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftCanSubmit = canSubmitDraft(
    value,
    attachments,
    inputAttachmentLimits,
  );
  const canAddAttachment = canAddInputAttachment(
    attachments,
    inputAttachmentLimits,
  );
  const controls = chatComposerControlState({
    disabled,
    draftCanSubmit,
    isStreaming,
    isStopping,
  });

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
  }, [value]);

  useEffect(() => {
    const result = consumeChatComposerFocusRequest({
      requestToken: focusRequestToken,
      handledRequestToken: handledFocusRequestTokenRef.current,
      disabled: controls.draftDisabled,
      hasOpenModal: documentHasOpenModal(document),
      target: textareaRef.current,
    });
    handledFocusRequestTokenRef.current = result.handledRequestToken;
  }, [controls.draftDisabled, focusRequestToken]);

  useEffect(() => {
    if (!controls.draftDisabled) {
      return;
    }
    // A disabled draft ends the current DOM drag sequence. Reset it before a
    // later re-enable can reveal a stale drop zone.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFileDragDepth((currentDepth) =>
      nextChatComposerFileDragDepth({
        currentDepth,
        action: "draft_disabled_change",
        draftDisabled: true,
      }),
    );
  }, [controls.draftDisabled]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!controls.sendDisabled) {
      onSubmit();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!controls.sendDisabled) {
        onSubmit();
      }
    }
  }

  function handleFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) {
      onFilesSelected(files);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (controls.draftDisabled) {
      return;
    }
    const imageFiles: File[] = [];
    for (const [index, file] of Array.from(
      event.clipboardData.files,
    ).entries()) {
      const mimeType = inputAttachmentMimeTypeForUpload(file.type, file.name);
      if (
        mimeType !== null &&
        isInputAttachmentImageMimeType(mimeType)
      ) {
        imageFiles.push(normalizedPastedImage(file, mimeType, index));
      }
    }
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    onFilesSelected(imageFiles);
  }

  function eventContainsFiles(event: DragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!eventContainsFiles(event)) {
      return;
    }
    event.preventDefault();
    setFileDragDepth((currentDepth) =>
      nextChatComposerFileDragDepth({
        currentDepth,
        action: "drag_enter",
        draftDisabled: controls.draftDisabled,
      }),
    );
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!eventContainsFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = controls.draftDisabled ? "none" : "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!eventContainsFiles(event)) {
      return;
    }
    event.preventDefault();
    setFileDragDepth((currentDepth) =>
      nextChatComposerFileDragDepth({
        currentDepth,
        action: "drag_leave",
        draftDisabled: controls.draftDisabled,
      }),
    );
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!eventContainsFiles(event)) {
      return;
    }
    event.preventDefault();
    setFileDragDepth((currentDepth) =>
      nextChatComposerFileDragDepth({
        currentDepth,
        action: "drop",
        draftDisabled: controls.draftDisabled,
      }),
    );
    if (controls.draftDisabled) {
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      onFilesSelected(files);
    }
  }

  const showFileDropZone = chatComposerShowsFileDropZone({
    dragDepth: fileDragDepth,
    draftDisabled: controls.draftDisabled,
  });

  return (
    <div
      className={`composer-shell${showFileDropZone ? " composer-shell--dragging" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <form className="composer" onSubmit={handleSubmit}>
        {attachments.length === 0 ? null : (
          <div
            aria-label={`待发送附件，共 ${attachments.length} 个`}
            className="composer-attachments"
          >
            {attachments.map((attachment) => {
              const imagePreviewUrl = attachmentImagePreviewUrl(attachment);
              return (
                <article
                  aria-busy={
                    attachment.status === "uploading" ||
                    attachment.status === "deleting"
                  }
                  className={`composer-attachment composer-attachment--${attachment.status}`}
                  key={attachment.clientId}
                >
                  <span className="composer-attachment__preview">
                    {isInputAttachmentImageMimeType(attachment.mimeType) ? (
                      imagePreviewUrl === null ? (
                        <ImageIcon />
                      ) : (
                        // Draft previews use either a local blob or the staged attachment endpoint.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img alt="" src={imagePreviewUrl} />
                      )
                    ) : (
                      <>
                        <DocumentIcon />
                        <small>
                          {inputAttachmentTypeLabel(attachment.mimeType)}
                        </small>
                      </>
                    )}
                  </span>
                  <span className="composer-attachment__copy">
                    <strong title={attachment.name}>{attachment.name}</strong>
                    <small
                      aria-atomic="true"
                      aria-live={
                        attachment.status === "failed" ? "assertive" : "polite"
                      }
                      className={
                        attachment.status === "failed"
                          ? "composer-attachment__error"
                          : undefined
                      }
                      role={
                        attachment.status === "failed" ? "alert" : "status"
                      }
                    >
                      {attachmentStatusText(attachment)}
                    </small>
                  </span>
                  <span className="composer-attachment__actions">
                    {attachment.status === "failed" ? (
                      <button
                        aria-label={`重试上传：${attachment.name}`}
                        className="composer-attachment__retry"
                        disabled={controls.draftDisabled}
                        onClick={() =>
                          onRetryAttachment(attachment.clientId)
                        }
                        type="button"
                      >
                        重试上传
                      </button>
                    ) : null}
                    <button
                      aria-label={`移除附件：${attachment.name}`}
                      className="composer-attachment__remove"
                      disabled={
                        controls.draftDisabled ||
                        attachment.status === "deleting"
                      }
                      onClick={() => onRemoveAttachment(attachment.clientId)}
                      type="button"
                    >
                      <CloseIcon />
                    </button>
                  </span>
                </article>
              );
            })}
          </div>
        )}

        {attachmentError === null ? null : (
          <div className="composer__attachment-error" role="alert">
            <span>{attachmentError}</span>
            <button
              aria-label="关闭附件错误"
              onClick={onDismissAttachmentError}
              type="button"
            >
              <CloseIcon />
            </button>
          </div>
        )}

        <div className="composer__input-row">
          <button
            aria-label="添加附件"
            className="composer__attach"
            disabled={
              controls.draftDisabled || !canAddAttachment
            }
            onClick={() => fileInputRef.current?.click()}
            title={`添加 ${INPUT_ATTACHMENT_SUPPORT_TEXT}`}
            type="button"
          >
            <AttachmentIcon />
          </button>
          <textarea
            aria-keyshortcuts={
              workspaceKeyboardShortcutAriaKeyShortcuts.focus_composer
            }
            aria-label="输入研究问题"
            disabled={controls.draftDisabled}
            maxLength={20_000}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="描述产品、市场或想寻找的客户…"
            ref={textareaRef}
            rows={1}
            value={value}
          />
          <div className="composer__actions">
            <ExecutionProfilePicker
              disabled={controls.draftDisabled}
              onChange={onExecutionProfileChange}
              options={executionProfiles}
              scopeKey={executionProfileScopeKey}
              selectedId={selectedExecutionProfileId}
            />
            {controls.showStop ? (
              <button
                aria-label={isStopping ? "正在停止" : "停止生成"}
                className="composer__send composer__send--stop"
                disabled={controls.stopDisabled}
                onClick={onStop}
                type="button"
              >
                <StopIcon />
              </button>
            ) : null}
            <button
              aria-label="发送消息"
              className="composer__send"
              disabled={controls.sendDisabled}
              type="submit"
            >
              <ArrowUpIcon />
            </button>
          </div>
        </div>

        <input
          accept={INPUT_ATTACHMENT_ACCEPT}
          className="composer__file-input"
          disabled={controls.draftDisabled || !canAddAttachment}
          multiple
          onChange={handleFileInputChange}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />

        {showFileDropZone ? (
          <div className="composer__drop-zone" role="status">
            <AttachmentIcon />
            <strong>松开即可添加附件</strong>
            <span>
              支持 {INPUT_ATTACHMENT_SUPPORT_TEXT}，每条消息最多{
                inputAttachmentLimits.maxFilesPerMessage
              } 个
            </span>
          </div>
        ) : null}
      </form>
      <p className="composer-note">
        研究结果来自公开信息，重要联系人与商业判断请在使用前核验。
      </p>
    </div>
  );
}
