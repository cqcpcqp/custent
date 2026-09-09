"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";

import { getBackgroundRunHistory } from "@/components/api-client";
import {
  backgroundRunHistoryErrorMessage,
  backgroundRunHistoryInitialPageRequest,
  backgroundRunHistoryIsAbortError,
  backgroundRunHistoryNextPageRequest,
  backgroundRunHistoryResultSurface,
  backgroundRunHistoryStatusFilters,
  backgroundRunHistoryWithoutCenterRuns,
  formatBackgroundRunHistoryDate,
  loadBackgroundRunHistoryUntilVisible,
  type BackgroundRunCenterItem,
  type BackgroundRunHistoryResultSurface,
} from "@/components/background-run-center-state";
import {
  ActivityIcon,
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  RefreshIcon,
  SparklesIcon,
  StopIcon,
} from "@/components/icons";
import { useModalFocus } from "@/components/modal-focus";
import type {
  BackgroundRunHistoryItem,
  BackgroundRunHistoryResponse,
  BackgroundRunHistoryStatusFilter,
} from "@/lib/contracts";

type BackgroundRunCenterTriggerProps = {
  className?: string;
  count: number;
  isOpen: boolean;
  onOpen: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

type BackgroundRunCenterDialogProps = {
  historyRevision: number;
  items: readonly BackgroundRunCenterItem[];
  onClose: () => void;
  onSelect: (item: BackgroundRunCenterItem) => void;
  onSelectHistory: (item: BackgroundRunHistoryItem) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

export type BackgroundRunHistoryViewProps = Readonly<{
  status: BackgroundRunHistoryStatusFilter;
  items: readonly BackgroundRunHistoryItem[] | null;
  nextCursor: string | null;
  initialLoadError: string | null;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onChangeStatus: (status: BackgroundRunHistoryStatusFilter) => void;
  onLoadMore: () => void;
  onRetryInitialLoad: () => void;
  onSelect: (item: BackgroundRunHistoryItem) => void;
}>;

type BackgroundRunHistoryLoadState = Readonly<{
  requestKey: string;
  page: BackgroundRunHistoryResponse | null;
  initialLoadError: string | null;
  loadingMoreCursor: string | null;
  loadMoreError: string | null;
}>;

function emptyBackgroundRunHistoryLoadState(
  requestKey: string,
): BackgroundRunHistoryLoadState {
  return {
    requestKey,
    page: null,
    initialLoadError: null,
    loadingMoreCursor: null,
    loadMoreError: null,
  };
}

function getBackgroundRunHistoryPage(
  status: BackgroundRunHistoryStatusFilter,
  cursor: string | null,
  signal: AbortSignal,
): Promise<BackgroundRunHistoryResponse> {
  return getBackgroundRunHistory(
    cursor === null
      ? backgroundRunHistoryInitialPageRequest(status)
      : backgroundRunHistoryNextPageRequest(status, cursor),
    signal,
  );
}

type BackgroundRunCenterStatus = BackgroundRunCenterItem["status"];
type BackgroundRunCenterKind = BackgroundRunCenterItem["kind"];

const statusPresentation = {
  waiting: {
    label: "等待中",
    description: "等待当前研究完成后继续",
  },
  queued: {
    label: "排队中",
    description: "Agent 已接收任务，正在等待开始",
  },
  running: {
    label: "运行中",
    description: "Agent 正在后台执行",
  },
  completed: {
    label: "已完成",
    description: "结果已生成，等待查看",
  },
  failed: {
    label: "失败",
    description: "任务未能完成，请查看活动详情",
  },
  cancelled: {
    label: "已停止",
    description: "任务已停止，可查看活动记录",
  },
  reconciliation_required: {
    label: "费用待确认",
    description: "生成已结束，可继续发送消息；费用确认无需你操作",
  },
} as const satisfies Record<
  BackgroundRunCenterStatus,
  Readonly<{ label: string; description: string }>
>;

const groups = [
  {
    kind: "active",
    title: "正在处理",
    description: "切换对话不会中断这些任务",
  },
  {
    kind: "waiting",
    title: "等待继续",
    description: "同一对话中的后续任务会按顺序开始",
  },
  {
    kind: "attention",
    title: "需要查看",
    description: "打开任务可查看完整活动记录",
  },
] as const satisfies ReadonlyArray<{
  kind: BackgroundRunCenterKind;
  title: string;
  description: string;
}>;

export function BackgroundRunCenterTrigger({
  className,
  count,
  isOpen,
  onOpen,
  triggerRef,
}: BackgroundRunCenterTriggerProps) {
  return (
    <button
      aria-controls="background-run-center-dialog"
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-label={
        count > 0
          ? `后台任务，${count.toLocaleString("zh-CN")} 项待处理`
          : "后台任务，当前没有待处理任务"
      }
      className={`header-activity-button header-background-run-button${
        className === undefined ? "" : ` ${className}`
      }`}
      onClick={onOpen}
      ref={triggerRef}
      type="button"
    >
      <SparklesIcon />
      <span>任务</span>
      {count === 0 ? null : (
        <strong aria-hidden="true" className="header-run-button__badge">
          {count.toLocaleString("zh-CN")}
        </strong>
      )}
    </button>
  );
}

function BackgroundRunStatusIcon({
  status,
}: {
  status: BackgroundRunCenterStatus;
}) {
  switch (status) {
    case "queued":
    case "running":
      return <RefreshIcon />;
    case "waiting":
      return <ActivityIcon />;
    case "completed":
      return <CheckIcon />;
    case "cancelled":
      return <StopIcon />;
    case "failed":
    case "reconciliation_required":
      return <AlertIcon />;
  }
}

function itemDescription(item: BackgroundRunCenterItem): string {
  if (item.kind === "waiting") {
    return `${item.waitingRunCount.toLocaleString("zh-CN")} 个任务等待继续`;
  }
  return statusPresentation[item.status].description;
}

function itemAriaLabel(item: BackgroundRunCenterItem): string {
  const status = statusPresentation[item.status].label;
  const action = item.kind === "waiting" ? "打开对话" : "查看活动";
  return `${action}“${item.conversationTitle}”，${status}，${itemDescription(item)}`;
}

function BackgroundRunCenterRow({
  item,
  onSelect,
}: {
  item: BackgroundRunCenterItem;
  onSelect: (item: BackgroundRunCenterItem) => void;
}) {
  const presentation = statusPresentation[item.status];

  return (
    <li className="background-run-center__item">
      <button
        aria-label={itemAriaLabel(item)}
        className={`background-run-center__task background-run-center__task--${item.kind} background-run-center__task--${item.status}`}
        onClick={() => onSelect(item)}
        type="button"
      >
        <span
          aria-hidden="true"
          className="background-run-center__task-icon"
        >
          <BackgroundRunStatusIcon status={item.status} />
        </span>
        <span className="background-run-center__task-copy">
          <strong>{item.conversationTitle}</strong>
          <span>
            <span className="background-run-center__task-status">
              {presentation.label}
            </span>
            <small>{itemDescription(item)}</small>
          </span>
        </span>
        <ChevronRightIcon />
      </button>
    </li>
  );
}

function BackgroundRunHistoryRow({
  item,
  onSelect,
}: {
  item: BackgroundRunHistoryItem;
  onSelect: (item: BackgroundRunHistoryItem) => void;
}) {
  const presentation = statusPresentation[item.status];
  const finishedAt = formatBackgroundRunHistoryDate(item.finishedAt);

  return (
    <li className="background-run-center__item">
      <button
        aria-label={`查看活动“${item.conversationTitle}”，${presentation.label}，完成于 ${finishedAt}`}
        className={`background-run-center__task background-run-center__task--history background-run-center__task--${item.status}`}
        onClick={() => onSelect(item)}
        type="button"
      >
        <span aria-hidden="true" className="background-run-center__task-icon">
          <BackgroundRunStatusIcon status={item.status} />
        </span>
        <span className="background-run-center__task-copy">
          <strong>{item.conversationTitle}</strong>
          <span>
            <span className="background-run-center__task-status">
              {presentation.label}
            </span>
            <small>
              完成于 <time dateTime={item.finishedAt}>{finishedAt}</time>
            </small>
          </span>
        </span>
        <ChevronRightIcon />
      </button>
    </li>
  );
}

export function BackgroundRunHistoryView({
  status,
  items,
  nextCursor,
  initialLoadError,
  isLoadingMore,
  loadMoreError,
  onChangeStatus,
  onLoadMore,
  onRetryInitialLoad,
  onSelect,
}: BackgroundRunHistoryViewProps) {
  const isLoadingEmptyPage =
    items !== null && items.length === 0 && isLoadingMore;
  const resultSurface: BackgroundRunHistoryResultSurface =
    backgroundRunHistoryResultSurface({
      isLoading:
        (items === null && initialLoadError === null) || isLoadingEmptyPage,
      loadError: initialLoadError,
      itemCount: items?.length ?? 0,
    });

  return (
    <section
      aria-labelledby="background-run-history-heading"
      className="background-run-center__group background-run-center__group--history"
    >
      <header className="background-run-center__group-header background-run-center__history-header">
        <span>
          <strong id="background-run-history-heading">最近完成</strong>
          <small>仅显示仍可打开的对话，按完成时间排序</small>
        </span>
        {items === null || isLoadingEmptyPage ? null : (
          <span
            aria-label={`最近完成 ${items.length.toLocaleString("zh-CN")} 项`}
            className="background-run-center__group-count"
          >
            {items.length.toLocaleString("zh-CN")}
          </span>
        )}
      </header>

      <div
        aria-label="筛选最近完成任务"
        className="background-run-center__history-filters"
        role="group"
      >
        {backgroundRunHistoryStatusFilters.map((filter) => (
          <button
            aria-pressed={status === filter.value}
            className="background-run-center__history-filter"
            key={filter.value}
            onClick={() => onChangeStatus(filter.value)}
            type="button"
          >
            {filter.label}
          </button>
        ))}
      </div>

      <div
        aria-busy={resultSurface === "loading" || isLoadingMore}
        aria-live="polite"
        className="background-run-center__history-results"
      >
        {resultSurface === "loading" ? (
          <div className="background-run-center__history-loading" role="status">
            <span aria-hidden="true" />
            <strong>正在加载最近完成任务</strong>
          </div>
        ) : resultSurface === "failure" && initialLoadError !== null ? (
          <div className="background-run-center__history-failure" role="alert">
            <AlertIcon />
            <strong>暂时无法加载最近完成任务</strong>
            <p>{initialLoadError}</p>
            <button onClick={onRetryInitialLoad} type="button">
              <RefreshIcon />
              重新加载
            </button>
          </div>
        ) : resultSurface === "empty" ? (
          <div className="background-run-center__history-empty" role="status">
            <CheckIcon />
            <strong>没有符合筛选的历史任务</strong>
            <p>未读结果仍保留在上方“需要查看”中，不会重复显示。</p>
          </div>
        ) : items === null ? null : (
          <ol className="background-run-center__list" aria-label="最近完成任务">
            {items.map((item) => (
              <BackgroundRunHistoryRow
                item={item}
                key={item.runId}
                onSelect={onSelect}
              />
            ))}
          </ol>
        )}
      </div>

      {loadMoreError === null ? null : (
        <div className="background-run-center__history-load-more-error" role="alert">
          加载更多失败：{loadMoreError}
        </div>
      )}
      {nextCursor === null || resultSurface === "loading" ? null : (
        <button
          aria-label={
            loadMoreError === null
              ? "加载更多最近完成任务"
              : "重试加载更多最近完成任务"
          }
          className="background-run-center__history-load-more"
          disabled={isLoadingMore}
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

function BackgroundRunHistorySection({
  centerItems,
  historyRevision,
  onSelect,
}: {
  centerItems: readonly BackgroundRunCenterItem[];
  historyRevision: number;
  onSelect: (item: BackgroundRunHistoryItem) => void;
}) {
  const [status, setStatus] =
    useState<BackgroundRunHistoryStatusFilter>("all");
  const [initialLoadRevision, setInitialLoadRevision] = useState(0);
  const requestKey = `${status}\u0000${historyRevision}\u0000${initialLoadRevision}`;
  const [loadState, setLoadState] = useState<BackgroundRunHistoryLoadState>(() =>
    emptyBackgroundRunHistoryLoadState(requestKey),
  );
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const centerItemsRef = useRef(centerItems);
  const currentLoadState =
    loadState.requestKey === requestKey
      ? loadState
      : emptyBackgroundRunHistoryLoadState(requestKey);
  const page = currentLoadState.page;
  const visibleItems = useMemo(
    () =>
      page === null
        ? null
        : backgroundRunHistoryWithoutCenterRuns(page.items, centerItems),
    [centerItems, page],
  );

  useEffect(() => {
    centerItemsRef.current = centerItems;
  }, [centerItems]);

  useEffect(() => {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    const controller = new AbortController();
    void loadBackgroundRunHistoryUntilVisible({
      currentItems: [],
      cursor: null,
      centerItems: centerItemsRef.current,
      loadPage: (cursor) =>
        getBackgroundRunHistoryPage(status, cursor, controller.signal),
    })
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        setLoadState({
          requestKey,
          page: response,
          initialLoadError: null,
          loadingMoreCursor: null,
          loadMoreError: null,
        });
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          !backgroundRunHistoryIsAbortError(error)
        ) {
          setLoadState({
            ...emptyBackgroundRunHistoryLoadState(requestKey),
            initialLoadError: backgroundRunHistoryErrorMessage(error),
          });
        }
      });
    return () => controller.abort();
  }, [requestKey, status]);

  useEffect(
    () => () => {
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    },
    [],
  );

  function handleChangeStatus(nextStatus: BackgroundRunHistoryStatusFilter) {
    if (nextStatus === status) {
      return;
    }
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setStatus(nextStatus);
    setInitialLoadRevision((current) => current + 1);
  }

  function handleRetryInitialLoad() {
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = null;
    setInitialLoadRevision((current) => current + 1);
  }

  const handleLoadMore = useCallback(async () => {
    if (
      page === null ||
      page.nextCursor === null ||
      loadMoreControllerRef.current !== null
    ) {
      return;
    }
    const cursor = page.nextCursor;
    const controller = new AbortController();
    loadMoreControllerRef.current = controller;
    setLoadState((current) =>
      current.requestKey === requestKey &&
      current.page?.nextCursor === cursor &&
      current.loadingMoreCursor === null
        ? {
            ...current,
            loadingMoreCursor: cursor,
            loadMoreError: null,
          }
        : current,
    );
    try {
      const response = await loadBackgroundRunHistoryUntilVisible({
        currentItems: page.items,
        cursor,
        centerItems: centerItemsRef.current,
        loadPage: (nextCursor) =>
          getBackgroundRunHistoryPage(
            status,
            nextCursor,
            controller.signal,
          ),
      });
      if (controller.signal.aborted) {
        return;
      }
      setLoadState((current) =>
        current.requestKey === requestKey &&
        current.page?.nextCursor === cursor &&
        current.loadingMoreCursor === cursor
          ? {
              ...current,
              page: response,
              loadingMoreCursor: null,
              loadMoreError: null,
            }
          : current,
      );
    } catch (error) {
      if (
        !controller.signal.aborted &&
        !backgroundRunHistoryIsAbortError(error)
      ) {
        const message = backgroundRunHistoryErrorMessage(error);
        const hadVisibleItems =
          backgroundRunHistoryWithoutCenterRuns(
            page.items,
            centerItemsRef.current,
          ).length > 0;
        setLoadState((current) => {
          if (
            current.requestKey !== requestKey ||
            current.page?.nextCursor !== cursor ||
            current.loadingMoreCursor !== cursor
          ) {
            return current;
          }
          if (!hadVisibleItems) {
            return {
              ...emptyBackgroundRunHistoryLoadState(requestKey),
              initialLoadError: message,
            };
          }
          return {
            ...current,
            loadingMoreCursor: null,
            loadMoreError: message,
          };
        });
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
      }
    }
  }, [page, requestKey, status]);

  const shouldAutoFill =
    page !== null &&
    page.nextCursor !== null &&
    visibleItems?.length === 0 &&
    currentLoadState.initialLoadError === null &&
    currentLoadState.loadingMoreCursor === null &&
    currentLoadState.loadMoreError === null;

  useEffect(() => {
    if (shouldAutoFill) {
      void handleLoadMore();
    }
  }, [handleLoadMore, shouldAutoFill]);

  return (
    <BackgroundRunHistoryView
      initialLoadError={currentLoadState.initialLoadError}
      isLoadingMore={
        currentLoadState.loadingMoreCursor !== null || shouldAutoFill
      }
      items={visibleItems}
      loadMoreError={currentLoadState.loadMoreError}
      nextCursor={page?.nextCursor ?? null}
      onChangeStatus={handleChangeStatus}
      onLoadMore={() => void handleLoadMore()}
      onRetryInitialLoad={handleRetryInitialLoad}
      onSelect={onSelect}
      status={status}
    />
  );
}

export function BackgroundRunCenterDialog({
  historyRevision,
  items,
  onClose,
  onSelect,
  onSelectHistory,
  returnFocusRef,
}: BackgroundRunCenterDialogProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onClose,
    returnFocusRef,
  });

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <div
      className="background-run-center-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-describedby="background-run-center-description"
        aria-labelledby="background-run-center-title"
        aria-modal="true"
        className="background-run-center"
        id="background-run-center-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="background-run-center__header">
          <span className="background-run-center__identity">
            <span aria-hidden="true">
              <ActivityIcon />
            </span>
            <span>
              <strong id="background-run-center-title">后台任务</strong>
              <small id="background-run-center-description">
                查看跨对话继续执行的 Agent 任务
              </small>
            </span>
          </span>
          <button
            aria-label="关闭后台任务"
            className="icon-button background-run-center__close"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="background-run-center__body">
          {items.length === 0 ? (
            <div
              className="background-run-center__empty background-run-center__empty--pending"
              role="status"
            >
              <CheckIcon />
              <strong>当前没有待处理任务</strong>
              <p>运行中的任务和未读结果会显示在这里。</p>
            </div>
          ) : (
            groups.map((group) => {
              const groupItems = items.filter(
                (item) => item.kind === group.kind,
              );
              if (groupItems.length === 0) {
                return null;
              }
              const headingId = `background-run-center-${group.kind}-heading`;
              return (
                <section
                  aria-labelledby={headingId}
                  className={`background-run-center__group background-run-center__group--${group.kind}`}
                  key={group.kind}
                >
                  <header className="background-run-center__group-header">
                    <span>
                      <strong id={headingId}>{group.title}</strong>
                      <small>{group.description}</small>
                    </span>
                    <span
                      aria-label={`${group.title} ${groupItems.length.toLocaleString("zh-CN")} 项`}
                      className="background-run-center__group-count"
                    >
                      {groupItems.length.toLocaleString("zh-CN")}
                    </span>
                  </header>
                  <ol className="background-run-center__list">
                    {groupItems.map((item) => (
                      <BackgroundRunCenterRow
                        item={item}
                        key={item.id}
                        onSelect={onSelect}
                      />
                    ))}
                  </ol>
                </section>
              );
            })
          )}
          <BackgroundRunHistorySection
            centerItems={items}
            historyRevision={historyRevision}
            onSelect={onSelectHistory}
          />
        </div>
      </section>
    </div>
  );
}
