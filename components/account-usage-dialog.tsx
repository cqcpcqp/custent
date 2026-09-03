"use client";

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";

import { getAccountUsage } from "@/components/api-client";
import {
  accountUsageErrorMessage,
  accountUsageInitialPageRequest,
  accountUsageIsAbortError,
  accountUsageMergePage,
  accountUsageNextPageRequest,
  accountUsageResultSurface,
  accountUsageStatusLabels,
  formatAccountUsageDate,
  formatAccountUsageNumber,
} from "@/components/account-usage-state";
import {
  AlertIcon,
  CloseIcon,
  CoinsIcon,
  RefreshIcon,
} from "@/components/icons";
import { useModalFocus } from "@/components/modal-focus";
import type {
  AccountUsageBalance,
  AccountUsageItem,
  AccountUsageResponse,
} from "@/lib/contracts";

export type AccountUsageReadyContentProps = Readonly<{
  page: AccountUsageResponse;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
}>;

function AccountUsageBalanceSummary({
  balance,
}: {
  balance: AccountUsageBalance;
}) {
  return (
    <section
      aria-labelledby="account-usage-balance-title"
      className="account-usage-balance"
    >
      <div className="account-usage-section-heading">
        <strong id="account-usage-balance-title">当前余额</strong>
        <span>三类余额分别展示，不作为累计消耗相加。</span>
      </div>
      <dl className="account-usage-balance__grid">
        <div>
          <dt>可用积分</dt>
          <dd>{formatAccountUsageNumber(balance.available)}</dd>
        </div>
        <div>
          <dt>运行中预留积分</dt>
          <dd>{formatAccountUsageNumber(balance.reserved)}</dd>
        </div>
        <div>
          <dt>待对账冻结积分</dt>
          <dd>{formatAccountUsageNumber(balance.frozen)}</dd>
        </div>
      </dl>
    </section>
  );
}

function AccountUsageMetric({
  label,
  value,
}: {
  label: string;
  value: number | null;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatAccountUsageNumber(value)}</dd>
    </div>
  );
}

export function AccountUsageRunItem({ item }: { item: AccountUsageItem }) {
  const statusLabel = accountUsageStatusLabels[item.status];
  return (
    <li className="account-usage-run" data-run-status={item.status}>
      <header className="account-usage-run__header">
        <strong title={item.conversationTitle}>{item.conversationTitle}</strong>
        <span
          aria-label={`运行状态：${statusLabel}`}
          className={`account-usage-status account-usage-status--${item.status}`}
        >
          {statusLabel}
        </span>
      </header>
      <dl className="account-usage-run__dates">
        <div>
          <dt>创建时间</dt>
          <dd>
            <time dateTime={item.createdAt}>
              {formatAccountUsageDate(item.createdAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>完成时间</dt>
          <dd>
            {item.finishedAt === null ? (
              "—"
            ) : (
              <time dateTime={item.finishedAt}>
                {formatAccountUsageDate(item.finishedAt)}
              </time>
            )}
          </dd>
        </div>
      </dl>
      <dl className="account-usage-run__metrics">
        <AccountUsageMetric
          label="本次预留积分"
          value={item.reservationCredits}
        />
        <AccountUsageMetric
          label="本次实扣积分"
          value={item.chargedCredits}
        />
        <AccountUsageMetric label="输入 tokens" value={item.inputTokens} />
        <AccountUsageMetric label="输出 tokens" value={item.outputTokens} />
        <AccountUsageMetric label="网页搜索次数" value={item.webSearches} />
      </dl>
    </li>
  );
}

export function AccountUsageReadyContent({
  page,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
}: AccountUsageReadyContentProps) {
  return (
    <>
      <AccountUsageBalanceSummary balance={page.balance} />
      <section
        aria-labelledby="account-usage-history-title"
        className="account-usage-history"
      >
        <div className="account-usage-section-heading">
          <strong id="account-usage-history-title">Run 用量明细</strong>
          <span>预留额度与最终实扣分开列示。</span>
        </div>
        {page.items.length === 0 ? (
          <div className="account-usage-empty" role="status">
            <CoinsIcon />
            <strong>还没有用量记录</strong>
            <span>运行研究后，每个 Run 的积分与模型用量会显示在这里。</span>
          </div>
        ) : (
          <ol
            aria-busy={isLoadingMore}
            aria-label="Run 用量记录"
            className="account-usage-list"
          >
            {page.items.map((item) => (
              <AccountUsageRunItem item={item} key={item.runId} />
            ))}
          </ol>
        )}
        {loadMoreError === null ? null : (
          <div className="account-usage-load-more-error" role="alert">
            加载更多失败：{loadMoreError}
          </div>
        )}
        {page.nextCursor === null ? null : (
          <button
            aria-label={
              loadMoreError === null
                ? "加载更多用量记录"
                : "重试加载更多用量记录"
            }
            className="account-usage-load-more"
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
    </>
  );
}

export function AccountUsageDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const [page, setPage] = useState<AccountUsageResponse | null>(null);
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [initialLoadRevision, setInitialLoadRevision] = useState(0);
  const [loadingMoreCursor, setLoadingMoreCursor] = useState<string | null>(
    null,
  );
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const resultSurface = accountUsageResultSurface({
    isLoading: page === null && initialLoadError === null,
    loadError: initialLoadError,
    itemCount: page?.items.length ?? 0,
  });
  const isLoadingMore = loadingMoreCursor !== null;

  useModalFocus({
    backdropRef,
    canClose: true,
    containerRef: dialogRef,
    initialFocusRef: closeButtonRef,
    onClose,
    returnFocusRef,
  });

  useEffect(() => {
    const controller = new AbortController();
    void getAccountUsage(accountUsageInitialPageRequest(), controller.signal)
      .then((response) => {
        if (controller.signal.aborted) {
          return;
        }
        setPage({
          ...response,
          items: accountUsageMergePage([], response.items),
        });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !accountUsageIsAbortError(error)) {
          setInitialLoadError(accountUsageErrorMessage(error));
        }
      });
    return () => controller.abort();
  }, [initialLoadRevision]);

  useEffect(
    () => () => {
      loadMoreControllerRef.current?.abort();
      loadMoreControllerRef.current = null;
    },
    [],
  );

  async function handleLoadMore() {
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
    setLoadingMoreCursor(cursor);
    setLoadMoreError(null);
    try {
      const response = await getAccountUsage(
        accountUsageNextPageRequest(cursor),
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      const mergedItems = accountUsageMergePage(page.items, response.items);
      setPage((current) =>
        current !== null && current.nextCursor === cursor
          ? { ...response, items: mergedItems }
          : current,
      );
    } catch (error) {
      if (!controller.signal.aborted && !accountUsageIsAbortError(error)) {
        setLoadMoreError(accountUsageErrorMessage(error));
      }
    } finally {
      if (loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMoreCursor(null);
      }
    }
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      event.preventDefault();
      onClose();
    }
  }

  function handleRetryInitialLoad() {
    setPage(null);
    setInitialLoadError(null);
    setLoadMoreError(null);
    setInitialLoadRevision((current) => current + 1);
  }

  return (
    <div
      className="account-usage-backdrop"
      data-modal-layer=""
      onMouseDown={handleBackdropMouseDown}
      ref={backdropRef}
    >
      <section
        aria-describedby="account-usage-description"
        aria-labelledby="account-usage-title"
        aria-modal="true"
        className="account-usage-dialog"
        id="account-usage-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="account-usage-dialog__header">
          <span className="account-usage-dialog__identity">
            <span aria-hidden="true">
              <CoinsIcon />
            </span>
            <span>
              <strong id="account-usage-title">积分与用量</strong>
              <small id="account-usage-description">
                查看余额与每个 Run 的真实计量结果
              </small>
            </span>
          </span>
          <button
            aria-label="关闭积分与用量"
            className="icon-button"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>

        <div aria-live="polite" className="account-usage-dialog__status">
          {resultSurface === "loading"
            ? "正在加载积分与用量…"
            : resultSurface === "failure"
              ? "积分与用量加载失败"
              : `已显示 ${page?.items.length ?? 0} 条 Run 用量记录${page?.nextCursor === null ? "" : "，还有更多记录"}`}
        </div>

        <div
          aria-busy={resultSurface === "loading" || isLoadingMore}
          className="account-usage-dialog__body"
        >
          {resultSurface === "loading" ? (
            <div className="account-usage-loading" role="status">
              <span aria-hidden="true" />
              <strong>正在加载积分与用量</strong>
            </div>
          ) : resultSurface === "failure" && initialLoadError !== null ? (
            <div className="account-usage-failure" role="alert">
              <AlertIcon />
              <strong>暂时无法加载积分与用量</strong>
              <p>{initialLoadError}</p>
              <button
                onClick={handleRetryInitialLoad}
                type="button"
              >
                <RefreshIcon />
                重新加载
              </button>
            </div>
          ) : page === null ? null : (
            <AccountUsageReadyContent
              isLoadingMore={isLoadingMore}
              loadMoreError={loadMoreError}
              onLoadMore={() => void handleLoadMore()}
              page={page}
            />
          )}
        </div>
      </section>
    </div>
  );
}
