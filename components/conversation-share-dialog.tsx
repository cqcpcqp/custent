"use client";

import {
  type MouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  getConversationShare,
  isApiAbortError,
  putConversationShare,
  revokeConversationShare,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import { conversationHasOutstandingRuns } from "@/components/conversation-list-state";
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  ExternalLinkIcon,
  RefreshIcon,
  ShareIcon,
  TrashIcon,
} from "@/components/icons";
import { useModalFocus } from "@/components/modal-focus";
import type {
  ConversationShareSummary,
  ConversationSummary,
} from "@/lib/contracts";

export type ConversationShareLoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{
      status: "ready";
      share: ConversationShareSummary | null;
    }>;

export type ConversationShareMutation = "publish" | "revoke" | null;

export type ConversationShareCopyState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "copying" }>
  | Readonly<{ status: "copied"; message: string }>
  | Readonly<{ status: "error"; message: string }>;

export type ConversationShareClipboard = Pick<Clipboard, "writeText">;

export type ConversationShareCopyResult =
  | Readonly<{ status: "copied"; message: string }>
  | Readonly<{ status: "error"; message: string }>;

const shareUpdatedAtFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
});

const activeRunShareMessage =
  "研究正在运行或等待中，完成或停止后才能创建或更新分享快照。";
const emptyConversationShareMessage =
  "空对话不能分享。请先完成至少一轮研究。";

const subscribeToBrowserOrigin = () => () => {};
const browserOriginSnapshot = () => window.location.origin;
const serverOriginSnapshot = () => "";

export function conversationSharePublishDisabledReason(
  conversation: ConversationSummary,
): string | null {
  if (conversationHasOutstandingRuns(conversation)) {
    return activeRunShareMessage;
  }
  if (conversation.selectedRunId === null) {
    return emptyConversationShareMessage;
  }
  return null;
}

export function conversationSharePublicUrl(
  publicPath: string,
  origin: string,
): string {
  return new URL(publicPath, origin).toString();
}

export async function copyConversationShareUrl(
  publicPath: string,
  origin: string,
  clipboard: ConversationShareClipboard | null,
): Promise<ConversationShareCopyResult> {
  if (clipboard === null) {
    return {
      status: "error",
      message: "当前浏览器不支持复制，请手动选择链接。",
    };
  }

  try {
    await clipboard.writeText(conversationSharePublicUrl(publicPath, origin));
    return { status: "copied", message: "分享链接已复制" };
  } catch {
    return {
      status: "error",
      message: "复制失败，请检查剪贴板权限后重试。",
    };
  }
}

function conversationShareErrorMessage(error: unknown): string {
  return userFacingRequestErrorMessage(
    error,
    "分享请求暂时失败，请稍后重试。",
  );
}

function assertShareConversation(
  conversationId: string,
  share: ConversationShareSummary | null,
): void {
  if (share !== null && share.conversationId !== conversationId) {
    throw new Error("分享接口返回了不一致的 conversationId");
  }
}

export function ConversationShareReadyContent({
  cancelRevokeButtonRef,
  createShareButtonRef,
  copyState,
  isConfirmingRevoke,
  mutation,
  notice,
  onCancelRevoke,
  onCopy,
  onPublish,
  onRequestRevoke,
  onRevoke,
  operationError,
  publicUrl,
  publishDisabledReason,
  revokeButtonRef,
  share,
}: {
  cancelRevokeButtonRef?: RefObject<HTMLButtonElement | null>;
  createShareButtonRef?: RefObject<HTMLButtonElement | null>;
  copyState: ConversationShareCopyState;
  isConfirmingRevoke: boolean;
  mutation: ConversationShareMutation;
  notice: string | null;
  onCancelRevoke: () => void;
  onCopy: () => void;
  onPublish: () => void;
  onRequestRevoke: () => void;
  onRevoke: () => void;
  operationError: string | null;
  publicUrl: string | null;
  publishDisabledReason: string | null;
  revokeButtonRef?: RefObject<HTMLButtonElement | null>;
  share: ConversationShareSummary | null;
}) {
  const isBusy = mutation !== null;

  if (share === null) {
    return (
      <div className="conversation-share-dialog__body">
        <div className="conversation-share-dialog__empty">
          <span className="conversation-share-dialog__empty-icon">
            <ShareIcon />
          </span>
          <strong>创建只读分享链接</strong>
          <p>
            链接保存创建时选中分支的对话快照。后续消息不会自动同步，
            你可以随时回来更新或撤销。
          </p>
        </div>

        {publishDisabledReason === null ? null : (
          <p className="conversation-share-dialog__disabled" role="status">
            {publishDisabledReason}
          </p>
        )}
        {operationError === null ? null : (
          <div className="conversation-share-dialog__error" role="alert">
            <AlertIcon />
            <span>{operationError}</span>
          </div>
        )}
        {notice === null ? null : (
          <p className="conversation-share-dialog__notice" role="status">
            <CheckIcon />
            <span>{notice}</span>
          </p>
        )}

        <footer className="conversation-share-dialog__actions">
          <button
            className="conversation-dialog-button conversation-dialog-button--primary conversation-share-dialog__publish"
            disabled={isBusy || publishDisabledReason !== null}
            onClick={onPublish}
            ref={createShareButtonRef}
            type="button"
          >
            <ShareIcon />
            {mutation === "publish" ? "正在创建…" : "创建分享链接"}
          </button>
        </footer>
      </div>
    );
  }

  if (publicUrl === null) {
    throw new Error("已有分享缺少公开链接");
  }

  return (
    <div className="conversation-share-dialog__body">
      <div className="conversation-share-dialog__link-section">
        <label htmlFor={`conversation-share-url-${share.conversationId}`}>
          任何获得此链接的人都可以查看只读快照
        </label>
        <div className="conversation-share-dialog__link-row">
          <input
            aria-label="分享链接"
            id={`conversation-share-url-${share.conversationId}`}
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            type="text"
            value={publicUrl}
          />
          <button
            aria-label={
              copyState.status === "copying"
                ? "正在复制分享链接"
                : copyState.status === "copied"
                  ? "分享链接已复制"
                  : "复制分享链接"
            }
            className="conversation-share-dialog__copy"
            disabled={copyState.status === "copying" || isBusy}
            onClick={onCopy}
            type="button"
          >
            {copyState.status === "copied" ? <CheckIcon /> : <CopyIcon />}
            <span>
              {copyState.status === "copying"
                ? "复制中…"
                : copyState.status === "copied"
                  ? "已复制"
                  : "复制"}
            </span>
          </button>
        </div>
        <div className="conversation-share-dialog__link-meta">
          <span>
            上次更新 {shareUpdatedAtFormatter.format(new Date(share.updatedAt))}
          </span>
          <a href={share.publicPath} rel="noreferrer" target="_blank">
            打开分享页
            <ExternalLinkIcon />
          </a>
        </div>
      </div>

      <p className="conversation-share-dialog__snapshot-note">
        分享页不会自动包含后续消息。选择“更新快照”会保留当前链接，
        并用当前选中的对话分支替换其内容。
      </p>

      {publishDisabledReason === null ? null : (
        <p className="conversation-share-dialog__disabled" role="status">
          {publishDisabledReason}
        </p>
      )}
      {operationError === null ? null : (
        <div className="conversation-share-dialog__error" role="alert">
          <AlertIcon />
          <span>{operationError}</span>
        </div>
      )}
      {copyState.status === "error" ? (
        <div className="conversation-share-dialog__error" role="alert">
          <AlertIcon />
          <span>{copyState.message}</span>
        </div>
      ) : null}
      {notice === null ? null : (
        <p className="conversation-share-dialog__notice" role="status">
          <CheckIcon />
          <span>{notice}</span>
        </p>
      )}

      {isConfirmingRevoke ? (
        <div
          className="conversation-share-dialog__revoke-confirmation"
          role="alert"
        >
          <span>
            <strong>撤销这个公开链接？</strong>
            <small>当前链接将立即失效；之后重新分享会创建新链接。</small>
          </span>
          <span className="conversation-share-dialog__revoke-actions">
            <button
              className="conversation-dialog-button conversation-dialog-button--secondary"
              disabled={isBusy}
              onClick={onCancelRevoke}
              ref={cancelRevokeButtonRef}
              type="button"
            >
              取消
            </button>
            <button
              className="conversation-dialog-button conversation-dialog-button--danger"
              disabled={isBusy}
              onClick={onRevoke}
              type="button"
            >
              {mutation === "revoke" ? "正在撤销…" : "确认撤销"}
            </button>
          </span>
        </div>
      ) : (
        <footer className="conversation-share-dialog__actions conversation-share-dialog__actions--split">
          <button
            className="conversation-share-dialog__revoke"
            disabled={isBusy}
            onClick={onRequestRevoke}
            ref={revokeButtonRef}
            type="button"
          >
            <TrashIcon />
            撤销链接
          </button>
          <button
            className="conversation-dialog-button conversation-dialog-button--primary"
            disabled={isBusy || publishDisabledReason !== null}
            onClick={onPublish}
            type="button"
          >
            <RefreshIcon />
            {mutation === "publish" ? "正在更新…" : "更新快照"}
          </button>
        </footer>
      )}
    </div>
  );
}

function ConversationShareDialogContent({
  conversation,
  onClose,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
}) {
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadState, setLoadState] = useState<ConversationShareLoadState>({
    status: "loading",
  });
  const [mutation, setMutation] =
    useState<ConversationShareMutation>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<ConversationShareCopyState>({
    status: "idle",
  });
  const [isConfirmingRevoke, setIsConfirmingRevoke] = useState(false);
  const origin = useSyncExternalStore(
    subscribeToBrowserOrigin,
    browserOriginSnapshot,
    serverOriginSnapshot,
  );
  const backdropRef = useRef<HTMLDivElement>(null);
  const cancelRevokeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const createShareButtonRef = useRef<HTMLButtonElement>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const previousIsConfirmingRevokeRef = useRef(isConfirmingRevoke);
  const previousReadyShareRef = useRef<ConversationShareSummary | null>(null);
  const revokeButtonRef = useRef<HTMLButtonElement>(null);
  const isBusy = mutation !== null;
  const descriptionId = `conversation-share-description-${conversation.id}`;
  const titleId = `conversation-share-title-${conversation.id}`;
  const publishDisabledReason =
    conversationSharePublishDisabledReason(conversation);

  useModalFocus({
    backdropRef,
    canClose: !isBusy,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onClose,
  });

  useEffect(() => {
    const controller = new AbortController();

    void getConversationShare(conversation.id, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        assertShareConversation(conversation.id, response.share);
        setLoadState({ status: "ready", share: response.share });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isApiAbortError(error)) {
          setLoadState({
            status: "error",
            message: conversationShareErrorMessage(error),
          });
        }
      });

    return () => controller.abort();
  }, [conversation.id, loadRevision]);

  useEffect(
    () => () => {
      mutationControllerRef.current?.abort();
    },
    [],
  );

  useLayoutEffect(() => {
    const previousIsConfirmingRevoke = previousIsConfirmingRevokeRef.current;
    const previousShare = previousReadyShareRef.current;
    const currentShare = loadState.status === "ready" ? loadState.share : null;
    previousIsConfirmingRevokeRef.current = isConfirmingRevoke;
    previousReadyShareRef.current = currentShare;

    if (!previousIsConfirmingRevoke && isConfirmingRevoke) {
      cancelRevokeButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    if (
      previousIsConfirmingRevoke &&
      !isConfirmingRevoke &&
      currentShare !== null
    ) {
      revokeButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    if (previousShare !== null && currentShare === null) {
      createShareButtonRef.current?.focus({ preventScroll: true });
    }
  }, [isConfirmingRevoke, loadState]);

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !isBusy) {
      event.preventDefault();
      onClose();
    }
  }

  async function handlePublish() {
    if (
      loadState.status !== "ready" ||
      mutation !== null ||
      publishDisabledReason !== null
    ) {
      return;
    }

    const wasShared = loadState.share !== null;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setMutation("publish");
    setOperationError(null);
    setNotice(null);
    setCopyState({ status: "idle" });
    setIsConfirmingRevoke(false);
    try {
      const response = await putConversationShare(
        conversation.id,
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      assertShareConversation(conversation.id, response.share);
      setLoadState({ status: "ready", share: response.share });
      setNotice(wasShared ? "分享快照已更新" : "分享链接已创建");
    } catch (error) {
      if (!controller.signal.aborted && !isApiAbortError(error)) {
        setOperationError(conversationShareErrorMessage(error));
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        if (!controller.signal.aborted) {
          setMutation(null);
        }
      }
    }
  }

  async function handleRevoke() {
    if (
      loadState.status !== "ready" ||
      loadState.share === null ||
      mutation !== null
    ) {
      return;
    }

    const currentShare = loadState.share;
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setMutation("revoke");
    setOperationError(null);
    setNotice(null);
    try {
      const response = await revokeConversationShare(
        conversation.id,
        currentShare.publicId,
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      if (response.revocation.conversationId !== conversation.id) {
        throw new Error("撤销分享返回了不一致的 conversationId");
      }
      if (response.revocation.publicId !== currentShare.publicId) {
        throw new Error("撤销分享返回了不一致的 publicId");
      }
      setLoadState({ status: "ready", share: null });
      setIsConfirmingRevoke(false);
      setNotice("分享链接已撤销");
      setCopyState({ status: "idle" });
    } catch (error) {
      if (!controller.signal.aborted && !isApiAbortError(error)) {
        setOperationError(conversationShareErrorMessage(error));
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        if (!controller.signal.aborted) {
          setMutation(null);
        }
      }
    }
  }

  async function handleCopy() {
    if (loadState.status !== "ready" || loadState.share === null || isBusy) {
      return;
    }
    setCopyState({ status: "copying" });
    const result = await copyConversationShareUrl(
      loadState.share.publicPath,
      window.location.origin,
      navigator.clipboard ?? null,
    );
    setCopyState(result);
  }

  function handleRetryLoad() {
    setLoadState({ status: "loading" });
    setOperationError(null);
    setNotice(null);
    setCopyState({ status: "idle" });
    setIsConfirmingRevoke(false);
    setLoadRevision((current) => current + 1);
  }

  const readyShare = loadState.status === "ready" ? loadState.share : null;
  const publicUrl =
    readyShare === null
      ? null
      : origin.length === 0
        ? readyShare.publicPath
        : conversationSharePublicUrl(readyShare.publicPath, origin);

  return (
    <div
      className="conversation-mutation-backdrop conversation-share-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-busy={isBusy}
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="conversation-mutation-dialog conversation-share-dialog"
        id="conversation-share-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="conversation-mutation-dialog__header">
          <span className="conversation-mutation-dialog__icon">
            <ShareIcon />
          </span>
          <span>
            <strong id={titleId}>分享对话</strong>
            <small id={descriptionId} title={conversation.title}>
              {conversation.title}
            </small>
          </span>
          <button
            aria-label="关闭分享对话框"
            className="icon-button"
            disabled={isBusy}
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        {loadState.status === "loading" ? (
          <div
            aria-live="polite"
            className="conversation-share-dialog__loading"
            role="status"
          >
            <span aria-hidden="true" />
            <strong>正在载入分享状态</strong>
          </div>
        ) : loadState.status === "error" ? (
          <div className="conversation-share-dialog__load-error" role="alert">
            <AlertIcon />
            <strong>暂时无法载入分享状态</strong>
            <p>{loadState.message}</p>
            <button
              className="conversation-dialog-button conversation-dialog-button--secondary"
              onClick={handleRetryLoad}
              type="button"
            >
              <RefreshIcon />
              重试
            </button>
          </div>
        ) : (
          <ConversationShareReadyContent
            cancelRevokeButtonRef={cancelRevokeButtonRef}
            copyState={copyState}
            createShareButtonRef={createShareButtonRef}
            isConfirmingRevoke={isConfirmingRevoke}
            mutation={mutation}
            notice={notice}
            onCancelRevoke={() => setIsConfirmingRevoke(false)}
            onCopy={() => void handleCopy()}
            onPublish={() => void handlePublish()}
            onRequestRevoke={() => {
              setOperationError(null);
              setNotice(null);
              setIsConfirmingRevoke(true);
            }}
            onRevoke={() => void handleRevoke()}
            operationError={operationError}
            publicUrl={publicUrl}
            publishDisabledReason={publishDisabledReason}
            revokeButtonRef={revokeButtonRef}
            share={loadState.share}
          />
        )}
      </section>
    </div>
  );
}

export function ConversationShareDialog({
  conversation,
  onClose,
}: {
  conversation: ConversationSummary;
  onClose: () => void;
}) {
  return (
    <ConversationShareDialogContent
      conversation={conversation}
      key={conversation.id}
      onClose={onClose}
    />
  );
}
