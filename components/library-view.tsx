"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
  type UIEvent,
} from "react";

import { ArtifactViewer } from "@/components/artifact-viewer";
import { BackgroundRunCenterTrigger } from "@/components/background-run-center";
import {
  AlertIcon,
  ChartIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentIcon,
  ExternalLinkIcon,
  MenuIcon,
  PeopleIcon,
  RefreshIcon,
  SearchIcon,
} from "@/components/icons";
import {
  fetchLibraryArtifactPage,
  fetchLibraryResearchDetail,
  fetchLibraryResearchPage,
  isLibraryAbortError,
  libraryDetailRequestCanCommit,
  libraryErrorMessage,
  libraryInitialPageRequest,
  libraryMergePage,
  libraryNextPageRequest,
  libraryPageForRender,
  libraryPageRequestCanCommit,
  libraryRequestKey,
  libraryResultSurface,
  libraryScrollIsNearEnd,
  libraryTabForKey,
  type LibraryArtifactPageState,
  type LibraryResearchPageState,
  type LibraryResultSurface,
  type LibraryTab,
} from "@/components/library-state";
import type {
  LibraryArtifactItem,
  LibraryResearchContact,
  LibraryResearchDetail,
  LibraryResearchEvidence,
  LibraryResearchItem,
} from "@/lib/contracts";

const libraryDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const companyTypeLabels = {
  importer: "进口商",
  distributor: "分销商",
  retailer: "零售商",
  brand: "品牌方",
  manufacturer: "制造商",
  industrial_end_user: "工业终端用户",
  other: "其他",
} satisfies Record<LibraryResearchDetail["companies"][number]["companyType"], string>;

const contactRoleLabels = {
  procurement: "采购管理",
  purchasing: "采购",
  sourcing: "寻源",
  buyer: "买手 / 买家",
  category_product: "品类 / 产品",
  supply_chain: "供应链",
  operations: "运营",
  engineering_project: "工程 / 项目",
  owner_executive: "所有者 / 高管",
  business_development: "业务拓展",
  other: "其他",
} satisfies Record<LibraryResearchContact["roleCategory"], string>;

const evidenceSupportLabels = {
  company_identity: "公司身份",
  business_fit: "业务匹配",
  contact_role: "联系人职能",
} satisfies Record<LibraryResearchEvidence["supports"], string>;

type LibraryLoadingMoreRequest = Readonly<{
  controller: AbortController;
  cursor: string;
  requestKey: string;
  tab: LibraryTab;
}>;

type LibraryPageActionError = Readonly<{
  message: string;
  requestKey: string;
}>;

type LibraryResearchDetailState =
  | Readonly<{
      snapshotId: string;
      status: "loading";
    }>
  | Readonly<{
      error: string;
      snapshotId: string;
      status: "failure";
    }>
  | Readonly<{
      research: LibraryResearchDetail;
      snapshotId: string;
      status: "ready";
    }>;

export type LibraryViewProps = {
  backgroundRunCenterTriggerRef: RefObject<HTMLButtonElement | null>;
  backgroundRunCount: number;
  snapshotId: string | null;
  tab: LibraryTab;
  refreshVersion: number;
  isSidebarOpen: boolean;
  isBackgroundRunCenterOpen: boolean;
  mobileMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenBackgroundRunCenter: () => void;
  onOpenSidebar: () => void;
  onOpenConversation: (conversationId: string) => void;
  onNavigateSnapshot: (snapshotId: string | null) => void;
  onNavigateTab: (tab: LibraryTab) => void;
};

function formatLibraryDate(createdAt: string): string {
  return libraryDateFormatter.format(new Date(createdAt));
}

function sourceHost(sourceUrl: string): string {
  return new URL(sourceUrl).hostname.replace(/^www\./u, "");
}

function tabLabel(tab: LibraryTab): string {
  return tab === "research" ? "研究快照" : "生成文件";
}

export function LibraryHeader({
  backButtonRef,
  backgroundRunCenterTriggerRef,
  backgroundRunCount,
  isBackgroundRunCenterOpen,
  isSidebarOpen,
  mobileMenuTriggerRef,
  onBack,
  onOpenBackgroundRunCenter,
  onOpenSidebar,
  title,
}: {
  backButtonRef?: RefObject<HTMLButtonElement | null>;
  backgroundRunCenterTriggerRef: RefObject<HTMLButtonElement | null>;
  backgroundRunCount: number;
  isBackgroundRunCenterOpen: boolean;
  isSidebarOpen: boolean;
  mobileMenuTriggerRef: RefObject<HTMLButtonElement | null>;
  onBack?: () => void;
  onOpenBackgroundRunCenter: () => void;
  onOpenSidebar: () => void;
  title: string;
}) {
  return (
    <header className="library-header">
      <div className="library-header__identity">
        <button
          aria-controls="conversation-sidebar"
          aria-expanded={isSidebarOpen}
          aria-label="打开会话侧边栏"
          className="icon-button library-header__menu"
          onClick={onOpenSidebar}
          ref={mobileMenuTriggerRef}
          type="button"
        >
          <MenuIcon />
        </button>
        {onBack === undefined ? null : (
          <button
            aria-label="返回资料库"
            className="icon-button library-header__back"
            onClick={onBack}
            ref={backButtonRef}
            type="button"
          >
            <ChevronLeftIcon />
          </button>
        )}
        <span>
          <small>{onBack === undefined ? "研究资产" : "研究快照"}</small>
          <strong id="library-title">{title}</strong>
        </span>
      </div>
      <BackgroundRunCenterTrigger
        className="library-header__activity"
        count={backgroundRunCount}
        isOpen={isBackgroundRunCenterOpen}
        onOpen={onOpenBackgroundRunCenter}
        triggerRef={backgroundRunCenterTriggerRef}
      />
    </header>
  );
}

export function LibraryLoading({ tab }: { tab: LibraryTab }) {
  return (
    <div className="library-loading" role="status">
      <span aria-hidden="true" className="library-loading__spinner" />
      <strong>正在加载{tabLabel(tab)}</strong>
    </div>
  );
}

export function LibraryLoadFailure({
  message,
  onRetry,
  tab,
}: {
  message: string;
  onRetry: () => void;
  tab: LibraryTab;
}) {
  return (
    <div className="library-failure" role="alert">
      <AlertIcon />
      <strong>暂时无法加载{tabLabel(tab)}</strong>
      <p>{message}</p>
      <button onClick={onRetry} type="button">
        <RefreshIcon />
        重新加载
      </button>
    </div>
  );
}

export function LibraryEmptyState({ tab }: { tab: LibraryTab }) {
  return (
    <div className="library-empty" role="status">
      {tab === "research" ? <ChartIcon /> : <DocumentIcon />}
      <strong>
        {tab === "research" ? "还没有研究快照" : "还没有生成文件"}
      </strong>
      <p>
        {tab === "research"
          ? "Agent 保存且已完成的结构化研究会出现在这里。"
          : "Agent 生成的 CSV 和 PDF 会出现在这里。"}
      </p>
    </div>
  );
}

function ConversationReference({
  archivedAt,
  conversationId,
  conversationTitle,
  onOpenConversation,
}: {
  archivedAt: string | null;
  conversationId: string;
  conversationTitle: string;
  onOpenConversation: (conversationId: string) => void;
}) {
  return (
    <button
      aria-label={`打开来源对话：${conversationTitle}`}
      className="library-source-conversation"
      onClick={() => onOpenConversation(conversationId)}
      type="button"
    >
      <SearchIcon />
      <span>
        <small>{archivedAt === null ? "来源对话" : "已归档来源"}</small>
        <strong>{conversationTitle}</strong>
      </span>
      <ChevronRightIcon />
    </button>
  );
}

export function LibraryResearchList({
  items,
  onNavigateSnapshot,
  onOpenConversation,
  onSnapshotTriggerChange,
}: {
  items: readonly LibraryResearchItem[];
  onNavigateSnapshot: (snapshotId: string, focusKey: string) => void;
  onOpenConversation: (conversationId: string) => void;
  onSnapshotTriggerChange?: (
    focusKey: string,
    element: HTMLButtonElement | null,
  ) => void;
}) {
  return (
    <ul aria-label="研究快照列表" className="library-card-grid library-research-list">
      {items.map((item) => {
        const focusKey = `research:${item.id}`;
        return (
          <li key={item.id}>
            <article className="library-card library-research-card">
              <button
                aria-label={`查看研究快照：${item.title}`}
                className="library-research-card__main"
                data-library-snapshot-focus-key={focusKey}
                onClick={() => onNavigateSnapshot(item.id, focusKey)}
                ref={(element) =>
                  onSnapshotTriggerChange?.(focusKey, element)
                }
                type="button"
              >
              <span className="library-card__icon">
                <ChartIcon />
              </span>
              <span className="library-card__copy">
                <strong>{item.title}</strong>
                <span>{item.querySummary}</span>
              </span>
              <span className="library-card__meta">
                <span>
                  <PeopleIcon />
                  {item.companyCount} 家公司
                </span>
                <time dateTime={item.createdAt}>
                  {formatLibraryDate(item.createdAt)}
                </time>
              </span>
              </button>
              <ConversationReference
                archivedAt={item.conversation.archivedAt}
                conversationId={item.conversation.id}
                conversationTitle={item.conversation.title}
                onOpenConversation={onOpenConversation}
              />
            </article>
          </li>
        );
      })}
    </ul>
  );
}

export function LibraryArtifactList({
  items,
  onNavigateSnapshot,
  onOpenConversation,
  onSnapshotTriggerChange,
}: {
  items: readonly LibraryArtifactItem[];
  onNavigateSnapshot: (snapshotId: string, focusKey: string) => void;
  onOpenConversation: (conversationId: string) => void;
  onSnapshotTriggerChange?: (
    focusKey: string,
    element: HTMLButtonElement | null,
  ) => void;
}) {
  return (
    <ul aria-label="生成文件列表" className="library-card-grid library-artifact-list">
      {items.map((item) => {
        const researchSnapshotId = item.researchSnapshotId;
        const snapshotFocusKey = `artifact:${item.id}`;
        return (
          <li key={item.id}>
            <article className="library-card library-artifact-card">
              <ArtifactViewer artifact={item} />
              <div className="library-artifact-card__origin">
                <span>
                  {researchSnapshotId === null
                    ? "对话生成文件"
                    : "研究快照导出"}
                </span>
                {researchSnapshotId === null ? null : (
                  <button
                    aria-label={`查看关联研究快照：${item.name}`}
                    className="library-source-conversation library-linked-research"
                    data-library-snapshot-focus-key={snapshotFocusKey}
                    onClick={() =>
                      onNavigateSnapshot(researchSnapshotId, snapshotFocusKey)
                    }
                    ref={(element) =>
                      onSnapshotTriggerChange?.(snapshotFocusKey, element)
                    }
                    type="button"
                  >
                    <ChartIcon />
                    <span>
                      <small>关联研究快照</small>
                      <strong>查看关联研究快照</strong>
                    </span>
                    <ChevronRightIcon />
                  </button>
                )}
                <ConversationReference
                  archivedAt={item.conversation.archivedAt}
                  conversationId={item.conversation.id}
                  conversationTitle={item.conversation.title}
                  onOpenConversation={onOpenConversation}
                />
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}

function EvidenceList({
  evidence,
  label,
}: {
  evidence: readonly LibraryResearchEvidence[];
  label: string;
}) {
  return (
    <ul aria-label={label} className="library-evidence-list">
      {evidence.map((item, index) => (
        <li key={`${item.sourceUrl}-${item.claim}-${index}`}>
          <span className="library-evidence-list__kind">
            {evidenceSupportLabels[item.supports]}
          </span>
          <p>{item.claim}</p>
          <a href={item.sourceUrl} rel="noreferrer" target="_blank">
            <span>
              <strong>{item.sourceTitle}</strong>
              <small>{sourceHost(item.sourceUrl)}</small>
            </span>
            <ExternalLinkIcon />
          </a>
        </li>
      ))}
    </ul>
  );
}

function ResearchContactList({
  contacts,
}: {
  contacts: readonly LibraryResearchContact[];
}) {
  if (contacts.length === 0) {
    return (
      <p className="library-company__contacts-empty" role="status">
        这家公司没有保存目标联系人。
      </p>
    );
  }

  return (
    <ul aria-label="目标联系人" className="library-contact-list">
      {contacts.map((contact, index) => (
        <li key={`${contact.name}-${contact.titleOriginal}-${index}`}>
          <div className="library-contact__identity">
            <span>
              <strong>{contact.name}</strong>
              <small>{contact.titleOriginal}</small>
            </span>
            <span className={`library-confidence library-confidence--${contact.confidence.toLowerCase()}`}>
              置信度 {contact.confidence}
            </span>
          </div>
          <div className="library-contact__meta">
            <span>{contactRoleLabels[contact.roleCategory]}</span>
            {contact.publicProfileUrl === null ? null : (
              <a
                href={contact.publicProfileUrl}
                rel="noreferrer"
                target="_blank"
              >
                公开资料
                <ExternalLinkIcon />
              </a>
            )}
          </div>
          <EvidenceList
            evidence={contact.evidence}
            label={`${contact.name} 的联系人证据`}
          />
        </li>
      ))}
    </ul>
  );
}

export function LibraryResearchDetailContent({
  onOpenConversation,
  research,
}: {
  onOpenConversation: (conversationId: string) => void;
  research: LibraryResearchDetail;
}) {
  return (
    <div className="library-research-detail">
      <section
        aria-labelledby="library-research-summary-title"
        className="library-research-detail__summary"
      >
        <div className="library-research-detail__summary-heading">
          <span className="library-card__icon">
            <ChartIcon />
          </span>
          <span>
            <h2 id="library-research-summary-title">{research.title}</h2>
            <time dateTime={research.createdAt}>
              {formatLibraryDate(research.createdAt)}
            </time>
          </span>
        </div>
        <p>{research.querySummary}</p>
        <div className="library-research-detail__summary-meta">
          <span>
            <PeopleIcon />
            {research.companyCount} 家目标公司
          </span>
          <ConversationReference
            archivedAt={research.conversation.archivedAt}
            conversationId={research.conversation.id}
            conversationTitle={research.conversation.title}
            onOpenConversation={onOpenConversation}
          />
        </div>
      </section>

      <section
        aria-labelledby="library-research-limitations-title"
        className="library-research-detail__limitations"
      >
        <h2 id="library-research-limitations-title">研究限制</h2>
        <p>{research.limitations}</p>
      </section>

      <section
        aria-labelledby="library-research-companies-title"
        className="library-research-detail__companies"
      >
        <header>
          <span>
            <PeopleIcon />
            <h2 id="library-research-companies-title">目标公司</h2>
          </span>
          <small>{research.companyCount} 家</small>
        </header>
        <ol className="library-company-list">
          {research.companies.map((company, index) => (
            <li key={company.id}>
              <article className="library-company">
                <header className="library-company__header">
                  <span className="library-company__number">{index + 1}</span>
                  <span>
                    <h3>{company.name}</h3>
                    <small>
                      {company.country} · {companyTypeLabels[company.companyType]}
                    </small>
                  </span>
                  <a href={company.websiteUrl} rel="noreferrer" target="_blank">
                    访问官网
                    <ExternalLinkIcon />
                  </a>
                </header>
                <p className="library-company__relevance">
                  {company.relevanceSummary}
                </p>
                <section aria-label={`${company.name} 的公司证据`}>
                  <h4>公司与业务证据</h4>
                  <EvidenceList
                    evidence={company.evidence}
                    label={`${company.name} 的公司证据列表`}
                  />
                </section>
                <section aria-label={`${company.name} 的目标联系人`}>
                  <h4>目标联系人</h4>
                  <ResearchContactList contacts={company.contacts} />
                </section>
              </article>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function LibraryResearchDetailSurface({
  detailState,
  onOpenConversation,
  onRetry,
}: {
  detailState: LibraryResearchDetailState;
  onOpenConversation: (conversationId: string) => void;
  onRetry: () => void;
}) {
  if (detailState.status === "loading") {
    return <LibraryLoading tab="research" />;
  }
  if (detailState.status === "failure") {
    return (
      <LibraryLoadFailure
        message={detailState.error}
        onRetry={onRetry}
        tab="research"
      />
    );
  }
  return (
    <LibraryResearchDetailContent
      onOpenConversation={onOpenConversation}
      research={detailState.research}
    />
  );
}

export function LibraryView({
  backgroundRunCenterTriggerRef,
  backgroundRunCount,
  snapshotId,
  tab,
  refreshVersion,
  isSidebarOpen,
  isBackgroundRunCenterOpen,
  mobileMenuTriggerRef,
  onOpenBackgroundRunCenter,
  onOpenSidebar,
  onOpenConversation,
  onNavigateSnapshot,
  onNavigateTab,
}: LibraryViewProps) {
  const [pageRevisions, setPageRevisions] = useState({
    research: 0,
    artifacts: 0,
  });
  const [researchPage, setResearchPage] =
    useState<LibraryResearchPageState | null>(null);
  const [artifactPage, setArtifactPage] =
    useState<LibraryArtifactPageState | null>(null);
  const [loadingMoreRequest, setLoadingMoreRequest] =
    useState<LibraryLoadingMoreRequest | null>(null);
  const [pageActionError, setPageActionError] =
    useState<LibraryPageActionError | null>(null);
  const [pageRefreshError, setPageRefreshError] =
    useState<LibraryPageActionError | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [detailState, setDetailState] =
    useState<LibraryResearchDetailState | null>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const researchTabRef = useRef<HTMLButtonElement>(null);
  const artifactTabRef = useRef<HTMLButtonElement>(null);
  const snapshotReturnFocusKeyRef = useRef<string | null>(null);
  const snapshotTriggerRefs = useRef(
    new Map<string, HTMLButtonElement>(),
  );
  const wasViewingDetailRef = useRef(snapshotId !== null);
  const pageLoadControllerRef = useRef<AbortController | null>(null);
  const loadMoreControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const requestKey = `${libraryRequestKey(tab, refreshVersion)}\u0000${pageRevisions[tab]}`;
  const currentRequestKeyRef = useRef(requestKey);
  const currentSnapshotIdRef = useRef(snapshotId);
  const visibleResearchPage = libraryPageForRender(researchPage, requestKey);
  const visibleArtifactPage = libraryPageForRender(artifactPage, requestKey);
  const visiblePage =
    tab === "research" ? visibleResearchPage : visibleArtifactPage;
  const isShowingStalePage =
    visiblePage !== null && visiblePage.requestKey !== requestKey;
  const refreshError =
    isShowingStalePage && pageRefreshError?.requestKey === requestKey
      ? pageRefreshError.message
      : null;
  const isRefreshing = isShowingStalePage && refreshError === null;
  const items =
    tab === "research"
      ? (visibleResearchPage?.items ?? [])
      : (visibleArtifactPage?.items ?? []);
  const nextCursor =
    tab === "research"
      ? (visibleResearchPage?.nextCursor ?? null)
      : (visibleArtifactPage?.nextCursor ?? null);
  const initialLoadError =
    tab === "research"
      ? (visibleResearchPage?.error ?? null)
      : (visibleArtifactPage?.error ?? null);
  const isLoading =
    tab === "research"
      ? visibleResearchPage === null
      : visibleArtifactPage === null;
  const resultSurface = libraryResultSurface({
    isLoading,
    loadError: initialLoadError,
    itemCount: items.length,
  });
  const isLoadingMore =
    loadingMoreRequest?.requestKey === requestKey &&
    loadingMoreRequest.tab === tab &&
    !loadingMoreRequest.controller.signal.aborted;
  const actionError =
    pageActionError?.requestKey === requestKey
      ? pageActionError.message
      : null;
  const visibleDetailState =
    snapshotId !== null && detailState?.snapshotId === snapshotId
      ? detailState
      : snapshotId === null
        ? null
        : ({ snapshotId, status: "loading" } as const);

  const registerSnapshotTrigger = useCallback(
    (focusKey: string, element: HTMLButtonElement | null) => {
      if (element === null) {
        snapshotTriggerRefs.current.delete(focusKey);
      } else {
        snapshotTriggerRefs.current.set(focusKey, element);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    currentRequestKeyRef.current = requestKey;
    currentSnapshotIdRef.current = snapshotId;
    const loadMoreController = loadMoreControllerRef.current;
    if (loadMoreController !== null) {
      loadMoreController.abort();
      loadMoreControllerRef.current = null;
    }
  }, [requestKey, snapshotId]);

  useLayoutEffect(() => {
    const wasViewingDetail = wasViewingDetailRef.current;
    wasViewingDetailRef.current = snapshotId !== null;

    if (snapshotId !== null) {
      backButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!wasViewingDetail) {
      return;
    }

    const focusKey = snapshotReturnFocusKeyRef.current;
    snapshotReturnFocusKeyRef.current = null;
    const snapshotTrigger =
      focusKey === null ? undefined : snapshotTriggerRefs.current.get(focusKey);
    const fallbackTab =
      tab === "research" ? researchTabRef.current : artifactTabRef.current;
    (snapshotTrigger?.isConnected === true
      ? snapshotTrigger
      : fallbackTab
    )?.focus({ preventScroll: true });
  }, [snapshotId, tab]);

  useEffect(() => {
    if (snapshotId !== null) {
      return;
    }
    const controller = new AbortController();
    pageLoadControllerRef.current?.abort();
    pageLoadControllerRef.current = controller;
    const requestIsCurrent = () =>
      libraryPageRequestCanCommit({
        controller,
        currentController: pageLoadControllerRef.current,
        currentRequestKey: currentRequestKeyRef.current,
        requestKey,
      });

    if (tab === "research") {
      void fetchLibraryResearchPage(
        libraryInitialPageRequest(),
        controller.signal,
      )
        .then((response) => {
          if (requestIsCurrent()) {
            setPageRefreshError((current) =>
              current?.requestKey === requestKey ? null : current,
            );
            setResearchPage({
              requestKey,
              items: response.items,
              nextCursor: response.nextCursor,
              error: null,
            });
          }
        })
        .catch((error: unknown) => {
          if (requestIsCurrent() && !isLibraryAbortError(error)) {
            const message = libraryErrorMessage(error);
            setPageRefreshError({ message, requestKey });
            setResearchPage((current) =>
              current?.error === null
                ? current
                : {
                    requestKey,
                    items: [],
                    nextCursor: null,
                    error: message,
                  },
            );
          }
        });
    } else {
      void fetchLibraryArtifactPage(
        libraryInitialPageRequest(),
        controller.signal,
      )
        .then((response) => {
          if (requestIsCurrent()) {
            setPageRefreshError((current) =>
              current?.requestKey === requestKey ? null : current,
            );
            setArtifactPage({
              requestKey,
              items: response.items,
              nextCursor: response.nextCursor,
              error: null,
            });
          }
        })
        .catch((error: unknown) => {
          if (requestIsCurrent() && !isLibraryAbortError(error)) {
            const message = libraryErrorMessage(error);
            setPageRefreshError({ message, requestKey });
            setArtifactPage((current) =>
              current?.error === null
                ? current
                : {
                    requestKey,
                    items: [],
                    nextCursor: null,
                    error: message,
                  },
            );
          }
        });
    }

    return () => {
      controller.abort();
      if (pageLoadControllerRef.current === controller) {
        pageLoadControllerRef.current = null;
      }
    };
  }, [requestKey, snapshotId, tab]);

  useEffect(() => {
    if (snapshotId === null) {
      detailControllerRef.current?.abort();
      detailControllerRef.current = null;
      return;
    }
    const controller = new AbortController();
    detailControllerRef.current?.abort();
    detailControllerRef.current = controller;
    const requestedSnapshotId = snapshotId;
    const requestIsCurrent = () =>
      libraryDetailRequestCanCommit({
        controller,
        currentController: detailControllerRef.current,
        currentSnapshotId: currentSnapshotIdRef.current,
        snapshotId: requestedSnapshotId,
      });

    void fetchLibraryResearchDetail(requestedSnapshotId, controller.signal)
      .then((response) => {
        if (requestIsCurrent()) {
          setDetailState({
            research: response.research,
            snapshotId: requestedSnapshotId,
            status: "ready",
          });
        }
      })
      .catch((error: unknown) => {
        if (requestIsCurrent() && !isLibraryAbortError(error)) {
          setDetailState({
            error: libraryErrorMessage(error),
            snapshotId: requestedSnapshotId,
            status: "failure",
          });
        }
      });

    return () => {
      controller.abort();
      if (detailControllerRef.current === controller) {
        detailControllerRef.current = null;
      }
    };
  }, [detailRevision, snapshotId]);

  useEffect(
    () => () => {
      pageLoadControllerRef.current?.abort();
      loadMoreControllerRef.current?.abort();
      detailControllerRef.current?.abort();
    },
    [],
  );

  async function handleLoadMore() {
    if (
      isShowingStalePage ||
      nextCursor === null ||
      loadMoreControllerRef.current !== null
    ) {
      return;
    }
    const controller = new AbortController();
    const requestedTab = tab;
    const requestedCursor = nextCursor;
    const requestedKey = requestKey;
    loadMoreControllerRef.current = controller;
    setLoadingMoreRequest({
      controller,
      cursor: requestedCursor,
      requestKey: requestedKey,
      tab: requestedTab,
    });
    setPageActionError(null);
    const requestIsCurrent = () =>
      libraryPageRequestCanCommit({
        controller,
        currentController: loadMoreControllerRef.current,
        currentRequestKey: currentRequestKeyRef.current,
        requestKey: requestedKey,
      });

    try {
      if (requestedTab === "research") {
        const response = await fetchLibraryResearchPage(
          libraryNextPageRequest(requestedCursor),
          controller.signal,
        );
        if (!requestIsCurrent()) {
          return;
        }
        const currentItems = visibleResearchPage?.items;
        if (currentItems === undefined) {
          throw new Error("研究快照分页缺少当前页状态");
        }
        const mergedItems = libraryMergePage(currentItems, response.items);
        setResearchPage((current) =>
          current?.requestKey === requestedKey &&
          current.nextCursor === requestedCursor
            ? {
                requestKey: requestedKey,
                items: mergedItems,
                nextCursor: response.nextCursor,
                error: null,
              }
            : current,
        );
      } else {
        const response = await fetchLibraryArtifactPage(
          libraryNextPageRequest(requestedCursor),
          controller.signal,
        );
        if (!requestIsCurrent()) {
          return;
        }
        const currentItems = visibleArtifactPage?.items;
        if (currentItems === undefined) {
          throw new Error("生成文件分页缺少当前页状态");
        }
        const mergedItems = libraryMergePage(currentItems, response.items);
        setArtifactPage((current) =>
          current?.requestKey === requestedKey &&
          current.nextCursor === requestedCursor
            ? {
                requestKey: requestedKey,
                items: mergedItems,
                nextCursor: response.nextCursor,
                error: null,
              }
            : current,
        );
      }
    } catch (error) {
      if (requestIsCurrent() && !isLibraryAbortError(error)) {
        setPageActionError({
          message: libraryErrorMessage(error),
          requestKey: requestedKey,
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

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: LibraryTab,
  ) {
    const nextTab = libraryTabForKey(currentTab, event.key);
    if (nextTab === null) {
      return;
    }
    event.preventDefault();
    setPageActionError(null);
    onNavigateTab(nextTab);
    window.requestAnimationFrame(() => {
      (nextTab === "research" ? researchTabRef : artifactTabRef).current?.focus();
    });
  }

  function handleRetryInitialPage() {
    setPageActionError(null);
    if (tab === "research") {
      setResearchPage(null);
    } else {
      setArtifactPage(null);
    }
    setPageRevisions((current) => ({
      ...current,
      [tab]: current[tab] + 1,
    }));
  }

  function handleResultsScroll(event: UIEvent<HTMLDivElement>) {
    if (
      libraryScrollIsNearEnd({
        clientHeight: event.currentTarget.clientHeight,
        scrollHeight: event.currentTarget.scrollHeight,
        scrollTop: event.currentTarget.scrollTop,
      })
    ) {
      void handleLoadMore();
    }
  }

  if (snapshotId !== null && visibleDetailState !== null) {
    const detailTitle =
      visibleDetailState.status === "ready"
        ? visibleDetailState.research.title
        : "研究快照";
    return (
      <section aria-labelledby="library-title" className="library-pane">
        <LibraryHeader
          backButtonRef={backButtonRef}
          backgroundRunCenterTriggerRef={backgroundRunCenterTriggerRef}
          backgroundRunCount={backgroundRunCount}
          isBackgroundRunCenterOpen={isBackgroundRunCenterOpen}
          isSidebarOpen={isSidebarOpen}
          mobileMenuTriggerRef={mobileMenuTriggerRef}
          onBack={() => onNavigateSnapshot(null)}
          onOpenBackgroundRunCenter={onOpenBackgroundRunCenter}
          onOpenSidebar={onOpenSidebar}
          title={detailTitle}
        />
        <main className="library-detail-scroll">
          <LibraryResearchDetailSurface
            detailState={visibleDetailState}
            onOpenConversation={onOpenConversation}
            onRetry={() => {
              setDetailState({ snapshotId, status: "loading" });
              setDetailRevision((current) => current + 1);
            }}
          />
        </main>
      </section>
    );
  }

  return (
    <section aria-labelledby="library-title" className="library-pane">
      <LibraryHeader
        backgroundRunCenterTriggerRef={backgroundRunCenterTriggerRef}
        backgroundRunCount={backgroundRunCount}
        isBackgroundRunCenterOpen={isBackgroundRunCenterOpen}
        isSidebarOpen={isSidebarOpen}
        mobileMenuTriggerRef={mobileMenuTriggerRef}
        onOpenBackgroundRunCenter={onOpenBackgroundRunCenter}
        onOpenSidebar={onOpenSidebar}
        title="资料库"
      />
      <div className="library-view">
        <div className="library-view__intro">
          <span>
            <h1>资料库</h1>
            <p>集中查看 Agent 已完成的研究快照与生成文件。</p>
          </span>
        </div>
        <div aria-label="资料类型" className="library-tabs" role="tablist">
          <button
            aria-controls="library-tab-panel"
            aria-selected={tab === "research"}
            id="library-research-tab"
            onClick={() => {
              setPageActionError(null);
              if (tab !== "research") {
                onNavigateTab("research");
              }
            }}
            onKeyDown={(event) => handleTabKeyDown(event, "research")}
            ref={researchTabRef}
            role="tab"
            tabIndex={tab === "research" ? 0 : -1}
            type="button"
          >
            <ChartIcon />
            研究快照
          </button>
          <button
            aria-controls="library-tab-panel"
            aria-selected={tab === "artifacts"}
            id="library-artifacts-tab"
            onClick={() => {
              setPageActionError(null);
              if (tab !== "artifacts") {
                onNavigateTab("artifacts");
              }
            }}
            onKeyDown={(event) => handleTabKeyDown(event, "artifacts")}
            ref={artifactTabRef}
            role="tab"
            tabIndex={tab === "artifacts" ? 0 : -1}
            type="button"
          >
            <DocumentIcon />
            生成文件
          </button>
        </div>
        <div
          aria-labelledby={
            tab === "research"
              ? "library-research-tab"
              : "library-artifacts-tab"
          }
          className="library-tab-panel"
          id="library-tab-panel"
          role="tabpanel"
        >
          <div aria-live="polite" className="library-view__status">
            {isRefreshing
              ? `正在更新${tabLabel(tab)}，继续显示 ${items.length} 项…`
              : resultSurface === "loading"
              ? `正在加载${tabLabel(tab)}…`
              : resultSurface === "failure"
                ? `${tabLabel(tab)}加载失败`
                : `${tabLabel(tab)}，已显示 ${items.length} 项${nextCursor === null ? "" : "，滚动可加载更多"}`}
          </div>
          {actionError === null ? null : (
            <div className="library-pagination-error" role="alert">
              加载更多失败：{actionError}
            </div>
          )}
          {refreshError === null ? null : (
            <div className="library-pagination-error" role="alert">
              自动刷新失败：{refreshError} 当前仍显示上次加载的结果。
            </div>
          )}
          <div
            aria-busy={
              resultSurface === "loading" || isRefreshing || isLoadingMore
            }
            className="library-results"
            onScroll={handleResultsScroll}
          >
            <LibraryResultContent
              artifactItems={visibleArtifactPage?.items ?? []}
              initialLoadError={initialLoadError}
              onNavigateSnapshot={(nextSnapshotId, focusKey) => {
                snapshotReturnFocusKeyRef.current = focusKey;
                onNavigateSnapshot(nextSnapshotId);
              }}
              onOpenConversation={onOpenConversation}
              onRetry={handleRetryInitialPage}
              onSnapshotTriggerChange={registerSnapshotTrigger}
              researchItems={visibleResearchPage?.items ?? []}
              surface={resultSurface}
              tab={tab}
            />
          </div>
          {isShowingStalePage ||
          resultSurface !== "results" ||
          nextCursor === null ? null : (
            <button
              aria-label={
                actionError === null
                  ? `加载更多${tabLabel(tab)}`
                  : `重试加载更多${tabLabel(tab)}`
              }
              className="library-load-more"
              disabled={isLoadingMore}
              onClick={() => void handleLoadMore()}
              type="button"
            >
              {isLoadingMore
                ? "正在加载…"
                : actionError === null
                  ? "加载更多"
                  : "重试加载更多"}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

export function LibraryResultContent({
  artifactItems,
  initialLoadError,
  onNavigateSnapshot,
  onOpenConversation,
  onRetry,
  onSnapshotTriggerChange,
  researchItems,
  surface,
  tab,
}: {
  artifactItems: readonly LibraryArtifactItem[];
  initialLoadError: string | null;
  onNavigateSnapshot: (snapshotId: string, focusKey: string) => void;
  onOpenConversation: (conversationId: string) => void;
  onRetry: () => void;
  onSnapshotTriggerChange?: (
    focusKey: string,
    element: HTMLButtonElement | null,
  ) => void;
  researchItems: readonly LibraryResearchItem[];
  surface: LibraryResultSurface;
  tab: LibraryTab;
}) {
  if (surface === "loading") {
    return <LibraryLoading tab={tab} />;
  }
  if (surface === "failure") {
    if (initialLoadError === null) {
      throw new Error("资料库失败状态缺少错误信息");
    }
    return (
      <LibraryLoadFailure
        message={initialLoadError}
        onRetry={onRetry}
        tab={tab}
      />
    );
  }
  if (surface === "empty") {
    return <LibraryEmptyState tab={tab} />;
  }
  return tab === "research" ? (
    <LibraryResearchList
      items={researchItems}
      onNavigateSnapshot={onNavigateSnapshot}
      onOpenConversation={onOpenConversation}
      onSnapshotTriggerChange={onSnapshotTriggerChange}
    />
  ) : (
    <LibraryArtifactList
      items={artifactItems}
      onNavigateSnapshot={onNavigateSnapshot}
      onOpenConversation={onOpenConversation}
      onSnapshotTriggerChange={onSnapshotTriggerChange}
    />
  );
}
