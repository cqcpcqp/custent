"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
} from "react";

import {
  isApiAbortError,
  listConversations,
  userFacingRequestErrorMessage,
} from "@/components/api-client";
import {
  conversationHasOutstandingRuns,
  conversationOutstandingRunStatus,
  nextSearchResultIndex,
} from "@/components/conversation-list-state";
import {
  AlertIcon,
  ArchiveIcon,
  ChatIcon,
  CloseIcon,
  PinIcon,
  RefreshIcon,
  RestoreIcon,
  SearchIcon,
  TrashIcon,
} from "@/components/icons";
import { useModalFocus } from "@/components/modal-focus";
import {
  conversationSummaryFromListItem,
  type ConversationListItem,
  type ConversationListView,
  type ConversationSearchExcerpt,
  type ConversationSearchMatch,
  type ConversationSummary,
} from "@/lib/contracts";

const pageSize = 20;
const queryDebounceMilliseconds = 300;
const loadMoreScrollThreshold = 96;

const conversationBrowserDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

type VerticalBoundsElement = {
  getBoundingClientRect: () => Pick<DOMRectReadOnly, "bottom" | "top">;
};

type RevealableConversationBrowserResult = VerticalBoundsElement & {
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
};

export type ConversationBrowserResultSurface =
  | "loading"
  | "failure"
  | "empty"
  | "results";

export function conversationBrowserInitialPageRequest(
  view: ConversationListView,
  query: string,
): Parameters<typeof listConversations>[0] {
  return { view, query, cursor: null, limit: pageSize };
}

export function conversationBrowserResultId(conversationId: string): string {
  return `conversation-search-result-${conversationId}`;
}

export function conversationBrowserEnterResultIndex(
  highlightedIndex: number,
  resultCount: number,
): number {
  if (resultCount === 0) {
    return -1;
  }
  return highlightedIndex < 0 || highlightedIndex >= resultCount
    ? 0
    : highlightedIndex;
}

export function conversationBrowserQueryIsPending(
  queryInput: string,
  committedQuery: string,
): boolean {
  return queryInput.trim() !== committedQuery;
}

export function conversationBrowserSearchMatch(
  item: ConversationListItem,
  query: string,
): ConversationSearchMatch | null {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    if (item.searchMatch !== null) {
      throw new Error("空搜索结果不应包含 searchMatch");
    }
    return null;
  }
  if (item.searchMatch === null) {
    throw new Error("非空搜索结果缺少固定的 searchMatch");
  }
  return item.searchMatch;
}

export type ConversationBrowserSelection = Readonly<{
  conversation: ConversationSummary;
  searchMatch: ConversationSearchMatch | null;
}>;

export function conversationBrowserSelection(
  item: ConversationListItem,
  query: string,
): ConversationBrowserSelection {
  return {
    conversation: conversationSummaryFromListItem(item),
    searchMatch: conversationBrowserSearchMatch(item, query),
  };
}

export function conversationBrowserMergePage(
  current: ConversationListItem[],
  incoming: ConversationListItem[],
): ConversationListItem[] {
  const incomingById = new Map(
    incoming.map((conversation) => [conversation.id, conversation]),
  );
  const merged = current.map(
    (conversation) => incomingById.get(conversation.id) ?? conversation,
  );
  const currentIds = new Set(
    current.map((conversation) => conversation.id),
  );
  for (const conversation of incoming) {
    if (!currentIds.has(conversation.id)) {
      merged.push(conversation);
    }
  }
  return merged;
}

export function ConversationBrowserSearchExcerpt({
  excerpt,
}: {
  excerpt: ConversationSearchExcerpt;
}) {
  return (
    <>
      {excerpt.beforeTruncated ? "…" : null}
      {excerpt.before}
      <mark>{excerpt.match}</mark>
      {excerpt.after}
      {excerpt.afterTruncated ? "…" : null}
    </>
  );
}

export function conversationBrowserResultIndexForKey(
  key: string,
  highlightedIndex: number,
  resultCount: number,
): number | null {
  if (resultCount === 0) {
    return null;
  }
  switch (key) {
    case "ArrowDown":
      return nextSearchResultIndex(highlightedIndex, resultCount, "down");
    case "ArrowUp":
      return nextSearchResultIndex(highlightedIndex, resultCount, "up");
    default:
      return null;
  }
}

export function conversationBrowserViewForTabKey(
  currentView: ConversationListView,
  key: string,
): ConversationListView | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowRight":
      return currentView === "active" ? "archived" : "active";
    case "Home":
      return "active";
    case "End":
      return "archived";
    default:
      return null;
  }
}

export function conversationBrowserScrollIsNearEnd({
  clientHeight,
  scrollHeight,
  scrollTop,
}: {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= loadMoreScrollThreshold;
}

export function formatConversationBrowserDate(updatedAt: string): string {
  return conversationBrowserDateFormatter.format(new Date(updatedAt));
}

export function revealConversationBrowserResultIfOutsideViewport(
  viewport: VerticalBoundsElement,
  result: RevealableConversationBrowserResult,
): boolean {
  const viewportBounds = viewport.getBoundingClientRect();
  const resultBounds = result.getBoundingClientRect();
  if (
    resultBounds.top >= viewportBounds.top &&
    resultBounds.bottom <= viewportBounds.bottom
  ) {
    return false;
  }

  result.scrollIntoView({ block: "nearest" });
  return true;
}

export function conversationBrowserPageRequestIsCurrent({
  controller,
  currentController,
  currentRequestKey,
  requestKey,
}: {
  controller: AbortController;
  currentController: AbortController | null;
  currentRequestKey: string;
  requestKey: string;
}): boolean {
  return (
    !controller.signal.aborted &&
    currentController === controller &&
    currentRequestKey === requestKey
  );
}

export function conversationBrowserResultSurface({
  isLoading,
  loadError,
  itemCount,
}: {
  isLoading: boolean;
  loadError: string | null;
  itemCount: number;
}): ConversationBrowserResultSurface {
  if (isLoading) {
    return "loading";
  }
  if (loadError !== null) {
    return "failure";
  }
  return itemCount === 0 ? "empty" : "results";
}

export function ConversationBrowserLoadFailure({
  message,
  onRetry,
  view,
}: {
  message: string;
  onRetry: () => void;
  view: ConversationListView;
}) {
  const viewLabel = view === "active" ? "当前" : "已归档";
  return (
    <div className="conversation-search-results__failure" role="alert">
      <AlertIcon />
      <strong>暂时无法加载{viewLabel}对话</strong>
      <span>{message}</span>
      <button
        aria-label={`重新加载${viewLabel}对话`}
        onClick={onRetry}
        type="button"
      >
        <RefreshIcon />
        重新加载
      </button>
    </div>
  );
}

type ConversationPageState = {
  requestKey: string;
  items: ConversationListItem[];
  nextCursor: string | null;
  error: string | null;
};

type HighlightedResult = {
  requestKey: string;
  index: number;
};

type LoadingMoreRequest = {
  controller: AbortController;
  cursor: string;
  requestKey: string;
};

type ConversationBrowserActionError = {
  kind: "load_more" | "restore";
  requestKey: string;
  message: string;
};

function errorMessage(error: unknown): string {
  return userFacingRequestErrorMessage(
    error,
    "对话列表操作暂时失败，请重试。",
  );
}

function isAbortError(error: unknown): boolean {
  return isApiAbortError(error);
}

function ConversationBrowserLoading() {
  return (
    <div aria-hidden="true" className="conversation-search-results__loading">
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}

export function applyArchivedRestoreCompletion({
  activeElement,
  currentRequestKey,
  removeResult,
  requestKey,
  resultRow,
  searchInput,
}: {
  activeElement: Node | null;
  currentRequestKey: string;
  removeResult: () => void;
  requestKey: string;
  resultRow: Pick<HTMLElement, "contains"> | null;
  searchInput: Pick<HTMLInputElement, "focus"> | null;
}): boolean {
  if (currentRequestKey !== requestKey) {
    return false;
  }

  if (
    resultRow !== null &&
    activeElement !== null &&
    resultRow.contains(activeElement)
  ) {
    searchInput?.focus();
  }
  removeResult();
  return true;
}

export function ConversationBrowserDialog({
  initialView,
  refreshVersion,
  busyConversationIds,
  onClose,
  onSelect,
  onRestore,
  onRequestDelete,
}: {
  initialView: ConversationListView;
  refreshVersion: number;
  busyConversationIds: ReadonlySet<string>;
  onClose: () => void;
  onSelect: (selection: ConversationBrowserSelection) => void;
  onRestore: (conversation: ConversationSummary) => Promise<string | null>;
  onRequestDelete: (conversation: ConversationSummary) => void;
}) {
  const [view, setView] = useState<ConversationListView>(initialView);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [pageLoadRevision, setPageLoadRevision] = useState(0);
  const [pageState, setPageState] = useState<ConversationPageState | null>(
    null,
  );
  const [highlightedResult, setHighlightedResult] =
    useState<HighlightedResult | null>(null);
  const [loadingMoreRequest, setLoadingMoreRequest] =
    useState<LoadingMoreRequest | null>(null);
  const [actionError, setActionError] =
    useState<ConversationBrowserActionError | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const archivedTabRef = useRef<HTMLButtonElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const resultsViewportRef = useRef<HTMLDivElement>(null);
  const resultRowRefs = useRef(new Map<string, HTMLDivElement>());
  const pageLoadControllerRef = useRef<AbortController | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const requestKey = `${view}\u0000${query}\u0000${refreshVersion}`;
  const currentRequestKeyRef = useRef(requestKey);
  const visiblePage = pageState?.requestKey === requestKey ? pageState : null;
  const items = visiblePage?.items ?? [];
  const nextCursor = visiblePage?.nextCursor ?? null;
  const isQueryPending = conversationBrowserQueryIsPending(queryInput, query);
  const isLoadingMore =
    loadingMoreRequest?.requestKey === requestKey &&
    !loadingMoreRequest.controller.signal.aborted;
  const navigableItems = isQueryPending ? [] : items;
  const highlightedIndex =
    highlightedResult?.requestKey === requestKey ? highlightedResult.index : -1;
  const highlightedConversation =
    highlightedIndex < 0 ? undefined : navigableItems[highlightedIndex];
  const activeDescendantId =
    highlightedConversation === undefined
      ? undefined
      : conversationBrowserResultId(highlightedConversation.id);
  const isLoading = isQueryPending || visiblePage === null;
  const initialLoadError = visiblePage?.error ?? null;
  const actionErrorMessage =
    actionError?.requestKey === requestKey ? actionError.message : null;
  const resultSurface = conversationBrowserResultSurface({
    isLoading,
    loadError: initialLoadError,
    itemCount: items.length,
  });

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: dialogRef,
    initialFocusRef: inputRef,
    onClose,
  });

  useLayoutEffect(() => {
    currentRequestKeyRef.current = requestKey;
    const loadMoreController = loadMoreControllerRef.current;
    if (loadMoreController !== null) {
      loadMoreController.abort();
      loadMoreControllerRef.current = null;
    }
  }, [requestKey]);

  useEffect(() => {
    const normalizedQueryInput = queryInput.trim();
    if (normalizedQueryInput === query) {
      return;
    }
    const timer = window.setTimeout(
      () => setQuery(normalizedQueryInput),
      queryDebounceMilliseconds,
    );
    return () => window.clearTimeout(timer);
  }, [query, queryInput]);

  useEffect(
    () => () => {
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    pageLoadControllerRef.current = controller;
    const requestIsCurrent = () =>
      conversationBrowserPageRequestIsCurrent({
        controller,
        currentController: pageLoadControllerRef.current,
        currentRequestKey: currentRequestKeyRef.current,
        requestKey,
      });

    void listConversations(
      conversationBrowserInitialPageRequest(view, query),
      controller.signal,
    )
      .then((response) => {
        if (requestIsCurrent()) {
          setPageState({
            requestKey,
            items: response.items,
            nextCursor: response.nextCursor,
            error: null,
          });
        }
      })
      .catch((error: unknown) => {
        if (requestIsCurrent() && !isAbortError(error)) {
          setPageState({
            requestKey,
            items: [],
            nextCursor: null,
            error: errorMessage(error),
          });
        }
      });

    return () => {
      controller.abort();
      if (pageLoadControllerRef.current === controller) {
        pageLoadControllerRef.current = null;
      }
    };
  }, [pageLoadRevision, query, requestKey, view]);

  function handleRetryInitialPageLoad() {
    if (initialLoadError === null) {
      return;
    }
    inputRef.current?.focus();
    setActionError(null);
    setPageState((current) =>
      current?.requestKey === requestKey ? null : current,
    );
    setPageLoadRevision((current) => current + 1);
  }

  async function handleLoadMore() {
    if (nextCursor === null || loadMoreControllerRef.current !== null) {
      return;
    }
    const controller = new AbortController();
    const loadMoreRequestKey = requestKey;
    const loadMoreCursor = nextCursor;
    loadMoreControllerRef.current = controller;
    setLoadingMoreRequest({
      controller,
      cursor: loadMoreCursor,
      requestKey: loadMoreRequestKey,
    });
    setActionError(null);
    const requestIsCurrent = () =>
      conversationBrowserPageRequestIsCurrent({
        controller,
        currentController: loadMoreControllerRef.current,
        currentRequestKey: currentRequestKeyRef.current,
        requestKey: loadMoreRequestKey,
      });
    try {
      const response = await listConversations(
        {
          view,
          query,
          cursor: loadMoreCursor,
          limit: pageSize,
        },
        controller.signal,
      );
      if (!requestIsCurrent()) {
        return;
      }
      setPageState((current) =>
        current?.requestKey === loadMoreRequestKey &&
        current.nextCursor === loadMoreCursor
          ? {
              ...current,
              items: conversationBrowserMergePage(
                current.items,
                response.items,
              ),
              nextCursor: response.nextCursor,
              error: null,
            }
          : current,
      );
    } catch (error: unknown) {
      if (requestIsCurrent() && !isAbortError(error)) {
        setActionError({
          kind: "load_more",
          requestKey: loadMoreRequestKey,
          message: errorMessage(error),
        });
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
      }
      setLoadingMoreRequest((current) =>
        current?.controller === controller ? null : current,
      );
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const nextIndex = conversationBrowserResultIndexForKey(
      event.key,
      highlightedIndex,
      navigableItems.length,
    );
    if (nextIndex !== null) {
      event.preventDefault();
      setHighlightedResult({
        requestKey,
        index: nextIndex,
      });
      const nextConversation = navigableItems[nextIndex];
      const resultsViewport = resultsViewportRef.current;
      const resultRow =
        nextConversation === undefined
          ? undefined
          : resultRowRefs.current.get(nextConversation.id);
      if (resultsViewport !== null && resultRow !== undefined) {
        revealConversationBrowserResultIfOutsideViewport(
          resultsViewport,
          resultRow,
        );
      }
      return;
    }
    if (event.key === "Enter") {
      const selectionIndex = conversationBrowserEnterResultIndex(
        highlightedIndex,
        navigableItems.length,
      );
      if (selectionIndex < 0) {
        return;
      }
      event.preventDefault();
      const conversation = navigableItems[selectionIndex];
      if (conversation !== undefined) {
        onSelect(conversationBrowserSelection(conversation, query));
        onClose();
      }
    }
  }

  function handleViewTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentView: ConversationListView,
  ) {
    const nextView = conversationBrowserViewForTabKey(currentView, event.key);
    if (nextView === null) {
      return;
    }
    event.preventDefault();
    setActionError(null);
    setView(nextView);
    const nextTabRef = nextView === "active" ? activeTabRef : archivedTabRef;
    nextTabRef.current?.focus();
  }

  function handleResultsScroll(event: UIEvent<HTMLDivElement>) {
    if (
      resultSurface === "results" &&
      nextCursor !== null &&
      conversationBrowserScrollIsNearEnd(event.currentTarget)
    ) {
      void handleLoadMore();
    }
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="conversation-dialog-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-labelledby="conversation-browser-title"
        aria-modal="true"
        className="conversation-browser-dialog"
        id="conversation-browser-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="conversation-browser-dialog__header">
          <span>
            <SearchIcon />
            <strong id="conversation-browser-title">搜索对话</strong>
          </span>
          <button
            aria-label="关闭搜索对话"
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <div
          aria-label="对话范围"
          className="conversation-browser-dialog__tabs"
          role="tablist"
        >
          <button
            aria-controls="conversation-browser-view-panel"
            aria-selected={view === "active"}
            id="conversation-browser-active-tab"
            onClick={() => {
              setActionError(null);
              setView("active");
            }}
            onKeyDown={(event) => handleViewTabKeyDown(event, "active")}
            ref={activeTabRef}
            role="tab"
            tabIndex={view === "active" ? 0 : -1}
            type="button"
          >
            当前对话
          </button>
          <button
            aria-controls="conversation-browser-view-panel"
            aria-selected={view === "archived"}
            id="conversation-browser-archived-tab"
            onClick={() => {
              setActionError(null);
              setView("archived");
            }}
            onKeyDown={(event) => handleViewTabKeyDown(event, "archived")}
            ref={archivedTabRef}
            role="tab"
            tabIndex={view === "archived" ? 0 : -1}
            type="button"
          >
            <ArchiveIcon />
            已归档
          </button>
        </div>

        <div
          aria-labelledby={
            view === "active"
              ? "conversation-browser-active-tab"
              : "conversation-browser-archived-tab"
          }
          className="conversation-browser-dialog__panel"
          id="conversation-browser-view-panel"
          role="tabpanel"
        >
          <div className="conversation-search-field">
            <SearchIcon />
            <input
              aria-activedescendant={activeDescendantId}
              aria-autocomplete="list"
              aria-controls="conversation-search-result-list"
              aria-expanded={true}
              aria-haspopup={view === "active" ? "listbox" : "grid"}
              aria-label="按标题或消息内容搜索"
              maxLength={200}
              onChange={(event) => {
                setActionError(null);
                setQueryInput(event.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索标题和消息内容"
              ref={inputRef}
              role="combobox"
              type="search"
              value={queryInput}
            />
            {queryInput.length === 0 ? null : (
              <button
                aria-label="清空搜索关键词"
                onClick={() => {
                  setActionError(null);
                  setQueryInput("");
                  inputRef.current?.focus();
                }}
                title="清空"
                type="button"
              >
                <CloseIcon />
              </button>
            )}
          </div>

          <div
            aria-live="polite"
            className="conversation-browser-dialog__status"
          >
            {resultSurface === "loading"
              ? isQueryPending
                ? "正在搜索…"
                : "正在加载…"
              : resultSurface === "failure"
                ? `${view === "active" ? "当前" : "已归档"}对话加载失败`
                : `${view === "active" ? "当前" : "已归档"}对话，已显示 ${items.length} 项${nextCursor === null ? "" : "，滚动可加载更多"}`}
          </div>

          {actionErrorMessage === null ? null : (
            <div className="conversation-browser-dialog__error" role="alert">
              {actionError?.kind === "load_more"
                ? "加载更多失败："
                : "操作失败："}
              {actionErrorMessage}
            </div>
          )}

          <div
            aria-busy={resultSurface === "loading" || isLoadingMore}
            className="conversation-search-results"
            onScroll={handleResultsScroll}
            ref={resultsViewportRef}
          >
            {resultSurface === "loading" ? (
              <ConversationBrowserLoading />
            ) : resultSurface === "failure" && initialLoadError !== null ? (
              <ConversationBrowserLoadFailure
                message={initialLoadError}
                onRetry={handleRetryInitialPageLoad}
                view={view}
              />
            ) : resultSurface === "empty" ? (
              <div className="conversation-search-results__empty">
                {view === "archived" ? <ArchiveIcon /> : <ChatIcon />}
                <strong>
                  {query.length === 0
                    ? view === "archived"
                      ? "还没有已归档对话"
                      : "这里还没有对话"
                    : `未找到“${query}”`}
                </strong>
                <span>
                  {query.length === 0
                    ? "创建对话后会显示在这里。"
                    : "请检查拼写，或尝试更短的关键词。"}
                </span>
              </div>
            ) : null}
            <div
              aria-label="搜索结果"
              aria-multiselectable={false}
              id="conversation-search-result-list"
              role={view === "active" ? "listbox" : "grid"}
            >
              {resultSurface === "results"
                ? navigableItems.map((conversation, index) => {
                    const isBusy = busyConversationIds.has(conversation.id);
                    const outstandingRunStatus =
                      conversationOutstandingRunStatus(conversation);
                    const hasOutstandingRuns =
                      conversationHasOutstandingRuns(conversation);
                    const isHighlighted = highlightedIndex === index;
                    const resultId = conversationBrowserResultId(
                      conversation.id,
                    );
                    const resultStatus =
                      outstandingRunStatus !== null
                        ? outstandingRunStatus === "queued"
                          ? "排队中"
                          : outstandingRunStatus === "running"
                            ? "研究中"
                            : "队列已暂停"
                        : conversation.pinnedAt === null
                          ? "对话"
                          : "已置顶";
                    const searchMatch = conversationBrowserSearchMatch(
                      conversation,
                      query,
                    );
                    const conversationSummary =
                      conversationSummaryFromListItem(conversation);
                    const resultMeta =
                      searchMatch?.kind === "message"
                        ? `${searchMatch.role === "user" ? "你的消息" : "助手回复"} · ${resultStatus}`
                        : resultStatus;
                    return (
                      <div
                        aria-busy={view === "archived" ? isBusy : undefined}
                        aria-selected={
                          view === "archived" ? isHighlighted : undefined
                        }
                        className={`conversation-search-result${
                          isHighlighted
                            ? " conversation-search-result--highlighted"
                            : ""
                        }`}
                        id={view === "archived" ? resultId : undefined}
                        key={conversation.id}
                        onMouseEnter={() =>
                          setHighlightedResult({ requestKey, index })
                        }
                        ref={(node) => {
                          if (node === null) {
                            resultRowRefs.current.delete(conversation.id);
                          } else {
                            resultRowRefs.current.set(conversation.id, node);
                          }
                        }}
                        role={view === "active" ? "presentation" : "row"}
                      >
                        <span
                          className="conversation-search-result__main-cell"
                          role={
                            view === "archived" ? "gridcell" : "presentation"
                          }
                        >
                          <button
                            aria-busy={view === "active" ? isBusy : undefined}
                            aria-selected={
                              view === "active" ? isHighlighted : undefined
                            }
                            className="conversation-search-result__main"
                            id={view === "active" ? resultId : undefined}
                            onClick={() => {
                              onSelect(
                                conversationBrowserSelection(
                                  conversation,
                                  query,
                                ),
                              );
                              onClose();
                            }}
                            role={view === "active" ? "option" : undefined}
                            tabIndex={view === "active" ? -1 : undefined}
                            type="button"
                          >
                            <span className="conversation-search-result__icon">
                              {conversation.pinnedAt === null ? (
                                <ChatIcon />
                              ) : (
                                <PinIcon />
                              )}
                              {conversation.attention === null ? null : (
                                <i
                                  aria-label="有新的运行结果"
                                  className="conversation-attention-dot"
                                />
                              )}
                            </span>
                            <span>
                              <strong>
                                {searchMatch?.kind === "title" ? (
                                  <ConversationBrowserSearchExcerpt
                                    excerpt={searchMatch.excerpt}
                                  />
                                ) : (
                                  conversation.title
                                )}
                              </strong>
                              {searchMatch?.kind === "message" ? (
                                <span className="conversation-search-result__excerpt">
                                  <ConversationBrowserSearchExcerpt
                                    excerpt={searchMatch.excerpt}
                                  />
                                </span>
                              ) : null}
                              <small>
                                <span>{resultMeta}</span>
                                <time dateTime={conversation.updatedAt}>
                                  {formatConversationBrowserDate(
                                    conversation.updatedAt,
                                  )}
                                </time>
                              </small>
                            </span>
                          </button>
                        </span>
                        {view === "archived" ? (
                          <span
                            aria-label={`对话操作：${conversation.title}`}
                            className="conversation-search-result__actions"
                            role="gridcell"
                          >
                            <button
                              aria-label={`恢复对话：${conversation.title}`}
                              aria-disabled={isBusy}
                              onClick={(event) => {
                                if (isBusy) {
                                  return;
                                }
                                const restoreRequestKey = requestKey;
                                const resultRow =
                                  event.currentTarget.closest<HTMLElement>(
                                    ".conversation-search-result",
                                  );
                                setActionError(null);
                                void onRestore(conversationSummary).then(
                                  (restoreError) => {
                                    if (restoreError === null) {
                                      applyArchivedRestoreCompletion({
                                        activeElement: document.activeElement,
                                        currentRequestKey:
                                          currentRequestKeyRef.current,
                                        removeResult: () => {
                                          setPageState((current) =>
                                            current?.requestKey ===
                                            restoreRequestKey
                                              ? {
                                                  ...current,
                                                  items: current.items.filter(
                                                    (item) =>
                                                      item.id !==
                                                      conversation.id,
                                                  ),
                                                }
                                              : current,
                                          );
                                        },
                                        requestKey: restoreRequestKey,
                                        resultRow,
                                        searchInput: inputRef.current,
                                      });
                                    } else if (
                                      currentRequestKeyRef.current ===
                                      restoreRequestKey
                                    ) {
                                      setActionError({
                                        kind: "restore",
                                        requestKey: restoreRequestKey,
                                        message: restoreError,
                                      });
                                    }
                                  },
                                );
                              }}
                              title="恢复"
                              type="button"
                            >
                              <RestoreIcon />
                            </button>
                            <button
                              aria-label={`删除对话：${conversation.title}`}
                              disabled={isBusy || hasOutstandingRuns}
                              onClick={() =>
                                onRequestDelete(conversationSummary)
                              }
                              title={
                                hasOutstandingRuns
                                  ? "该对话仍有正在运行或等待中的研究，不能删除"
                                  : "删除"
                              }
                              type="button"
                            >
                              <TrashIcon />
                            </button>
                          </span>
                        ) : null}
                      </div>
                    );
                  })
                : null}
            </div>
          </div>

          {resultSurface !== "results" || nextCursor === null ? null : (
            <button
              aria-label={
                actionError?.requestKey === requestKey &&
                actionError.kind === "load_more"
                  ? "重试加载更多对话"
                  : "加载更多对话"
              }
              className="conversation-browser-dialog__more"
              disabled={isLoadingMore}
              onClick={() => void handleLoadMore()}
              type="button"
            >
              {isLoadingMore
                ? "正在加载…"
                : actionError?.requestKey === requestKey &&
                    actionError.kind === "load_more"
                  ? "重试加载更多"
                  : "加载更多"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
