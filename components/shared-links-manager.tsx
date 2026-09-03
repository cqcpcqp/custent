"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  listConversationShares,
  revokeConversationShare,
} from "@/components/api-client";
import {
  AlertIcon,
  CheckIcon,
  ExternalLinkIcon,
  RefreshIcon,
  ShareIcon,
  TrashIcon,
} from "@/components/icons";
import {
  formatSharedLinkDate,
  sharedLinksErrorMessage,
  sharedLinksInitialPageRequest,
  sharedLinksIsAbortError,
  sharedLinksMergeContinuation,
  sharedLinksMergePage,
  sharedLinksNextPageRequest,
  sharedLinksResultSurface,
  sharedLinksWithoutRevokedItem,
} from "@/components/shared-links-manager-state";
import type {
  ConversationShareListItem,
  ListConversationSharesResponse,
} from "@/lib/contracts";

type SharedLinkMutationError = Readonly<{
  publicId: string;
  message: string;
}>;

export type SharedLinksManagerReadyContentProps = Readonly<{
  confirmingPublicId: string | null;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  mutationError: SharedLinkMutationError | null;
  notice: string | null;
  onCancelRevoke: () => void;
  onConfirmRevoke: (item: ConversationShareListItem) => void;
  onLoadMore: () => void;
  onReload: () => void;
  onRequestRevoke: (publicId: string) => void;
  page: ListConversationSharesResponse;
  pendingPublicId: string | null;
}>;

export function SharedLinksManagerReadyContent({
  confirmingPublicId,
  isLoadingMore,
  loadMoreError,
  mutationError,
  notice,
  onCancelRevoke,
  onConfirmRevoke,
  onLoadMore,
  onReload,
  onRequestRevoke,
  page,
  pendingPublicId,
}: SharedLinksManagerReadyContentProps) {
  const isMutating = pendingPublicId !== null;

  return (
    <section
      aria-busy={isLoadingMore || isMutating}
      aria-labelledby="shared-links-manager-heading"
      className="shared-links-manager"
    >
      <header className="shared-links-manager__intro">
        <span>
          <strong id="shared-links-manager-heading">当前共享链接</strong>
          <small>任何获得链接的人都能查看对应的只读对话快照。</small>
        </span>
        <button
          aria-label="重新加载共享链接"
          disabled={isLoadingMore || isMutating}
          onClick={onReload}
          type="button"
        >
          <RefreshIcon />
          刷新
        </button>
      </header>

      {notice === null ? null : (
        <p className="shared-links-manager__notice" role="status">
          <CheckIcon />
          {notice}
        </p>
      )}

      {page.items.length === 0 && page.nextCursor === null ? (
        <div className="shared-links-manager__empty" role="status">
          <ShareIcon />
          <strong>还没有共享链接</strong>
          <span>从任意非空且没有运行中任务的对话创建分享后，会显示在这里。</span>
        </div>
      ) : (
        <ol aria-label="共享链接" className="shared-links-manager__list">
          {page.items.map((item) => {
            const isConfirming = confirmingPublicId === item.publicId;
            const isPending = pendingPublicId === item.publicId;
            const itemError =
              mutationError?.publicId === item.publicId
                ? mutationError.message
                : null;

            return (
              <li className="shared-links-manager__item" key={item.publicId}>
                <div className="shared-links-manager__item-main">
                  <span className="shared-links-manager__item-icon">
                    <ShareIcon />
                  </span>
                  <span className="shared-links-manager__item-copy">
                    <strong title={item.title}>{item.title}</strong>
                    <small>
                      更新于{" "}
                      <time dateTime={item.updatedAt}>
                        {formatSharedLinkDate(item.updatedAt)}
                      </time>
                    </small>
                  </span>
                  <a
                    aria-label={`打开共享链接“${item.title}”`}
                    href={item.publicPath}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLinkIcon />
                    <span>打开</span>
                  </a>
                  <button
                    aria-label={`撤销共享链接“${item.title}”`}
                    disabled={isLoadingMore || isMutating}
                    onClick={() => onRequestRevoke(item.publicId)}
                    type="button"
                  >
                    <TrashIcon />
                    <span>撤销</span>
                  </button>
                </div>

                {itemError === null ? null : (
                  <p className="shared-links-manager__item-error" role="alert">
                    <AlertIcon />
                    {itemError}
                  </p>
                )}

                {isConfirming ? (
                  <div
                    className="shared-links-manager__confirmation"
                    role="alert"
                  >
                    <span>
                      <strong>撤销这个公开链接？</strong>
                      <small>链接将立即失效；以后重新分享会生成新链接。</small>
                    </span>
                    <span>
                      <button
                        disabled={isMutating}
                        onClick={onCancelRevoke}
                        type="button"
                      >
                        取消
                      </button>
                      <button
                        className="shared-links-manager__confirm-revoke"
                        disabled={isLoadingMore || isMutating}
                        onClick={() => onConfirmRevoke(item)}
                        type="button"
                      >
                        {isPending ? "正在撤销…" : "确认撤销"}
                      </button>
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {loadMoreError === null ? null : (
        <p className="shared-links-manager__load-more-error" role="alert">
          加载更多失败：{loadMoreError}
        </p>
      )}
      {page.nextCursor === null ? null : (
        <button
          aria-label={
            loadMoreError === null
              ? "加载更多共享链接"
              : "重试加载更多共享链接"
          }
          className="shared-links-manager__load-more"
          disabled={isLoadingMore || isMutating}
          onClick={onLoadMore}
          type="button"
        >
          {isLoadingMore
            ? "正在加载…"
            : loadMoreError === null
              ? "加载更多"
              : "重试加载更多"}
        </button>
      )}
    </section>
  );
}

export function SharedLinksManager() {
  const [page, setPage] = useState<ListConversationSharesResponse | null>(null);
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [initialLoadRevision, setInitialLoadRevision] = useState(0);
  const [loadingMoreCursor, setLoadingMoreCursor] = useState<string | null>(
    null,
  );
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [confirmingPublicId, setConfirmingPublicId] = useState<string | null>(
    null,
  );
  const [pendingPublicId, setPendingPublicId] = useState<string | null>(null);
  const [mutationError, setMutationError] =
    useState<SharedLinkMutationError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const isLoadingMore = loadingMoreCursor !== null;
  const shouldAutoFill =
    page !== null &&
    page.items.length === 0 &&
    page.nextCursor !== null &&
    loadingMoreCursor === null &&
    loadMoreError === null &&
    initialLoadError === null;
  const resultSurface = sharedLinksResultSurface({
    isLoading: page === null && initialLoadError === null,
    loadError: initialLoadError,
    itemCount: page?.items.length ?? 0,
    hasNextPage: page?.nextCursor !== null && page?.nextCursor !== undefined,
  });

  useEffect(() => {
    const controller = new AbortController();
    void listConversationShares(
      sharedLinksInitialPageRequest(),
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        setPage({
          ...response,
          items: sharedLinksMergePage([], response.items),
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !sharedLinksIsAbortError(error)) {
          setInitialLoadError(sharedLinksErrorMessage(error));
        }
      });
    return () => controller.abort();
  }, [initialLoadRevision]);

  useEffect(
    () => () => {
      loadMoreControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
    },
    [],
  );

  const handleLoadMore = useCallback(async () => {
    if (
      page === null ||
      page.nextCursor === null ||
      loadMoreControllerRef.current !== null ||
      mutationControllerRef.current !== null
    ) {
      return;
    }
    const cursor = page.nextCursor;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadingMoreCursor(cursor);
    setLoadMoreError(null);
    try {
      const response = await listConversationShares(
        sharedLinksNextPageRequest(cursor),
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      setPage((current) =>
        current === null
          ? current
          : sharedLinksMergeContinuation(current, cursor, response),
      );
    } catch (error) {
      if (!controller.signal.aborted && !sharedLinksIsAbortError(error)) {
        const message = sharedLinksErrorMessage(error);
        if (page.items.length === 0) {
          setPage(null);
          setInitialLoadError(message);
        } else {
          setLoadMoreError(message);
        }
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMoreCursor(null);
      }
    }
  }, [page]);

  useEffect(() => {
    if (!shouldAutoFill) {
      return;
    }
    const timeoutId = window.setTimeout(() => void handleLoadMore(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [handleLoadMore, shouldAutoFill]);

  function handleReload() {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setPage(null);
    setInitialLoadError(null);
    setLoadingMoreCursor(null);
    setLoadMoreError(null);
    setConfirmingPublicId(null);
    setMutationError(null);
    setNotice(null);
    setInitialLoadRevision((current) => current + 1);
  }

  async function handleRevoke(item: ConversationShareListItem) {
    if (
      pendingPublicId !== null ||
      mutationControllerRef.current !== null ||
      loadMoreControllerRef.current !== null
    ) {
      return;
    }
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    setPendingPublicId(item.publicId);
    setMutationError(null);
    setNotice(null);
    try {
      const response = await revokeConversationShare(
        item.conversationId,
        item.publicId,
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      if (
        response.revocation.conversationId !== item.conversationId ||
        response.revocation.publicId !== item.publicId
      ) {
        throw new Error("撤销分享返回了不一致的链接标识");
      }
      setPage((current) =>
        current === null
          ? current
          : {
              ...current,
              items: sharedLinksWithoutRevokedItem(
                current.items,
                item.publicId,
              ),
            },
      );
      setConfirmingPublicId(null);
      setNotice(`已撤销“${item.title}”的共享链接`);
    } catch (error) {
      if (!controller.signal.aborted && !sharedLinksIsAbortError(error)) {
        setMutationError({
          publicId: item.publicId,
          message: sharedLinksErrorMessage(error),
        });
      }
    } finally {
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
        setPendingPublicId(null);
      }
    }
  }

  if (resultSurface === "loading") {
    return (
      <div className="shared-links-manager__loading" role="status">
        <span aria-hidden="true" />
        <strong>正在加载共享链接</strong>
      </div>
    );
  }

  if (resultSurface === "failure" && initialLoadError !== null) {
    return (
      <div className="shared-links-manager__failure" role="alert">
        <AlertIcon />
        <strong>暂时无法加载共享链接</strong>
        <p>{initialLoadError}</p>
        <button onClick={handleReload} type="button">
          <RefreshIcon />
          重新加载
        </button>
      </div>
    );
  }

  if (page === null) {
    throw new Error("共享链接管理缺少已加载页面");
  }

  return (
    <SharedLinksManagerReadyContent
      confirmingPublicId={confirmingPublicId}
      isLoadingMore={isLoadingMore || shouldAutoFill}
      loadMoreError={loadMoreError}
      mutationError={mutationError}
      notice={notice}
      onCancelRevoke={() => setConfirmingPublicId(null)}
      onConfirmRevoke={(item) => void handleRevoke(item)}
      onLoadMore={() => void handleLoadMore()}
      onReload={handleReload}
      onRequestRevoke={(publicId) => {
        if (loadMoreControllerRef.current !== null) {
          return;
        }
        setMutationError(null);
        setNotice(null);
        setConfirmingPublicId(publicId);
      }}
      page={page}
      pendingPublicId={pendingPublicId}
    />
  );
}
