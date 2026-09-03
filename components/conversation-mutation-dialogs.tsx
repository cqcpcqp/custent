"use client";

import {
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from "react";

import { conversationHasOutstandingRuns } from "@/components/conversation-list-state";
import {
  AlertIcon,
  ArchiveIcon,
  CloseIcon,
  PencilIcon,
  TrashIcon,
} from "@/components/icons";
import { useModalFocus } from "@/components/modal-focus";
import type { ConversationSummary } from "@/lib/contracts";

const activeRunMutationMessage =
  "该对话仍有正在运行或等待中的研究，请先停止或取消后再归档或删除。";

export type ConversationBulkAction = "archive_all" | "delete_all";

export type DataControlMutationResult =
  | Readonly<{ conversationCount: number; error: null }>
  | Readonly<{ conversationCount: null; error: string }>;

const conversationBulkActionCopy = {
  archive_all: {
    title: "归档所有对话？",
    description: "所有未归档对话都会移到“已归档”。你可以稍后逐个恢复。",
    headerNote: "之后仍可逐个恢复",
    closeLabel: "关闭归档所有对话确认框",
    confirmLabel: "归档所有对话",
    pendingLabel: "正在归档…",
  },
  delete_all: {
    title: "永久删除所有对话？",
    description:
      "当前账户中的所有对话（包括已归档对话）都会被永久删除，且无法恢复。相关公开共享链接也会立即失效。",
    headerNote: "此操作不可恢复",
    closeLabel: "关闭删除所有对话确认框",
    confirmLabel: "永久删除所有对话",
    pendingLabel: "正在删除…",
  },
} as const satisfies Record<
  ConversationBulkAction,
  Readonly<{
    title: string;
    description: string;
    headerNote: string;
    closeLabel: string;
    confirmLabel: string;
    pendingLabel: string;
  }>
>;

export function RenameConversationDialog({
  conversation,
  isBusy,
  onClose,
  onRename,
}: {
  conversation: ConversationSummary;
  isBusy: boolean;
  onClose: () => void;
  onRename: (
    conversation: ConversationSummary,
    title: string,
  ) => Promise<string | null>;
}) {
  const [title, setTitle] = useState(conversation.title);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const mutationIsBusy = isBusy || isSubmitting;
  const errorId = `rename-conversation-error-${conversation.id}`;
  const descriptionId = `rename-conversation-description-${conversation.id}`;

  useModalFocus({
    backdropRef,
    canClose: !mutationIsBusy,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    onClose,
  });

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !mutationIsBusy) {
      onClose();
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationIsBusy) {
      return;
    }

    const nextTitle = title.trim();
    if (nextTitle.length === 0) {
      setDialogError("请输入对话名称。");
      return;
    }
    if (nextTitle.length > 500) {
      setDialogError("对话名称不能超过 500 个字符。");
      return;
    }

    setIsSubmitting(true);
    setDialogError(null);
    try {
      const mutationError = await onRename(conversation, nextTitle);
      if (mutationError === null) {
        onClose();
      } else {
        setDialogError(mutationError);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="conversation-mutation-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <form
        aria-describedby={descriptionId}
        aria-labelledby="rename-conversation-title"
        aria-modal="true"
        className="conversation-mutation-dialog"
        onSubmit={(event) => void handleSubmit(event)}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="conversation-mutation-dialog__header">
          <span className="conversation-mutation-dialog__icon">
            <PencilIcon />
          </span>
          <span>
            <strong id="rename-conversation-title">重命名对话</strong>
            <small id={descriptionId}>名称会同步显示在侧边栏和搜索结果中</small>
          </span>
          <button
            aria-label="关闭重命名对话框"
            className="icon-button"
            disabled={mutationIsBusy}
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <label className="conversation-mutation-dialog__field">
          <span>对话名称</span>
          <input
            aria-describedby={dialogError === null ? undefined : errorId}
            maxLength={500}
            onChange={(event) => setTitle(event.target.value)}
            ref={inputRef}
            type="text"
            value={title}
          />
        </label>

        {dialogError === null ? null : (
          <div
            className="conversation-mutation-dialog__error"
            id={errorId}
            role="alert"
          >
            <AlertIcon />
            <span>{dialogError}</span>
          </div>
        )}

        <footer className="conversation-mutation-dialog__actions">
          <button
            className="conversation-dialog-button conversation-dialog-button--secondary"
            disabled={mutationIsBusy}
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="conversation-dialog-button conversation-dialog-button--primary"
            disabled={mutationIsBusy}
            type="submit"
          >
            {mutationIsBusy ? "正在保存…" : "保存名称"}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function DeleteConversationDialog({
  conversation,
  isBusy,
  onClose,
  onDelete,
}: {
  conversation: ConversationSummary;
  isBusy: boolean;
  onClose: () => void;
  onDelete: (conversation: ConversationSummary) => Promise<string | null>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const mutationIsBusy = isBusy || isSubmitting;
  const hasOutstandingRun = conversationHasOutstandingRuns(conversation);
  const descriptionId = `delete-conversation-description-${conversation.id}`;

  useModalFocus({
    backdropRef,
    canClose: !mutationIsBusy,
    containerRef: dialogRef,
    initialFocusRef: cancelButtonRef,
    onClose,
  });

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !mutationIsBusy) {
      onClose();
    }
  }

  async function handleDelete() {
    if (mutationIsBusy) {
      return;
    }
    if (hasOutstandingRun) {
      setDialogError(activeRunMutationMessage);
      return;
    }

    setIsSubmitting(true);
    setDialogError(null);
    try {
      const mutationError = await onDelete(conversation);
      if (mutationError === null) {
        onClose();
      } else {
        setDialogError(mutationError);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="conversation-mutation-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-describedby={descriptionId}
        aria-labelledby="delete-conversation-title"
        aria-modal="true"
        className="conversation-mutation-dialog conversation-mutation-dialog--danger"
        ref={dialogRef}
        role="alertdialog"
        tabIndex={-1}
      >
        <header className="conversation-mutation-dialog__header">
          <span className="conversation-mutation-dialog__icon">
            <TrashIcon />
          </span>
          <span>
            <strong id="delete-conversation-title">永久删除这个对话？</strong>
            <small>此操作不可恢复</small>
          </span>
          <button
            aria-label="关闭删除确认框"
            className="icon-button"
            disabled={mutationIsBusy}
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <div
          className="conversation-mutation-dialog__body"
          id={descriptionId}
        >
          <p>
            将永久删除“<strong>{conversation.title}</strong>”及其全部消息、研究活动和生成记录。
          </p>
          <p className="conversation-mutation-dialog__warning">
            <AlertIcon />
            删除后无法撤销，请确认这是你想删除的对话。
          </p>
        </div>

        {hasOutstandingRun || dialogError !== null ? (
          <div className="conversation-mutation-dialog__error" role="alert">
            <AlertIcon />
            <span>
              {hasOutstandingRun ? activeRunMutationMessage : dialogError}
            </span>
          </div>
        ) : null}

        <footer className="conversation-mutation-dialog__actions">
          <button
            className="conversation-dialog-button conversation-dialog-button--secondary"
            disabled={mutationIsBusy}
            onClick={onClose}
            ref={cancelButtonRef}
            type="button"
          >
            取消
          </button>
          <button
            className="conversation-dialog-button conversation-dialog-button--danger"
            disabled={mutationIsBusy || hasOutstandingRun}
            onClick={() => void handleDelete()}
            type="button"
          >
            {mutationIsBusy ? "正在删除…" : "永久删除"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function ConversationBulkActionDialog({
  action,
  onClose,
  onComplete,
  onConfirm,
  returnFocusRef,
}: {
  action: ConversationBulkAction;
  onClose: () => void;
  onComplete: (conversationCount: number) => void;
  onConfirm: () => Promise<DataControlMutationResult>;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const copy = conversationBulkActionCopy[action];
  const descriptionId = "conversation-bulk-action-description";
  const errorId = "conversation-bulk-action-error";

  useModalFocus({
    backdropRef,
    canClose: !isSubmitting,
    containerRef: dialogRef,
    initialFocusRef: cancelButtonRef,
    onClose,
    returnFocusRef,
  });

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) {
      return;
    }
    event.preventDefault();
    if (!isSubmitting) {
      onClose();
    }
  }

  async function handleConfirm() {
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setDialogError(null);
    try {
      const result = await onConfirm();
      if (result.error === null) {
        onComplete(result.conversationCount);
      } else {
        setDialogError(result.error);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const BulkActionIcon =
    action === "archive_all" ? ArchiveIcon : TrashIcon;
  const dialogRole = action === "archive_all" ? "dialog" : "alertdialog";

  return (
    <div
      className="conversation-mutation-backdrop settings-conversation-bulk-action-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-busy={isSubmitting}
        aria-describedby={
          dialogError === null
            ? descriptionId
            : `${descriptionId} ${errorId}`
        }
        aria-labelledby="conversation-bulk-action-title"
        aria-modal="true"
        className={`conversation-mutation-dialog${
          action === "delete_all"
            ? " conversation-mutation-dialog--danger"
            : ""
        }`}
        id="conversation-bulk-action-dialog"
        ref={dialogRef}
        role={dialogRole}
        tabIndex={-1}
      >
        <header className="conversation-mutation-dialog__header">
          <span className="conversation-mutation-dialog__icon">
            <BulkActionIcon />
          </span>
          <span>
            <strong id="conversation-bulk-action-title">{copy.title}</strong>
            <small>{copy.headerNote}</small>
          </span>
          <button
            aria-label={copy.closeLabel}
            className="icon-button"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <div
          className="conversation-mutation-dialog__body"
          id={descriptionId}
        >
          <p>{copy.description}</p>
          {action === "delete_all" ? (
            <p className="conversation-mutation-dialog__warning">
              <AlertIcon />
              此操作不可撤销。
            </p>
          ) : null}
        </div>

        {dialogError === null ? null : (
          <div
            className="conversation-mutation-dialog__error"
            id={errorId}
            role="alert"
          >
            <AlertIcon />
            <span>{dialogError}</span>
          </div>
        )}

        <footer className="conversation-mutation-dialog__actions">
          <button
            className="conversation-dialog-button conversation-dialog-button--secondary"
            disabled={isSubmitting}
            onClick={onClose}
            ref={cancelButtonRef}
            type="button"
          >
            取消
          </button>
          <button
            className={`conversation-dialog-button ${
              action === "delete_all"
                ? "conversation-dialog-button--danger"
                : "conversation-dialog-button--primary"
            }`}
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
            type="button"
          >
            {isSubmitting ? copy.pendingLabel : copy.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
