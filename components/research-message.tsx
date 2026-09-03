import {
  createContext,
  isValidElement,
  type HTMLAttributes,
  type ReactNode,
  useContext,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentRun,
  ArtifactSummary,
  ChatMessage,
  InputAttachmentLimits,
  InputAttachmentSummary,
  MessageFeedback,
  RunEvent,
} from "@/lib/contracts";
import {
  INPUT_ATTACHMENT_ACCEPT,
  INPUT_ATTACHMENT_SUPPORT_TEXT,
  isInputAttachmentImageMimeType,
} from "@/lib/input-attachment-formats";
import {
  ActivityIcon,
  AlertIcon,
  AttachmentIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DocumentIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  PencilIcon,
  RefreshIcon,
  SearchIcon,
  StopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "@/components/icons";
import { AttachmentImageViewer } from "@/components/attachment-image-viewer";
import { InputAttachmentTextViewer } from "@/components/input-attachment-text-viewer";
import { isInputAttachmentSourcePreviewMimeType } from "@/components/input-attachment-text-viewer-state";
import { InputAttachmentSpreadsheetViewer } from "@/components/input-attachment-spreadsheet-viewer";
import {
  canAddInputAttachment,
  formatAttachmentBytes,
  inputAttachmentTypeLabel,
  validateDraftInputAttachmentLimits,
  type DraftInputAttachment,
} from "@/components/input-attachment-state";
import {
  ArtifactCards,
  ArtifactViewer,
} from "@/components/artifact-viewer";
import { inlineCitationMarkdownPlugin } from "@/components/inline-citation-markdown";
import {
  type NumberedCitation,
  prepareInlineCitations,
} from "@/components/inline-citation-state";
import { MessageCopyAction } from "@/components/message-copy-action";
import {
  AssistantMessageMoreMenu,
  MessageBranchToNewConversationAction,
  type MessageBranchToNewConversationControls,
} from "@/components/message-branch-action";
import { MarkdownCodeBlock } from "@/components/markdown-code-block";
import { MarkdownTable } from "@/components/markdown-table";
import { RunProcessCard } from "@/components/run-activity";
import {
  idleRunEventConnectionState,
  type RunEventConnectionState,
} from "@/components/run-event-connection-state";
import {
  artifactsForRun,
  effectiveRunStatus,
  textForRun,
} from "@/components/research-workspace-state";
import { isConversationSharePrivateResourceSentinel } from "@/lib/conversation-share-safety";

function sourceHost(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

type ResearchMarkdownRuntime = {
  highlightCode: boolean;
  hidePrivateResourceLinks: boolean;
  onOpenCitation?: (citationNumber: number, trigger: HTMLElement) => void;
};

const ResearchMarkdownRuntimeContext =
  createContext<ResearchMarkdownRuntime | null>(null);

function useResearchMarkdownRuntime(): ResearchMarkdownRuntime {
  const runtime = useContext(ResearchMarkdownRuntimeContext);
  if (runtime === null) {
    throw new Error("研究 Markdown 组件缺少运行上下文");
  }
  return runtime;
}

const researchMarkdownComponents: Components = {
  a: function ResearchMarkdownAnchor({
    children,
    href,
    node,
    ...properties
  }) {
    void node;
    const { hidePrivateResourceLinks, onOpenCitation } =
      useResearchMarkdownRuntime();
    const citationNumberProperty = (
      properties as typeof properties & {
        "data-citation-number"?: unknown;
      }
    )["data-citation-number"];
    if (
      onOpenCitation !== undefined &&
      citationNumberProperty !== undefined
    ) {
      const citationNumber = Number(citationNumberProperty);
      if (!Number.isSafeInteger(citationNumber) || citationNumber <= 0) {
        throw new Error("内联引用编号必须是正安全整数");
      }
      return (
        <button
          aria-controls="citation-sources-panel"
          aria-haspopup="dialog"
          aria-label={properties["aria-label"]}
          className={properties.className}
          data-citation-number={citationNumber}
          onClick={(event) =>
            onOpenCitation(citationNumber, event.currentTarget)
          }
          title={properties.title}
          type="button"
        >
          {children}
        </button>
      );
    }
    if (
      hidePrivateResourceLinks &&
      href !== undefined &&
      isConversationSharePrivateResourceSentinel(href)
    ) {
      return (
        <span className="shared-conversation-private-file-link">
          <span>{children}</span>
          <small>仅展示文件元数据</small>
        </span>
      );
    }
    return (
      <a {...properties} href={href} rel="noreferrer" target="_blank">
        {children}
      </a>
    );
  },
  pre: function ResearchMarkdownPre({ children, node, ...properties }) {
    void node;
    const { highlightCode } = useResearchMarkdownRuntime();
    if (
      !isValidElement<
        HTMLAttributes<HTMLElement> & { children?: ReactNode }
      >(children) ||
      children.type !== "code"
    ) {
      throw new Error("Markdown 围栏代码块结构无效");
    }
    const {
      children: codeChildren,
      className,
      ...codeProperties
    } = children.props;
    if (typeof codeChildren !== "string") {
      throw new Error("Markdown 围栏代码块正文不是文本");
    }
    return (
      <MarkdownCodeBlock
        className={className}
        codeProperties={codeProperties}
        highlight={highlightCode}
        preProperties={properties}
      >
        {codeChildren}
      </MarkdownCodeBlock>
    );
  },
  table: ({ children, node, ...properties }) => {
    void node;
    return (
      <MarkdownTable tableProperties={properties}>
        {children}
      </MarkdownTable>
    );
  },
};

export function ResearchMarkdown({
  citations,
  content,
  hidePrivateResourceLinks = false,
  highlightCode,
  onOpenCitation,
}: {
  citations: readonly NumberedCitation[];
  content: string;
  hidePrivateResourceLinks?: boolean;
  highlightCode: boolean;
  onOpenCitation?: (citationNumber: number, trigger: HTMLElement) => void;
}) {
  return (
    <ResearchMarkdownRuntimeContext
      value={{ hidePrivateResourceLinks, highlightCode, onOpenCitation }}
    >
      <div className="research-markdown">
        <ReactMarkdown
          components={researchMarkdownComponents}
          rehypePlugins={[inlineCitationMarkdownPlugin(citations, content)]}
          remarkPlugins={[remarkGfm]}
        >
          {content}
        </ReactMarkdown>
      </div>
    </ResearchMarkdownRuntimeContext>
  );
}

export function CitationCards({
  citations,
  onOpenCitation,
}: {
  citations: readonly NumberedCitation[];
  onOpenCitation?: (citationNumber: number, trigger: HTMLElement) => void;
}) {
  if (citations.length === 0) {
    return null;
  }

  return (
    <section aria-label="回答引用" className="source-section">
      <div className="message-section-label">
        <SearchIcon />
        <span>研究来源</span>
        <span className="message-section-label__count">{citations.length}</span>
      </div>
      <div className="source-grid">
        {citations.map(({ citation, citedText, number, originalIndex }) => {
          const key = `${citation.url}-${citation.startIndex}-${citation.endIndex}-${originalIndex}`;
          const content = (
            <>
              <span className="source-card__number">{number}</span>
              <span className="source-card__copy">
                <strong>{citation.title}</strong>
                <small>{sourceHost(citation.url)}</small>
              </span>
            </>
          );
          return onOpenCitation === undefined ? (
            <a
              aria-label={`来源 ${number}：${citation.title}`}
              className="source-card"
              href={citation.url}
              key={key}
              rel="noreferrer"
              target="_blank"
              title={citedText}
            >
              {content}
              <ExternalLinkIcon />
            </a>
          ) : (
            <button
              aria-controls="citation-sources-panel"
              aria-haspopup="dialog"
              aria-label={`查看来源 ${number}：${citation.title}`}
              className="source-card"
              key={key}
              onClick={(event) =>
                onOpenCitation(number, event.currentTarget)
              }
              title={citedText}
              type="button"
            >
              {content}
              <ChevronRightIcon />
            </button>
          );
        })}
      </div>
    </section>
  );
}

export type OpenCitationSources = (
  messageId: string,
  citations: readonly NumberedCitation[],
  activeNumber: number,
  trigger: HTMLElement,
) => void;

export function MessageSourcesAction({
  citations,
  messageId,
  onOpenSources,
}: {
  citations: readonly NumberedCitation[];
  messageId: string;
  onOpenSources: OpenCitationSources;
}) {
  const firstCitation = citations[0];
  if (firstCitation === undefined) {
    return null;
  }

  return (
    <button
      aria-controls="citation-sources-panel"
      aria-haspopup="dialog"
      aria-label={`查看回答来源，共 ${citations.length} 个`}
      className="message-action-button message-sources-action"
      onClick={(event) =>
        onOpenSources(
          messageId,
          citations,
          firstCitation.number,
          event.currentTarget,
        )
      }
      title={`查看 ${citations.length} 个来源`}
      type="button"
    >
      <SearchIcon />
      <span>来源 {citations.length}</span>
    </button>
  );
}

function MessageAttachmentCards({
  attachments,
}: {
  attachments: InputAttachmentSummary[];
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div
      aria-label={`消息附件，共 ${attachments.length} 个`}
      className="message-input-attachments"
    >
      {attachments.map((attachment) => {
        if (isInputAttachmentImageMimeType(attachment.mimeType)) {
          return (
            <AttachmentImageViewer
              downloadUrl={attachment.downloadUrl}
              key={attachment.id}
              name={attachment.name}
              sizeBytes={attachment.sizeBytes}
            />
          );
        }
        if (
          attachment.mimeType === "application/pdf" ||
          attachment.mimeType === "text/csv"
        ) {
          return (
            <ArtifactViewer
              artifact={{
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                downloadUrl: attachment.downloadUrl,
                createdAt: attachment.createdAt,
              }}
              key={attachment.id}
              variant="input-attachment"
            />
          );
        }
        if (isInputAttachmentSourcePreviewMimeType(attachment.mimeType)) {
          return (
            <InputAttachmentTextViewer
              downloadUrl={attachment.downloadUrl}
              key={attachment.id}
              mimeType={attachment.mimeType}
              name={attachment.name}
              sizeBytes={attachment.sizeBytes}
            />
          );
        }
        if (
          attachment.mimeType ===
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ) {
          return (
            <InputAttachmentSpreadsheetViewer
              downloadUrl={attachment.downloadUrl}
              key={attachment.id}
              name={attachment.name}
              sizeBytes={attachment.sizeBytes}
            />
          );
        }
        return (
          <a
            className="message-input-attachment message-input-attachment--file"
            download
            href={attachment.downloadUrl}
            key={attachment.id}
          >
            <span className="message-input-attachment__file-icon">
              <DocumentIcon />
              <small>{inputAttachmentTypeLabel(attachment.mimeType)}</small>
            </span>
            <span className="message-input-attachment__copy">
              <strong>{attachment.name}</strong>
              <small>
                {inputAttachmentTypeLabel(attachment.mimeType)} · {" "}
                {formatAttachmentBytes(attachment.sizeBytes)}
              </small>
            </span>
            <DownloadIcon />
          </a>
        );
      })}
    </div>
  );
}

function MessageFeedbackActions({
  feedback,
  isPending,
  messageId,
  onFeedback,
}: {
  feedback: MessageFeedback | null;
  isPending: boolean;
  messageId: string;
  onFeedback: (messageId: string, feedback: MessageFeedback | null) => void;
}) {
  return (
    <span
      aria-busy={isPending}
      aria-label="回答反馈"
      className="message-feedback-actions"
      role="group"
    >
      <button
        aria-label={
          isPending
            ? "正在保存回答反馈"
            : feedback === "up"
              ? "取消赞同此回答"
              : "赞同此回答"
        }
        aria-pressed={feedback === "up"}
        className={`message-action-button${
          feedback === "up" ? " message-action-button--selected" : ""
        }`}
        disabled={isPending}
        onClick={() => onFeedback(messageId, feedback === "up" ? null : "up")}
        title={feedback === "up" ? "取消赞同" : "赞同"}
        type="button"
      >
        <ThumbsUpIcon />
      </button>
      <button
        aria-label={
          isPending
            ? "正在保存回答反馈"
            : feedback === "down"
              ? "取消不赞同此回答"
              : "不赞同此回答"
        }
        aria-pressed={feedback === "down"}
        className={`message-action-button${
          feedback === "down" ? " message-action-button--selected" : ""
        }`}
        disabled={isPending}
        onClick={() =>
          onFeedback(messageId, feedback === "down" ? null : "down")
        }
        title={feedback === "down" ? "取消不赞同" : "不赞同"}
        type="button"
      >
        <ThumbsDownIcon />
      </button>
      <span aria-live="polite" className="visually-hidden" role="status">
        {isPending
          ? "正在保存回答反馈"
          : feedback === "up"
            ? "已赞同此回答"
            : feedback === "down"
              ? "已标记不赞同此回答"
              : "尚未评价此回答"}
      </span>
    </span>
  );
}

export type UserMessageEditControls = {
  canEdit: boolean;
  disabledReason: string | null;
  isEditing: boolean;
  value: string;
  retainedAttachments: InputAttachmentSummary[];
  newAttachments: DraftInputAttachment[];
  attachmentError: string | null;
  inputAttachmentLimits: InputAttachmentLimits;
  isSaving: boolean;
  error: string | null;
  onBegin: () => void;
  onChange: (value: string) => void;
  onFilesSelected: (files: File[]) => void;
  onRemoveRetainedAttachment: (attachmentId: string) => void;
  onRemoveNewAttachment: (clientId: string) => void;
  onRetryNewAttachment: (clientId: string) => void;
  onDismissAttachmentError: () => void;
  onCancel: () => void;
  onSave: () => void;
};

function editAttachmentStatusText(attachment: DraftInputAttachment): string {
  switch (attachment.status) {
    case "uploading":
      return "正在上传";
    case "uploaded":
      return `新增附件 · ${inputAttachmentTypeLabel(attachment.mimeType)} · ${formatAttachmentBytes(
        attachment.sizeBytes,
      )}`;
    case "deleting":
      return "正在移除";
    case "failed":
      return attachment.error;
  }
}

function UserMessageEditAttachments({
  attachments,
  newAttachments,
  inputAttachmentLimits,
  disabled,
  onFilesSelected,
  onRemoveRetainedAttachment,
  onRemoveNewAttachment,
  onRetryNewAttachment,
}: {
  attachments: InputAttachmentSummary[];
  newAttachments: DraftInputAttachment[];
  inputAttachmentLimits: InputAttachmentLimits;
  disabled: boolean;
  onFilesSelected: (files: File[]) => void;
  onRemoveRetainedAttachment: (attachmentId: string) => void;
  onRemoveNewAttachment: (clientId: string) => void;
  onRetryNewAttachment: (clientId: string) => void;
}) {
  const allAttachments = [...attachments, ...newAttachments];
  const canAddAttachment = canAddInputAttachment(
    allAttachments,
    inputAttachmentLimits,
  );

  return (
    <section className="user-message-editor__attachment-section">
      <div className="user-message-editor__attachment-toolbar">
        <span>
          附件 {allAttachments.length}/{inputAttachmentLimits.maxFilesPerMessage}
        </span>
        <label
          aria-disabled={disabled || !canAddAttachment}
          className="user-message-editor__attachment-add"
          title={`添加 ${INPUT_ATTACHMENT_SUPPORT_TEXT}`}
        >
          <AttachmentIcon />
          <span>添加附件</span>
          <input
            accept={INPUT_ATTACHMENT_ACCEPT}
            aria-label="添加附件"
            className="visually-hidden"
            disabled={disabled || !canAddAttachment}
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              if (files.length > 0) {
                onFilesSelected(files);
              }
            }}
            type="file"
          />
        </label>
      </div>

      {allAttachments.length === 0 ? (
        <p className="user-message-editor__attachment-empty">
          编辑后的消息不会包含附件。
        </p>
      ) : (
        <div
          aria-label={`编辑后附件，共 ${allAttachments.length} 个`}
          className="composer-attachments user-message-editor__attachments"
        >
          {attachments.map((attachment) => (
            <article
              className="composer-attachment composer-attachment--uploaded"
              key={attachment.id}
            >
              <span className="composer-attachment__preview">
                {isInputAttachmentImageMimeType(attachment.mimeType) ? (
                  <ImageIcon />
                ) : (
                  <>
                    <DocumentIcon />
                    <small>{inputAttachmentTypeLabel(attachment.mimeType)}</small>
                  </>
                )}
              </span>
              <span className="composer-attachment__copy">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small>
                  原消息附件 · {inputAttachmentTypeLabel(attachment.mimeType)} · {" "}
                  {formatAttachmentBytes(attachment.sizeBytes)}
                </small>
              </span>
              <span className="composer-attachment__actions">
                <button
                  aria-label={`移除已有附件：${attachment.name}`}
                  className="composer-attachment__remove"
                  disabled={disabled}
                  onClick={() => onRemoveRetainedAttachment(attachment.id)}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </span>
            </article>
          ))}
          {newAttachments.map((attachment) => (
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
                  attachment.previewUrl === null ? (
                    <ImageIcon />
                  ) : (
                    // The preview URL belongs to the selected local image.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" src={attachment.previewUrl} />
                  )
                ) : (
                  <>
                    <DocumentIcon />
                    <small>{inputAttachmentTypeLabel(attachment.mimeType)}</small>
                  </>
                )}
              </span>
              <span className="composer-attachment__copy">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small
                  aria-atomic="true"
                  aria-live={attachment.status === "failed" ? "assertive" : "polite"}
                  className={
                    attachment.status === "failed"
                      ? "composer-attachment__error"
                      : undefined
                  }
                  role={attachment.status === "failed" ? "alert" : "status"}
                >
                  {editAttachmentStatusText(attachment)}
                </small>
              </span>
              <span className="composer-attachment__actions">
                {attachment.status === "failed" ? (
                  <button
                    aria-label={`重试上传：${attachment.name}`}
                    className="composer-attachment__retry"
                    disabled={disabled}
                    onClick={() => onRetryNewAttachment(attachment.clientId)}
                    type="button"
                  >
                    重试上传
                  </button>
                ) : null}
                <button
                  aria-label={`移除新增附件：${attachment.name}`}
                  className="composer-attachment__remove"
                  disabled={disabled || attachment.status === "deleting"}
                  onClick={() => onRemoveNewAttachment(attachment.clientId)}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </span>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function MessageView({
  message,
  run,
  events,
  connectionState = idleRunEventConnectionState,
  assistantActions,
  branchToNewConversation,
  isActivityPanelOpen = false,
  isSearchMatch = false,
  isFeedbackPending,
  onFeedback,
  onOpenActivity,
  onOpenSources,
  userEdit,
}: {
  message: ChatMessage;
  run: AgentRun | null;
  events: RunEvent[];
  connectionState?: RunEventConnectionState;
  assistantActions?: ReactNode;
  assistantActionsPersistent?: boolean;
  branchToNewConversation?: MessageBranchToNewConversationControls;
  isActivityPanelOpen?: boolean;
  isSearchMatch?: boolean;
  isFeedbackPending: boolean;
  onFeedback: (messageId: string, feedback: MessageFeedback | null) => void;
  onOpenActivity: (runId: string, surface?: "inline" | "panel") => void;
  onOpenSources?: OpenCitationSources;
  userEdit?: UserMessageEditControls;
}) {
  if (message.role === "user") {
    if (assistantActions !== undefined) {
      throw new Error("用户消息不能包含回答操作");
    }
    const normalizedEditValue = userEdit?.value.trim() ?? "";
    const originalAttachmentIds = message.attachments.map(
      (attachment) => attachment.id,
    );
    const editedAttachmentIds = [
      ...(userEdit?.retainedAttachments.map((attachment) => attachment.id) ?? []),
      ...(userEdit?.newAttachments.flatMap((attachment) =>
        attachment.status === "uploaded" ? [attachment.attachment.id] : [],
      ) ?? []),
    ];
    const attachmentsAreReady =
      userEdit?.newAttachments.every(
        (attachment) => attachment.status === "uploaded",
      ) ?? true;
    const attachmentsAreBusy =
      userEdit?.newAttachments.some(
        (attachment) =>
          attachment.status === "uploading" ||
          attachment.status === "deleting",
      ) ?? false;
    const attachmentLimitError =
      userEdit === undefined
        ? null
        : validateDraftInputAttachmentLimits(
            [...userEdit.retainedAttachments, ...userEdit.newAttachments],
            userEdit.inputAttachmentLimits,
          );
    const attachmentsChanged =
      editedAttachmentIds.length !== originalAttachmentIds.length ||
      editedAttachmentIds.some(
        (attachmentId, index) => attachmentId !== originalAttachmentIds[index],
      );
    const editCanSave =
      userEdit !== undefined &&
      userEdit.isEditing &&
      userEdit.canEdit &&
      !userEdit.isSaving &&
      attachmentsAreReady &&
      attachmentLimitError === null &&
      (normalizedEditValue !== message.content || attachmentsChanged) &&
      (normalizedEditValue.length > 0 || editedAttachmentIds.length > 0);
    return (
      <article
        className={`message message--user${
          isSearchMatch ? " message--search-match" : ""
        }`}
        data-message-id={message.id}
      >
        {userEdit?.isEditing === true ? null : (
          <MessageAttachmentCards attachments={message.attachments} />
        )}
        {userEdit?.isEditing === true ? (
          <form
            aria-busy={userEdit.isSaving || attachmentsAreBusy}
            className="user-message-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (editCanSave) {
                userEdit.onSave();
              }
            }}
          >
            <label htmlFor={`edit-message-${message.id}`}>
              编辑这条消息
            </label>
            <textarea
              autoFocus
              disabled={userEdit.isSaving || !userEdit.canEdit}
              id={`edit-message-${message.id}`}
              maxLength={20_000}
              onChange={(event) => userEdit.onChange(event.target.value)}
              rows={3}
              value={userEdit.value}
            />
            <UserMessageEditAttachments
              attachments={userEdit.retainedAttachments}
              disabled={userEdit.isSaving || !userEdit.canEdit}
              inputAttachmentLimits={userEdit.inputAttachmentLimits}
              newAttachments={userEdit.newAttachments}
              onFilesSelected={userEdit.onFilesSelected}
              onRemoveNewAttachment={userEdit.onRemoveNewAttachment}
              onRemoveRetainedAttachment={userEdit.onRemoveRetainedAttachment}
              onRetryNewAttachment={userEdit.onRetryNewAttachment}
            />
            {userEdit.attachmentError === null ? null : (
              <div className="user-message-editor__attachment-error" role="alert">
                <span>{userEdit.attachmentError}</span>
                <button
                  aria-label="关闭附件错误"
                  onClick={userEdit.onDismissAttachmentError}
                  type="button"
                >
                  <CloseIcon />
                </button>
              </div>
            )}
            {userEdit.disabledReason === null ? null : (
              <p className="user-message-editor__disabled" role="status">
                {userEdit.disabledReason}
              </p>
            )}
            {userEdit.error === null ? null : (
              <p className="user-message-editor__error" role="alert">
                {userEdit.error}
              </p>
            )}
            <div className="user-message-editor__actions">
              <button
                disabled={userEdit.isSaving}
                onClick={userEdit.onCancel}
                type="button"
              >
                取消
              </button>
              <button disabled={!editCanSave} type="submit">
                {userEdit.isSaving ? "正在保存…" : "保存并提交"}
              </button>
            </div>
          </form>
        ) : message.content.length === 0 ? null : (
          <div className="user-message-bubble">{message.content}</div>
        )}
        <div className="user-message-footer">
          {userEdit?.isEditing === true ||
          (message.content.length === 0 &&
            userEdit === undefined &&
            branchToNewConversation === undefined) ? null : (
            <MessageCopyAction
              content={message.content.length === 0 ? null : message.content}
            >
              {userEdit === undefined ? null : (
                <button
                  aria-label={
                    userEdit.disabledReason === null
                      ? "编辑这条消息"
                      : userEdit.disabledReason
                  }
                  className="message-action-button user-message-edit-button"
                  disabled={!userEdit.canEdit}
                  onClick={userEdit.onBegin}
                  title={
                    userEdit.disabledReason ?? "编辑消息并创建新分支"
                  }
                  type="button"
                >
                  <PencilIcon />
                </button>
              )}
              {branchToNewConversation === undefined ? null : (
                <MessageBranchToNewConversationAction
                  controls={branchToNewConversation}
                  events={events}
                  message={message}
                  run={run}
                />
              )}
            </MessageCopyAction>
          )}
        </div>
      </article>
    );
  }

  const citations = prepareInlineCitations(
    message.content,
    message.citations,
  );

  return (
    <article
      className={`message message--assistant${
        isSearchMatch ? " message--search-match" : ""
      }`}
      data-message-id={message.id}
    >
      <div className="assistant-message-body">
        {run === null ? null : (
          <RunProcessCard
            connectionState={connectionState}
            events={events}
            isActivityPanelOpen={isActivityPanelOpen}
            key={run.id}
            onOpenActivity={onOpenActivity}
            run={run}
          />
        )}
        <MessageAttachmentCards attachments={message.attachments} />
        <ResearchMarkdown
          citations={citations}
          content={message.content}
          highlightCode
          onOpenCitation={
            onOpenSources === undefined
              ? undefined
              : (activeNumber, trigger) =>
                  onOpenSources(
                    message.id,
                    citations,
                    activeNumber,
                    trigger,
                  )
          }
        />
        {onOpenSources === undefined ? (
          <CitationCards citations={citations} />
        ) : null}
        <ArtifactCards artifacts={message.artifacts} />
        <div className="assistant-message-footer">
          <MessageCopyAction
            content={message.content.length === 0 ? null : message.content}
            persistent
          >
            <MessageFeedbackActions
              feedback={message.feedback}
              isPending={isFeedbackPending}
              messageId={message.id}
              onFeedback={onFeedback}
            />
            {assistantActions}
            {branchToNewConversation === undefined ? null : (
              <AssistantMessageMoreMenu
                controls={branchToNewConversation}
                events={events}
                message={message}
                run={run}
              />
            )}
            {onOpenSources === undefined ? null : (
              <MessageSourcesAction
                citations={citations}
                messageId={message.id}
                onOpenSources={onOpenSources}
              />
            )}
          </MessageCopyAction>
        </div>
      </div>
    </article>
  );
}

type StreamingMessageProps = {
  run: AgentRun;
  events: RunEvent[];
  connectionState: RunEventConnectionState;
  text: string;
  artifacts: ArtifactSummary[];
  isActivityPanelOpen?: boolean;
  onOpenActivity: (runId: string, surface?: "inline" | "panel") => void;
};

export function streamingMessageAccessibilityState(
  run: AgentRun,
  events: RunEvent[],
): {
  announcement: string;
  isBusy: true;
} {
  const status = effectiveRunStatus(run, events);
  switch (status) {
    case "queued":
      return {
        announcement: "研究已排队，正在等待生成回答。",
        isBusy: true,
      };
    case "running":
      return {
        announcement: "正在生成回答。",
        isBusy: true,
      };
    case "waiting":
    case "completed":
    case "failed":
    case "cancelled":
    case "reconciliation_required":
      throw new Error(`Run ${run.id} 不是流式运行`);
  }
}

export function StreamingMessage({
  run,
  events,
  connectionState,
  text,
  artifacts,
  isActivityPanelOpen = false,
  onOpenActivity,
}: StreamingMessageProps) {
  const accessibility = streamingMessageAccessibilityState(run, events);

  return (
    <>
      <span
        aria-atomic="true"
        aria-live="polite"
        className="visually-hidden"
        role="status"
      >
        {accessibility.announcement}
      </span>
      <article
        aria-busy={accessibility.isBusy}
        className="message message--assistant"
      >
        <div className="assistant-message-body assistant-message-body--streaming">
          <RunProcessCard
            connectionState={connectionState}
            events={events}
            isActivityPanelOpen={isActivityPanelOpen}
            key={run.id}
            onOpenActivity={onOpenActivity}
            run={run}
          />
          {text.length > 0 ? (
            <ResearchMarkdown
              citations={[]}
              content={text}
              highlightCode={false}
            />
          ) : null}
          <ArtifactCards artifacts={artifacts} />
        </div>
      </article>
    </>
  );
}

export function TurnAttemptControls({
  attemptIndex,
  attemptCount,
  isRegenerateEligible,
  isRegenerating,
  isSelecting,
  inline = false,
  mutationDisabledReason = null,
  onNext,
  onPrevious,
  onRegenerate,
  regenerateDisabledReason = null,
}: {
  attemptIndex: number;
  attemptCount: number;
  isRegenerateEligible: boolean;
  isRegenerating: boolean;
  isSelecting: boolean;
  inline?: boolean;
  mutationDisabledReason?: string | null;
  onNext: () => void;
  onPrevious: () => void;
  onRegenerate: () => void;
  regenerateDisabledReason?: string | null;
}) {
  if (
    !Number.isSafeInteger(attemptIndex) ||
    !Number.isSafeInteger(attemptCount) ||
    attemptCount <= 0 ||
    attemptIndex < 0 ||
    attemptIndex >= attemptCount
  ) {
    throw new Error("回答版本位置无效");
  }
  if (
    attemptCount === 1 &&
    !isRegenerateEligible &&
    !isRegenerating &&
    !isSelecting
  ) {
    return null;
  }
  const selectionDisabledReason = isSelecting
    ? "正在切换会话分支，请稍候"
    : mutationDisabledReason;
  const resolvedRegenerateDisabledReason = isRegenerating
    ? "正在重新生成回答"
    : isSelecting
      ? "正在切换会话分支，请稍候"
      : regenerateDisabledReason ?? mutationDisabledReason;
  const hasRegenerateControl = isRegenerateEligible || isRegenerating;
  const allVisibleControlsAreDisabled =
    (!hasRegenerateControl || resolvedRegenerateDisabledReason !== null) &&
    (attemptCount === 1 || selectionDisabledReason !== null);

  return (
    <div
      aria-busy={isSelecting || isRegenerating}
      aria-disabled={allVisibleControlsAreDisabled || undefined}
      aria-label="回答版本"
      className={`turn-attempt-controls${
        inline ? " turn-attempt-controls--inline" : ""
      }`}
      role="group"
    >
      {hasRegenerateControl ? (
        <button
          aria-label={
            resolvedRegenerateDisabledReason === null
              ? "重新生成回答"
              : isRegenerating
                ? resolvedRegenerateDisabledReason
                : `重新生成回答不可用：${resolvedRegenerateDisabledReason}`
          }
          className="turn-attempt-controls__regenerate"
          disabled={resolvedRegenerateDisabledReason !== null}
          onClick={onRegenerate}
          title={resolvedRegenerateDisabledReason ?? "重新生成回答"}
          type="button"
        >
          <RefreshIcon />
          <span className={inline ? "visually-hidden" : undefined}>
            {isRegenerating ? "正在重新生成…" : "重新生成"}
          </span>
        </button>
      ) : null}
      {attemptCount > 1 ? (
        <span className="turn-attempt-controls__navigator">
          <button
            aria-label={
              selectionDisabledReason === null
                ? "查看上一个回答"
                : `查看上一个回答不可用：${selectionDisabledReason}`
            }
            disabled={selectionDisabledReason !== null || attemptIndex === 0}
            onClick={onPrevious}
            title={selectionDisabledReason ?? "查看上一个回答"}
            type="button"
          >
            <ChevronLeftIcon />
          </button>
          <span aria-live="polite" className="turn-attempt-controls__position">
            {attemptIndex + 1} / {attemptCount}
          </span>
          <button
            aria-label={
              selectionDisabledReason === null
                ? "查看下一个回答"
                : `查看下一个回答不可用：${selectionDisabledReason}`
            }
            disabled={
              selectionDisabledReason !== null ||
              attemptIndex === attemptCount - 1
            }
            onClick={onNext}
            title={selectionDisabledReason ?? "查看下一个回答"}
            type="button"
          >
            <ChevronRightIcon />
          </button>
        </span>
      ) : null}
      {isSelecting ? (
        <span
          aria-live="polite"
          className={
            inline
              ? "turn-attempt-controls__pending visually-hidden"
              : "turn-attempt-controls__pending"
          }
        >
          正在切换…
        </span>
      ) : null}
    </div>
  );
}

export function TurnBranchControls({
  branchIndex,
  branchCount,
  isSelecting,
  mutationDisabledReason = null,
  onNext,
  onPrevious,
}: {
  branchIndex: number;
  branchCount: number;
  isSelecting: boolean;
  mutationDisabledReason?: string | null;
  onNext: () => void;
  onPrevious: () => void;
}) {
  if (
    !Number.isSafeInteger(branchIndex) ||
    !Number.isSafeInteger(branchCount) ||
    branchCount <= 0 ||
    branchIndex < 0 ||
    branchIndex >= branchCount
  ) {
    throw new Error("用户消息分支位置无效");
  }
  if (branchCount === 1) {
    return null;
  }
  const disabledReason = isSelecting
    ? "正在切换会话分支，请稍候"
    : mutationDisabledReason;

  return (
    <div
      aria-busy={isSelecting}
      aria-disabled={disabledReason !== null || undefined}
      aria-label="用户消息分支"
      className="turn-branch-controls"
      role="group"
    >
      <button
        aria-label={
          disabledReason === null
            ? "查看上一个用户消息分支"
            : `查看上一个用户消息分支不可用：${disabledReason}`
        }
        disabled={disabledReason !== null || branchIndex === 0}
        onClick={onPrevious}
        title={disabledReason ?? "查看上一个用户消息分支"}
        type="button"
      >
        <ChevronLeftIcon />
      </button>
      <span aria-live="polite" className="turn-branch-controls__position">
        {branchIndex + 1} / {branchCount}
      </span>
      <button
        aria-label={
          disabledReason === null
            ? "查看下一个用户消息分支"
            : `查看下一个用户消息分支不可用：${disabledReason}`
        }
        disabled={disabledReason !== null || branchIndex === branchCount - 1}
        onClick={onNext}
        title={disabledReason ?? "查看下一个用户消息分支"}
        type="button"
      >
        <ChevronRightIcon />
      </button>
      {isSelecting ? (
        <span className="visually-hidden" role="status">
          正在切换用户消息分支
        </span>
      ) : null}
    </div>
  );
}

export function WaitingRunMessage({
  run,
  isBlocked,
  isCancelling,
  onCancel,
}: {
  run: AgentRun;
  isBlocked: boolean;
  isCancelling: boolean;
  onCancel: (runId: string) => void;
}) {
  if (run.status !== "waiting") {
    throw new Error(`Run ${run.id} 不是等待中的运行`);
  }

  return (
    <article aria-live="polite" className="message message--assistant">
      <div className="assistant-message-body">
        <div
          className={`waiting-run-notice${
            isBlocked ? " waiting-run-notice--blocked" : ""
          }`}
          role="status"
        >
          {isBlocked ? <AlertIcon /> : <ActivityIcon />}
          <span className="waiting-run-notice__copy">
            <strong>{isBlocked ? "队列已暂停" : "已加入队列"}</strong>
            <p>
              {isBlocked
                ? "请重试前一轮或取消。"
                : "等待前一轮成功完成。"}
            </p>
          </span>
          <button
            aria-label={
              isCancelling ? "正在取消等待中的研究" : "取消等待中的研究"
            }
            className="waiting-run-notice__cancel"
            disabled={isCancelling}
            onClick={() => onCancel(run.id)}
            type="button"
          >
            <StopIcon />
            {isCancelling ? "正在取消…" : "取消"}
          </button>
        </div>
      </div>
    </article>
  );
}

function terminalRunCopy(
  run: AgentRun,
  events: RunEvent[],
): { title: string; message: string; status: "failed" | "cancelled" | "reconciliation_required" } {
  const status = effectiveRunStatus(run, events);
  if (
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "reconciliation_required"
  ) {
    throw new Error(`Run ${run.id} 不是无回答的终态运行`);
  }

  const errorEvent = events.findLast(
    (event) => event.payload.type === "error",
  );
  if (errorEvent?.payload.type !== "error" && run.failure === null) {
    throw new Error(`终态 Run ${run.id} 缺少 failure`);
  }

  switch (status) {
    case "failed":
      return {
        status,
        title: "这次研究未能完成",
        message: "运行未能完成，请稍后重试。",
      };
    case "cancelled":
      return {
        status,
        title: "这次研究已停止",
        message: "运行已停止。",
      };
    case "reconciliation_required":
      return {
        status,
        title: "这次研究需要核对积分",
        message: "生成内容已保留；这次运行的积分需要核对。",
      };
  }
}

export function TerminalRunMessage({
  run,
  events,
  connectionState = idleRunEventConnectionState,
  isActivityPanelOpen = false,
  onOpenActivity,
  onRetry,
  isRetrying = false,
  canRetry = false,
  mutationDisabledReason = null,
}: {
  run: AgentRun;
  events: RunEvent[];
  connectionState?: RunEventConnectionState;
  isActivityPanelOpen?: boolean;
  onOpenActivity: (runId: string, surface?: "inline" | "panel") => void;
  onRetry?: (runId: string) => void;
  isRetrying?: boolean;
  canRetry?: boolean;
  mutationDisabledReason?: string | null;
}) {
  const copy = terminalRunCopy(run, events);
  const partialText = textForRun(events);
  const partialArtifacts = artifactsForRun(events);
  const hasPartialAnswer =
    partialText.length > 0 || partialArtifacts.length > 0;
  const retainedContentLabel =
    copy.status === "reconciliation_required"
      ? "已保留生成内容 · 这次研究仍需核对积分"
      : "回答未完成 · 以下为已生成的部分内容";
  const retryControl = terminalRunRetryControlState({
    status: copy.status,
    canRetry,
    isRetrying,
    mutationDisabledReason,
  });
  if (retryControl.showRetry && onRetry === undefined) {
    throw new Error(`Run ${run.id} 允许重试但缺少 onRetry`);
  }

  return (
    <article className="message message--assistant">
      <div className="assistant-message-body">
        <RunProcessCard
          connectionState={connectionState}
          events={events}
          isActivityPanelOpen={isActivityPanelOpen}
          key={run.id}
          onOpenActivity={onOpenActivity}
          run={run}
        />
        {hasPartialAnswer ? (
          <div className="terminal-run-partial">
            <p className="terminal-run-partial__label">
              {retainedContentLabel}
            </p>
            {partialText.length > 0 ? (
              <ResearchMarkdown
                citations={[]}
                content={partialText}
                highlightCode={false}
              />
            ) : null}
            <ArtifactCards artifacts={partialArtifacts} />
            {partialText.length > 0 ? (
              <MessageCopyAction content={partialText} persistent />
            ) : null}
          </div>
        ) : null}
        <div
          className={`terminal-run-notice terminal-run-notice--${copy.status}`}
          role="status"
        >
          <AlertIcon />
          <span className="terminal-run-notice__copy">
            <strong>{copy.title}</strong>
            <p>{copy.message}</p>
          </span>
          {retryControl.showRetry ? (
            <button
              aria-label={retryControl.ariaLabel}
              className="terminal-run-notice__retry"
              disabled={retryControl.retryDisabled}
              onClick={() => onRetry?.(run.id)}
              title={retryControl.disabledReason ?? "重试这轮研究"}
              type="button"
            >
              <RefreshIcon />
              {retryControl.label}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function terminalRunRetryControlState({
  status,
  canRetry,
  isRetrying,
  mutationDisabledReason = null,
}: {
  status: "failed" | "cancelled" | "reconciliation_required";
  canRetry: boolean;
  isRetrying: boolean;
  mutationDisabledReason?: string | null;
}): {
  showRetry: boolean;
  retryDisabled: boolean;
  label: string;
  ariaLabel: string;
  disabledReason: string | null;
} {
  const showRetry = canRetry && (status === "failed" || status === "cancelled");
  const disabledReason = isRetrying
    ? "正在重试这轮研究"
    : mutationDisabledReason;
  return {
    showRetry,
    retryDisabled: showRetry && disabledReason !== null,
    label: isRetrying ? "正在重试…" : "重试这轮研究",
    ariaLabel:
      disabledReason === null
        ? "重试这轮研究"
        : isRetrying
          ? disabledReason
          : `重试这轮研究不可用：${disabledReason}`,
    disabledReason,
  };
}
