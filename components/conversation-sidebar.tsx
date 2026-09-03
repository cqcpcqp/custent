"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { AccountUsageDialog } from "@/components/account-usage-dialog";
import {
  SettingsDialog,
  type DataControlMutationResult,
} from "@/components/settings-dialog";
import {
  conversationHasOutstandingRuns,
  groupConversationSummariesByRecency,
} from "@/components/conversation-list-state";
import {
  ArchiveIcon,
  BrandMark,
  ChatIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CoinsIcon,
  DocumentIcon,
  KeyboardIcon,
  MoreIcon,
  MonitorIcon,
  MoonIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShareIcon,
  SunIcon,
  TrashIcon,
} from "@/components/icons";
import {
  focusTriggerBeforeOpeningDialog,
  menuNavigationTargetIndex,
  menuTabFocusTarget,
  type MenuNavigationKey,
} from "@/components/menu-focus";
import { useModalFocus } from "@/components/modal-focus";
import { useTheme } from "@/components/theme-provider";
import type { ThemePreference } from "@/components/theme-state";
import {
  conversationSidebarCollapsedPreferenceKey,
  parseConversationSidebarCollapsedPreference,
  serializeConversationSidebarCollapsedPreference,
  workspaceKeyboardShortcutAriaKeyShortcuts,
} from "@/components/workspace-ux-state";
import type {
  AgentRunStatus,
  BootstrapResponse,
  ConversationListView,
  ConversationSummary,
} from "@/lib/contracts";

type ConversationSidebarProps = {
  user: BootstrapResponse["user"];
  credits: BootstrapResponse["credits"];
  conversations: ConversationSummary[];
  nextCursor: string | null;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  runStatusByConversation: Record<string, AgentRunStatus | null>;
  busyConversationIds: ReadonlySet<string>;
  activeConversationId: string | null;
  conversationBrowserView: ConversationListView | null;
  isLibraryActive: boolean;
  isOpen: boolean;
  isCreating: boolean;
  mobileMenuTriggerRef?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCreate: () => void;
  onLoadMore: () => void;
  onSelect: (conversationId: string) => void;
  onOpenSearch: () => void;
  onOpenArchived: () => void;
  onOpenKeyboardShortcuts: () => void;
  onOpenLibrary: () => void;
  onRequestRename: (conversation: ConversationSummary) => void;
  onRequestShare: (conversationId: string) => void;
  onArchiveAllConversations: () => Promise<DataControlMutationResult>;
  onDeleteAllConversations: () => Promise<DataControlMutationResult>;
  onSetPinned: (
    conversation: ConversationSummary,
    pinned: boolean,
  ) => Promise<void>;
  onSetArchived: (
    conversation: ConversationSummary,
    archived: boolean,
  ) => Promise<void>;
  onRequestDelete: (conversation: ConversationSummary) => void;
};

const mobileConversationSidebarMediaQuery = "(max-width: 780px)";

function subscribeToMobileConversationSidebar(
  onStoreChange: () => void,
): () => void {
  const mediaQuery = window.matchMedia(mobileConversationSidebarMediaQuery);
  mediaQuery.addEventListener("change", onStoreChange);
  return () => mediaQuery.removeEventListener("change", onStoreChange);
}

function mobileConversationSidebarSnapshot(): boolean {
  return window.matchMedia(mobileConversationSidebarMediaQuery).matches;
}

export function conversationSidebarIsModal(
  isOpen: boolean,
  isMobileViewport: boolean,
): boolean {
  return isOpen && isMobileViewport;
}

export function conversationSidebarCanObserveLoadMore(input: {
  nextCursor: string | null;
  isLoadingMore: boolean;
  loadMoreError: string | null;
  isCollapsed: boolean;
  isMobileViewport: boolean;
  isOpen: boolean;
}): boolean {
  return (
    input.nextCursor !== null &&
    !input.isLoadingMore &&
    input.loadMoreError === null &&
    !input.isCollapsed &&
    (!input.isMobileViewport || input.isOpen)
  );
}

export function conversationSidebarLoadMoreObserverOptions(
  root: Element,
): IntersectionObserverInit {
  return {
    root,
    rootMargin: "0px 0px 220px 0px",
    threshold: 0,
  };
}

export function resolveConversationSidebarPendingReveal(input: {
  pendingConversationId: string | null;
  hasConversationNav: boolean;
  hasConversationRow: boolean;
  isCollapsed: boolean;
  isMobileViewport: boolean;
  isOpen: boolean;
}): {
  shouldReveal: boolean;
  pendingConversationId: string | null;
} {
  const shouldReveal =
    input.pendingConversationId !== null &&
    input.hasConversationNav &&
    input.hasConversationRow &&
    !input.isCollapsed &&
    (!input.isMobileViewport || input.isOpen);
  return {
    shouldReveal,
    pendingConversationId: shouldReveal ? null : input.pendingConversationId,
  };
}

export function closeConversationSidebarFromBackdrop(
  event: Pick<
    ReactMouseEvent<HTMLDivElement>,
    "currentTarget" | "preventDefault" | "target"
  >,
  onClose: () => void,
): void {
  if (event.target !== event.currentTarget) {
    return;
  }

  // Keep the browser's mousedown default from overriding the modal hook's
  // focus restoration after the drawer closes.
  event.preventDefault();
  onClose();
}

type VerticalBoundsElement = {
  getBoundingClientRect: () => Pick<DOMRectReadOnly, "bottom" | "top">;
};

type RevealableConversationRow = VerticalBoundsElement & {
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
};

type ConversationMenuTriggerBounds = Pick<
  DOMRectReadOnly,
  "bottom" | "right" | "top"
>;

export type ConversationMenuPosition = {
  left: number;
  top: number;
};

const conversationMenuWidth = 168;
export const conversationMenuHeight = 191;
const conversationMenuGap = 5;
const conversationMenuViewportGutter = 8;

export function conversationMenuPosition(input: {
  trigger: ConversationMenuTriggerBounds;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth?: number;
  menuHeight?: number;
  gap?: number;
  gutter?: number;
}): ConversationMenuPosition {
  const menuWidth = input.menuWidth ?? conversationMenuWidth;
  const menuHeight = input.menuHeight ?? conversationMenuHeight;
  const gap = input.gap ?? conversationMenuGap;
  const gutter = input.gutter ?? conversationMenuViewportGutter;
  const maximumLeft = Math.max(
    gutter,
    input.viewportWidth - gutter - menuWidth,
  );
  const left = Math.max(
    gutter,
    Math.min(input.trigger.right - menuWidth, maximumLeft),
  );
  const belowTop = input.trigger.bottom + gap;
  const aboveTop = input.trigger.top - gap - menuHeight;
  const maximumTop = Math.max(
    gutter,
    input.viewportHeight - gutter - menuHeight,
  );
  const preferredTop =
    belowTop + menuHeight <= input.viewportHeight - gutter
      ? belowTop
      : aboveTop >= gutter
        ? aboveTop
        : belowTop;
  return {
    left,
    top: Math.max(gutter, Math.min(preferredTop, maximumTop)),
  };
}

export function revealConversationRowIfOutsideViewport(
  viewport: VerticalBoundsElement,
  row: RevealableConversationRow,
): boolean {
  const viewportBounds = viewport.getBoundingClientRect();
  const rowBounds = row.getBoundingClientRect();
  if (
    rowBounds.top >= viewportBounds.top &&
    rowBounds.bottom <= viewportBounds.bottom
  ) {
    return false;
  }

  row.scrollIntoView({ block: "nearest" });
  return true;
}

const runStatusLabels: Record<AgentRunStatus, string> = {
  waiting: "队列已暂停",
  queued: "排队中",
  running: "研究中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  reconciliation_required: "待对账",
};

const themeOptions = [
  { preference: "light", label: "浅色", icon: SunIcon },
  { preference: "dark", label: "深色", icon: MoonIcon },
  { preference: "system", label: "跟随系统", icon: MonitorIcon },
] as const satisfies ReadonlyArray<{
  preference: ThemePreference;
  label: string;
  icon: typeof SunIcon;
}>;

export function ConversationSidebar({
  user,
  credits,
  conversations,
  nextCursor,
  isLoadingMore,
  loadMoreError,
  runStatusByConversation,
  busyConversationIds,
  activeConversationId,
  conversationBrowserView,
  isLibraryActive,
  isOpen,
  isCreating,
  mobileMenuTriggerRef,
  onClose,
  onCreate,
  onLoadMore,
  onSelect,
  onOpenSearch,
  onOpenArchived,
  onOpenKeyboardShortcuts,
  onOpenLibrary,
  onRequestRename,
  onRequestShare,
  onArchiveAllConversations,
  onDeleteAllConversations,
  onSetPinned,
  onSetArchived,
  onRequestDelete,
}: ConversationSidebarProps) {
  const { preference: themePreference, setPreference: setThemePreference } =
    useTheme();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [openMenuPosition, setOpenMenuPosition] = useState<
    (ConversationMenuPosition & { conversationId: string }) | null
  >(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isAccountUsageOpen, setIsAccountUsageOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isMobileViewport = useSyncExternalStore(
    subscribeToMobileConversationSidebar,
    mobileConversationSidebarSnapshot,
    () => false,
  );
  const isMobileModalOpen = conversationSidebarIsModal(
    isOpen,
    isMobileViewport,
  );
  const backdropRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [sidebarPortalTarget, setSidebarPortalTarget] =
    useState<HTMLElement | null>(null);
  const setSidebarNode = useCallback((node: HTMLElement | null) => {
    sidebarRef.current = node;
    setSidebarPortalTarget(node);
  }, []);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const conversationNavRef = useRef<HTMLElement>(null);
  const pendingConversationRevealRef = useRef<string | null>(
    activeConversationId,
  );
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const conversationRowRefs = useRef(new Map<string, HTMLDivElement>());
  const menuPanelRefs = useRef(new Map<string, HTMLDivElement>());
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const userMenuRootRef = useRef<HTMLDivElement>(null);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const accountUsageTriggerRef = useRef<HTMLButtonElement>(null);
  const themeOptionRefs = useRef(new Map<ThemePreference, HTMLButtonElement>());
  const pinnedConversations = conversations.filter(
    (conversation) => conversation.pinnedAt !== null,
  );
  const recentConversations = conversations.filter(
    (conversation) => conversation.pinnedAt === null,
  );
  const recentConversationGroups = groupConversationSummariesByRecency(
    recentConversations,
    new Date(),
  );

  function closeMobileSidebar() {
    setOpenMenuId(null);
    setIsUserMenuOpen(false);
    onClose();
  }

  function commitSidebarCollapsedPreference(nextIsCollapsed: boolean) {
    setIsCollapsed(nextIsCollapsed);
    window.localStorage.setItem(
      conversationSidebarCollapsedPreferenceKey,
      serializeConversationSidebarCollapsedPreference(nextIsCollapsed),
    );
  }

  useModalFocus({
    backdropRef,
    canClose: openMenuId === null && !isUserMenuOpen,
    containerRef: sidebarRef,
    enabled: isMobileModalOpen,
    initialFocusRef: closeButtonRef,
    onClose: closeMobileSidebar,
    returnFocusRef: mobileMenuTriggerRef,
  });

  useEffect(() => {
    const storedPreference = parseConversationSidebarCollapsedPreference(
      window.localStorage.getItem(conversationSidebarCollapsedPreferenceKey),
    );
    if (storedPreference === null) {
      return;
    }

    const restoreTimer = window.setTimeout(() => {
      setIsCollapsed(storedPreference);
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  const revealPendingConversationRow = useCallback(() => {
    const pendingConversationId = pendingConversationRevealRef.current;
    const conversationNav = conversationNavRef.current;
    const pendingConversationRow =
      pendingConversationId === null
        ? undefined
        : conversationRowRefs.current.get(pendingConversationId);
    const resolution = resolveConversationSidebarPendingReveal({
      pendingConversationId,
      hasConversationNav: conversationNav !== null,
      hasConversationRow: pendingConversationRow !== undefined,
      isCollapsed,
      isMobileViewport,
      isOpen,
    });
    if (
      !resolution.shouldReveal ||
      conversationNav === null ||
      pendingConversationRow === undefined
    ) {
      return;
    }

    revealConversationRowIfOutsideViewport(
      conversationNav,
      pendingConversationRow,
    );
    pendingConversationRevealRef.current = resolution.pendingConversationId;
  }, [isCollapsed, isMobileViewport, isOpen]);

  useEffect(() => {
    pendingConversationRevealRef.current = activeConversationId;
    revealPendingConversationRow();
  }, [activeConversationId, revealPendingConversationRow]);

  useEffect(() => {
    revealPendingConversationRow();
  }, [conversations, revealPendingConversationRow]);

  useEffect(() => {
    if (
      !conversationSidebarCanObserveLoadMore({
        nextCursor,
        isLoadingMore,
        loadMoreError,
        isCollapsed,
        isMobileViewport,
        isOpen,
      })
    ) {
      return;
    }

    const conversationNav = conversationNavRef.current;
    const loadMoreSentinel = loadMoreSentinelRef.current;
    if (conversationNav === null || loadMoreSentinel === null) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      observer.disconnect();
      onLoadMore();
    }, conversationSidebarLoadMoreObserverOptions(conversationNav));
    observer.observe(loadMoreSentinel);
    return () => observer.disconnect();
  }, [
    isCollapsed,
    isLoadingMore,
    isMobileViewport,
    isOpen,
    loadMoreError,
    nextCursor,
    onLoadMore,
  ]);

  useEffect(() => {
    if (openMenuId === null) {
      return;
    }

    const activeMenuId = openMenuId;
    const focusFrame = window.requestAnimationFrame(() => {
      const menuPanel = menuPanelRefs.current.get(activeMenuId);
      menuPanel
        ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")
        ?.focus();
    });

    function closeAndRestoreFocus() {
      setOpenMenuId(null);
      window.requestAnimationFrame(() =>
        menuTriggerRefs.current.get(activeMenuId)?.focus(),
      );
    }

    function handlePointerDown(event: PointerEvent) {
      const menuPanel = menuPanelRefs.current.get(activeMenuId);
      const menuTrigger = menuTriggerRefs.current.get(activeMenuId);
      if (
        event.target instanceof Node &&
        !menuPanel?.contains(event.target) &&
        !menuTrigger?.contains(event.target)
      ) {
        setOpenMenuId(null);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    }

    function handleViewportChange() {
      setOpenMenuId(null);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [openMenuId]);

  useEffect(() => {
    if (!isUserMenuOpen) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      themeOptionRefs.current.get(themePreference)?.focus();
    });

    function closeAndRestoreFocus() {
      setIsUserMenuOpen(false);
      window.requestAnimationFrame(() => userMenuTriggerRef.current?.focus());
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !userMenuRootRef.current?.contains(event.target)
      ) {
        setIsUserMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeAndRestoreFocus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isUserMenuOpen, themePreference]);

  function handleUserMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      event.preventDefault();
      const target = menuTabFocusTarget(
        event.currentTarget,
        openMenuId === null
          ? document.activeElement
          : (menuTriggerRefs.current.get(openMenuId) ?? document.activeElement),
        event.shiftKey,
      );
      setIsUserMenuOpen(false);
      window.requestAnimationFrame(() => target?.focus());
      return;
    }

    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const itemElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem'], [role='menuitemradio']",
      ),
    );
    const activeIndex = itemElements.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex = menuNavigationTargetIndex({
      activeIndex,
      itemCount: itemElements.length,
      key: event.key as MenuNavigationKey,
    });

    if (nextIndex !== null) {
      event.preventDefault();
      itemElements[nextIndex]?.focus();
    }
  }

  function handleConversationMenuKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "Tab") {
      event.preventDefault();
      const trigger =
        openMenuId === null
          ? null
          : (menuTriggerRefs.current.get(openMenuId) ?? null);
      const target = menuTabFocusTarget(
        event.currentTarget,
        trigger ?? document.activeElement,
        event.shiftKey,
      );
      setOpenMenuId(null);
      window.requestAnimationFrame(() => target?.focus());
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const itemElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']:not(:disabled)",
      ),
    );
    const activeIndex = itemElements.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const nextIndex = menuNavigationTargetIndex({
      activeIndex,
      itemCount: itemElements.length,
      key: event.key as MenuNavigationKey,
    });
    if (nextIndex !== null) {
      event.preventDefault();
      itemElements[nextIndex]?.focus();
    }
  }

  function renderConversation(conversation: ConversationSummary) {
    const isActive =
      !isLibraryActive && conversation.id === activeConversationId;
    const runStatus = runStatusByConversation[conversation.id];
    const isBusy = busyConversationIds.has(conversation.id);
    const hasOutstandingRun = conversationHasOutstandingRuns(conversation);
    const isPinned = conversation.pinnedAt !== null;
    const isMenuOpen = openMenuId === conversation.id;
    const menuPortalTarget = isMenuOpen
      ? isMobileViewport
        ? sidebarPortalTarget
        : document.body
      : null;
    const menuId = `conversation-menu-${conversation.id}`;
    const protectedActionTitle = hasOutstandingRun
      ? "该对话仍有正在运行或等待中的研究，请先停止或取消后再操作"
      : undefined;

    return (
      <div
        className={`conversation-row${
          isActive ? " conversation-row--active" : ""
        }`}
        key={conversation.id}
        ref={(node) => {
          if (node === null) {
            conversationRowRefs.current.delete(conversation.id);
          } else {
            conversationRowRefs.current.set(conversation.id, node);
          }
        }}
      >
        <button
          aria-current={isActive ? "page" : undefined}
          className={`conversation-link${
            isActive ? " conversation-link--active" : ""
          }`}
          onClick={() => onSelect(conversation.id)}
          type="button"
        >
          <span className="conversation-link__copy">
            <strong title={conversation.title}>{conversation.title}</strong>
            {conversation.attention === null && runStatus === null ? null : (
              <span className="conversation-link__signals">
                {conversation.attention === null ? null : (
                  <i
                    aria-label="有新的运行结果"
                    className="conversation-attention-dot"
                    role="img"
                    title="有新的运行结果"
                  />
                )}
                {runStatus === null ? null : (
                  <span
                    aria-label={`运行状态：${runStatusLabels[runStatus]}`}
                    className={`conversation-run-status conversation-run-status--${runStatus}`}
                    role="img"
                    title={runStatusLabels[runStatus]}
                  >
                    <i aria-hidden="true" />
                  </span>
                )}
              </span>
            )}
          </span>
        </button>

        <div className="conversation-row__actions">
          <button
            aria-controls={menuId}
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            aria-label={`对话操作：${conversation.title}`}
            className="conversation-more-button"
            disabled={isBusy}
            onClick={(event) => {
              setIsUserMenuOpen(false);
              if (isMenuOpen) {
                setOpenMenuId(null);
                setOpenMenuPosition(null);
                return;
              }
              const trigger = event.currentTarget.getBoundingClientRect();
              setOpenMenuPosition({
                conversationId: conversation.id,
                ...conversationMenuPosition({
                  trigger,
                  viewportHeight: window.innerHeight,
                  viewportWidth: window.innerWidth,
                }),
              });
              setOpenMenuId(conversation.id);
            }}
            ref={(node) => {
              if (node === null) {
                menuTriggerRefs.current.delete(conversation.id);
              } else {
                menuTriggerRefs.current.set(conversation.id, node);
              }
            }}
            type="button"
          >
            <MoreIcon />
          </button>

          {isMenuOpen &&
          menuPortalTarget !== null &&
          openMenuPosition?.conversationId === conversation.id
            ? createPortal(
                <div
                  aria-label={`管理对话：${conversation.title}`}
                  className="conversation-menu"
                  id={menuId}
                  onKeyDown={handleConversationMenuKeyDown}
                  ref={(node) => {
                    if (node === null) {
                      menuPanelRefs.current.delete(conversation.id);
                    } else {
                      menuPanelRefs.current.set(conversation.id, node);
                    }
                  }}
                  role="menu"
                  style={{
                    left: openMenuPosition.left,
                    top: openMenuPosition.top,
                  }}
                >
                  <button
                    onClick={() => {
                      focusTriggerBeforeOpeningDialog(
                        menuTriggerRefs.current.get(conversation.id) ?? null,
                        () => {
                          setOpenMenuId(null);
                          onRequestRename(conversation);
                        },
                      );
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <PencilIcon />
                    重命名
                  </button>
                  <button
                    onClick={() => {
                      focusTriggerBeforeOpeningDialog(
                        menuTriggerRefs.current.get(conversation.id) ?? null,
                        () => {
                          setOpenMenuId(null);
                          onRequestShare(conversation.id);
                        },
                      );
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <ShareIcon />
                    分享
                  </button>
                  <button
                    onClick={() => {
                      setOpenMenuId(null);
                      void onSetPinned(conversation, !isPinned);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <PinIcon />
                    {isPinned ? "取消置顶" : "置顶"}
                  </button>
                  <button
                    disabled={hasOutstandingRun}
                    onClick={() => {
                      setOpenMenuId(null);
                      void onSetArchived(conversation, true);
                    }}
                    role="menuitem"
                    title={protectedActionTitle}
                    type="button"
                  >
                    <ArchiveIcon />
                    归档
                  </button>
                  <div
                    className="conversation-menu__separator"
                    role="separator"
                  />
                  <button
                    className="conversation-menu__danger"
                    disabled={hasOutstandingRun}
                    onClick={() => {
                      focusTriggerBeforeOpeningDialog(
                        menuTriggerRefs.current.get(conversation.id) ?? null,
                        () => {
                          setOpenMenuId(null);
                          onRequestDelete(conversation);
                        },
                      );
                    }}
                    role="menuitem"
                    title={protectedActionTitle}
                    type="button"
                  >
                    <TrashIcon />
                    删除
                  </button>
                </div>,
                menuPortalTarget,
              )
            : null}
        </div>
      </div>
    );
  }

  function handleBackdropMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    closeConversationSidebarFromBackdrop(event, closeMobileSidebar);
  }

  return (
    <>
      <div
        aria-hidden="true"
        className={`sidebar-backdrop${isOpen ? " sidebar-backdrop--visible" : ""}`}
        data-modal-layer={isMobileModalOpen ? "" : undefined}
        onMouseDown={handleBackdropMouseDown}
        ref={backdropRef}
      />
      <aside
        aria-label="会话侧边栏"
        aria-modal={isMobileModalOpen ? "true" : undefined}
        className={`sidebar${isOpen ? " sidebar--open" : ""}${
          isCollapsed ? " sidebar--collapsed" : ""
        }`}
        id="conversation-sidebar"
        ref={setSidebarNode}
        role={isMobileModalOpen ? "dialog" : undefined}
        tabIndex={isMobileModalOpen ? -1 : undefined}
      >
        <div className="sidebar__brand-row">
          <div className="brand-lockup">
            <span className="brand-lockup__mark">
              <BrandMark />
            </span>
            <span>
              <strong>外贸研究助手</strong>
              <small>Trade Intelligence</small>
            </span>
          </div>
          <button
            aria-controls="conversation-nav"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? "展开会话侧边栏" : "折叠会话侧边栏"}
            className="icon-button sidebar__collapse"
            onClick={() => {
              const nextIsCollapsed = !isCollapsed;
              setOpenMenuId(null);
              setIsUserMenuOpen(false);
              commitSidebarCollapsedPreference(nextIsCollapsed);
            }}
            title={isCollapsed ? "展开侧边栏" : "折叠侧边栏"}
            type="button"
          >
            {isCollapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
          </button>
          <button
            aria-label="关闭会话侧边栏"
            className="icon-button sidebar__close"
            onClick={closeMobileSidebar}
            ref={closeButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <button
          aria-keyshortcuts={
            workspaceKeyboardShortcutAriaKeyShortcuts.new_conversation
          }
          aria-label={isCreating ? "正在创建新研究" : "新建研究"}
          className="new-conversation-button"
          disabled={isCreating}
          onClick={onCreate}
          title="新建研究"
          type="button"
        >
          <PlusIcon />
          <span>{isCreating ? "正在创建…" : "新建研究"}</span>
        </button>

        <div className="sidebar__conversation-tools">
          <button
            aria-controls="conversation-browser-dialog"
            aria-expanded={conversationBrowserView === "active"}
            aria-haspopup="dialog"
            aria-keyshortcuts={
              workspaceKeyboardShortcutAriaKeyShortcuts.search_conversations
            }
            aria-label="搜索对话"
            onClick={onOpenSearch}
            title="搜索对话"
            type="button"
          >
            <SearchIcon />
            <span>搜索对话</span>
            <kbd aria-hidden="true">⌘ K</kbd>
          </button>
          <button
            aria-current={isLibraryActive ? "page" : undefined}
            aria-label="资料库"
            className={
              isLibraryActive ? "sidebar__workspace-link--active" : undefined
            }
            onClick={onOpenLibrary}
            title="资料库"
            type="button"
          >
            <DocumentIcon />
            <span>资料库</span>
          </button>
          <button
            aria-controls="conversation-browser-dialog"
            aria-expanded={conversationBrowserView === "archived"}
            aria-haspopup="dialog"
            aria-label="已归档"
            onClick={onOpenArchived}
            title="已归档"
            type="button"
          >
            <ArchiveIcon />
            <span>已归档</span>
          </button>
        </div>

        <nav
          aria-label="对话列表"
          aria-busy={isLoadingMore ? true : undefined}
          className="conversation-nav"
          id="conversation-nav"
          ref={conversationNavRef}
        >
          {conversations.length === 0 ? (
            <div className="conversation-nav__empty">
              <ChatIcon />
              <p>研究记录会出现在这里</p>
            </div>
          ) : (
            <>
              {pinnedConversations.length === 0 ? null : (
                <section
                  aria-labelledby="pinned-conversations-heading"
                  className="conversation-nav__group"
                >
                  <div className="sidebar__section-heading">
                    <span id="pinned-conversations-heading">置顶</span>
                  </div>
                  {pinnedConversations.map(renderConversation)}
                </section>
              )}
              {recentConversationGroups.map((group) => {
                const headingId = `conversation-${group.key}-heading`;
                return (
                  <section
                    aria-labelledby={headingId}
                    className="conversation-nav__group"
                    key={group.key}
                  >
                    <div className="sidebar__section-heading">
                      <span id={headingId}>{group.label}</span>
                    </div>
                    {group.conversations.map(renderConversation)}
                  </section>
                );
              })}
            </>
          )}
          {loadMoreError !== null ? (
            <div
              className="conversation-nav__pagination conversation-nav__pagination--error"
              role="alert"
            >
              <p>
                <strong>加载更多对话失败</strong>
                <span>{loadMoreError}</span>
              </p>
              <button
                aria-label="重试加载更多对话"
                disabled={isLoadingMore}
                onClick={onLoadMore}
                type="button"
              >
                重试
              </button>
            </div>
          ) : isLoadingMore ? (
            <div
              aria-live="polite"
              className="conversation-nav__pagination conversation-nav__pagination--loading"
              role="status"
            >
              正在加载更多对话…
            </div>
          ) : nextCursor !== null ? (
            <div
              aria-hidden="true"
              className="conversation-nav__load-sentinel"
              ref={loadMoreSentinelRef}
            />
          ) : null}
        </nav>

        <div className="sidebar__footer">
          <button
            aria-controls="account-usage-dialog"
            aria-expanded={isAccountUsageOpen}
            aria-haspopup="dialog"
            aria-label="积分余额"
            className="credit-card"
            onClick={() => {
              setOpenMenuId(null);
              setIsUserMenuOpen(false);
              setIsAccountUsageOpen(true);
            }}
            ref={accountUsageTriggerRef}
            title={`可用研究积分 ${credits.available.toLocaleString("zh-CN")}`}
            type="button"
          >
            <span className="credit-card__icon">
              <CoinsIcon />
            </span>
            <span className="credit-card__copy">
              <small>可用研究积分</small>
              <strong>{credits.available.toLocaleString("zh-CN")}</strong>
            </span>
            <span className="credit-card__reserved">
              预留/冻结 {credits.reserved.toLocaleString("zh-CN")}
            </span>
          </button>

          <div className="user-menu-root" ref={userMenuRootRef}>
            <button
              aria-controls="workspace-user-menu"
              aria-expanded={isUserMenuOpen}
              aria-haspopup="menu"
              aria-label={`${user.name}，打开用户菜单`}
              className="user-card"
              onClick={() => {
                setOpenMenuId(null);
                setIsUserMenuOpen((current) => !current);
              }}
              ref={userMenuTriggerRef}
              type="button"
            >
              <span className="user-card__avatar" aria-hidden="true">
                {user.name.slice(0, 1)}
              </span>
              <span className="user-card__copy">
                <strong>{user.name}</strong>
                <small>研究工作区</small>
              </span>
              <MoreIcon />
            </button>

            {isUserMenuOpen ? (
              <div
                aria-label="用户菜单"
                className="user-menu"
                id="workspace-user-menu"
                onKeyDown={handleUserMenuKeyDown}
                role="menu"
              >
                <button
                  aria-controls="workspace-settings-dialog"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setIsUserMenuOpen(false);
                    setIsSettingsOpen(true);
                  }}
                  role="menuitem"
                  type="button"
                >
                  <SettingsIcon />
                  <span>设置</span>
                </button>
                <button
                  aria-controls="keyboard-shortcuts-dialog"
                  aria-haspopup="dialog"
                  aria-keyshortcuts={
                    workspaceKeyboardShortcutAriaKeyShortcuts.show_shortcuts
                  }
                  onClick={() => {
                    focusTriggerBeforeOpeningDialog(
                      userMenuTriggerRef.current,
                      () => {
                        setIsUserMenuOpen(false);
                        onOpenKeyboardShortcuts();
                      },
                    );
                  }}
                  role="menuitem"
                  type="button"
                >
                  <KeyboardIcon />
                  <span>快捷键</span>
                </button>
                <div className="user-menu__separator" role="separator" />
                <div className="user-menu__heading" role="presentation">
                  <span>外观</span>
                  <small>选择界面主题</small>
                </div>
                {themeOptions.map((option) => {
                  const ThemeIcon = option.icon;
                  const isSelected = option.preference === themePreference;
                  return (
                    <button
                      aria-checked={isSelected}
                      className={
                        isSelected ? "user-menu__option--selected" : undefined
                      }
                      key={option.preference}
                      onClick={() => {
                        setThemePreference(option.preference);
                        setIsUserMenuOpen(false);
                        window.requestAnimationFrame(() =>
                          userMenuTriggerRef.current?.focus(),
                        );
                      }}
                      ref={(node) => {
                        if (node === null) {
                          themeOptionRefs.current.delete(option.preference);
                        } else {
                          themeOptionRefs.current.set(option.preference, node);
                        }
                      }}
                      role="menuitemradio"
                      type="button"
                    >
                      <ThemeIcon />
                      <span>{option.label}</span>
                      {isSelected ? <CheckIcon /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </aside>
      {isAccountUsageOpen ? (
        <AccountUsageDialog
          onClose={() => setIsAccountUsageOpen(false)}
          returnFocusRef={accountUsageTriggerRef}
        />
      ) : null}
      {isSettingsOpen ? (
        <SettingsDialog
          isSidebarCollapsed={isCollapsed}
          onArchiveAllConversations={onArchiveAllConversations}
          onClose={() => setIsSettingsOpen(false)}
          onDeleteAllConversations={onDeleteAllConversations}
          onSidebarCollapsedChange={commitSidebarCollapsedPreference}
          returnFocusRef={userMenuTriggerRef}
        />
      ) : null}
    </>
  );
}
