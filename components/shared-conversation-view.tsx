"use client";

import Link from "next/link";

import type {
  PublicConversationShare,
  SharedConversationFile,
  SharedConversationMessage,
} from "@/lib/contracts";
import {
  AttachmentIcon,
  BrandMark,
  DocumentIcon,
  ShareIcon,
} from "@/components/icons";
import {
  formatAttachmentBytes,
  inputAttachmentTypeLabel,
} from "@/components/input-attachment-state";
import { prepareInlineCitations } from "@/components/inline-citation-state";
import {
  CitationCards,
  ResearchMarkdown,
} from "@/components/research-message";
import { sanitizeConversationShareMessages } from "@/lib/conversation-share-safety";

type SharedArtifactFile = Extract<
  SharedConversationFile,
  { kind: "artifact" }
>;

const artifactTypeLabels: Record<SharedArtifactFile["mimeType"], string> = {
  "application/pdf": "PDF",
  "text/csv": "CSV",
};

const sharedTimestampFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Shanghai",
});

function sharedFileTypeLabel(file: SharedConversationFile): string {
  if (file.kind === "input_attachment") {
    return inputAttachmentTypeLabel(file.mimeType);
  }
  return artifactTypeLabels[file.mimeType];
}

function sharedFileKindLabel(file: SharedConversationFile): string {
  return file.kind === "input_attachment" ? "输入附件" : "生成文件";
}

function SharedMessageFiles({
  files,
}: {
  files: readonly SharedConversationFile[];
}) {
  if (files.length === 0) {
    return null;
  }

  return (
    <section
      aria-label={`文件元数据，共 ${files.length} 个`}
      className="shared-conversation-message__files"
    >
      <span className="shared-conversation-message__files-label">
        <AttachmentIcon />
        文件
        <small>{files.length}</small>
      </span>
      <ul>
        {files.map((file, index) => {
          const FileIcon =
            file.kind === "input_attachment" ? AttachmentIcon : DocumentIcon;
          return (
            <li
              className="shared-conversation-file"
              key={`${file.kind}-${file.name}-${index}`}
            >
              <span className="shared-conversation-file__icon">
                <FileIcon />
              </span>
              <span className="shared-conversation-file__copy">
                <strong>{file.name}</strong>
                <small>
                  {file.mimeType} · {formatAttachmentBytes(file.sizeBytes)}
                </small>
              </span>
              <span className="shared-conversation-file__kind">
                <small>{sharedFileKindLabel(file)}</small>
                <strong>{sharedFileTypeLabel(file)}</strong>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SharedConversationMessageView({
  message,
}: {
  message: SharedConversationMessage;
}) {
  const citations = prepareInlineCitations(
    message.content,
    message.citations,
  );
  const isAssistant = message.role === "assistant";

  return (
    <li
      className={`shared-conversation-message shared-conversation-message--${message.role}`}
    >
      <article aria-label={isAssistant ? "助手回复" : "用户消息"}>
        {isAssistant ? (
          <span aria-hidden="true" className="shared-conversation-message__mark">
            <BrandMark />
          </span>
        ) : null}
        <div className="shared-conversation-message__body">
          {isAssistant ? (
            <ResearchMarkdown
              citations={citations}
              content={message.content}
              hidePrivateResourceLinks
              highlightCode
            />
          ) : (
            <p className="shared-conversation-message__user-content">
              {message.content}
            </p>
          )}
          <CitationCards citations={citations} />
          <SharedMessageFiles files={message.files} />
          <time dateTime={message.createdAt}>
            {sharedTimestampFormatter.format(new Date(message.createdAt))}
          </time>
        </div>
      </article>
    </li>
  );
}

export function SharedConversationView({
  share,
}: {
  share: PublicConversationShare;
}) {
  const safeMessages = sanitizeConversationShareMessages(share.messages);

  return (
    <main className="shared-conversation-page">
      <header className="shared-conversation-header">
        <Link
          aria-label="返回外贸研究助手"
          className="shared-conversation-brand"
          href="/"
        >
          <span className="shared-conversation-brand__mark">
            <BrandMark />
          </span>
          <span>
            <strong>外贸研究助手</strong>
            <small>TRADE INTELLIGENCE</small>
          </span>
        </Link>
        <span className="shared-conversation-header__badge">
          <ShareIcon />
          只读分享
        </span>
      </header>

      <div className="shared-conversation-page__scroll">
        <section
          aria-labelledby="shared-conversation-title"
          className="shared-conversation-hero"
        >
          <span>共享研究对话</span>
          <h1 id="shared-conversation-title">{share.title}</h1>
          <p>
            这是创建分享时保存的只读快照，不会随原对话继续更新。
          </p>
          <dl>
            <div>
              <dt>创建时间</dt>
              <dd>
                <time dateTime={share.createdAt}>
                  {sharedTimestampFormatter.format(new Date(share.createdAt))}
                </time>
              </dd>
            </div>
            <div>
              <dt>快照时间</dt>
              <dd>
                <time dateTime={share.updatedAt}>
                  {sharedTimestampFormatter.format(new Date(share.updatedAt))}
                </time>
              </dd>
            </div>
          </dl>
        </section>

        <ol aria-label="共享对话消息" className="shared-conversation-messages">
          {safeMessages.map((message) => (
            <SharedConversationMessageView key={message.id} message={message} />
          ))}
        </ol>

        <footer className="shared-conversation-footer">
          <ShareIcon />
          <span>
            <strong>只读共享快照</strong>
            <small>文件仅展示名称、类型与大小，不包含下载入口。</small>
          </span>
        </footer>
      </div>
    </main>
  );
}
