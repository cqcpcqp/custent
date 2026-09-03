import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeConversationSidebarFromBackdrop,
  conversationSidebarCanObserveLoadMore,
  conversationSidebarLoadMoreObserverOptions,
  conversationMenuHeight,
  conversationMenuPosition,
  conversationSidebarIsModal,
  ConversationSidebar,
  revealConversationRowIfOutsideViewport,
  resolveConversationSidebarPendingReveal,
} from "@/components/conversation-sidebar";
import type {
  AgentRunStatus,
  ConversationListView,
  ConversationSummary,
} from "@/lib/contracts";

function updatedAtDaysAgo(daysAgo: number): string {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() - daysAgo);
  return value.toISOString();
}

function conversation(
  suffix: string,
  daysAgo: number,
  pinnedAt: string | null = null,
): ConversationSummary {
  return {
    id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    title: `会话 ${suffix}`,
    updatedAt: updatedAtDaysAgo(daysAgo),
    pinnedAt,
    archivedAt: null,
    selectedRunId: null,
    activeRun: null,
    waitingRunCount: 0,
    attention: null,
  };
}

type SidebarPaginationProps = {
  nextCursor: string | null;
  isLoadingMore: boolean;
  loadMoreError: string | null;
};

type SidebarStateProps = {
  activeConversationId: string | null;
  conversationBrowserView?: ConversationListView | null;
  isLibraryActive?: boolean;
  runStatusByConversation: Record<string, AgentRunStatus | null>;
};

function renderSidebar(
  conversations: ConversationSummary[],
  pagination: SidebarPaginationProps = {
    nextCursor: null,
    isLoadingMore: false,
    loadMoreError: null,
  },
  state: SidebarStateProps = {
    activeConversationId: null,
    runStatusByConversation: Object.fromEntries(
      conversations.map((item) => [item.id, null]),
    ),
  },
): string {
  return renderToStaticMarkup(
    <ConversationSidebar
      activeConversationId={state.activeConversationId}
      busyConversationIds={new Set()}
      conversations={conversations}
      conversationBrowserView={state.conversationBrowserView ?? null}
      credits={{ available: 1000, reserved: 0 }}
      isCreating={false}
      isLibraryActive={state.isLibraryActive ?? false}
      isLoadingMore={pagination.isLoadingMore}
      isOpen
      loadMoreError={pagination.loadMoreError}
      nextCursor={pagination.nextCursor}
      onArchiveAllConversations={async () => ({
        conversationCount: 0,
        error: null,
      })}
      onClose={() => undefined}
      onCreate={() => undefined}
      onDeleteAllConversations={async () => ({
        conversationCount: 0,
        error: null,
      })}
      onLoadMore={() => undefined}
      onOpenArchived={() => undefined}
      onOpenKeyboardShortcuts={() => undefined}
      onOpenLibrary={() => undefined}
      onOpenSearch={() => undefined}
      onRequestDelete={() => undefined}
      onRequestRename={() => undefined}
      onRequestShare={() => undefined}
      onSelect={() => undefined}
      onSetArchived={async () => undefined}
      onSetPinned={async () => undefined}
      runStatusByConversation={state.runStatusByConversation}
      user={{
        id: "30000000-0000-4000-8000-000000000001",
        name: "测试用户",
      }}
    />,
  );
}

describe("conversation sidebar", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the desktop collapse control with an SSR-stable expanded state", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain('aria-label="折叠会话侧边栏"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('class="icon-button sidebar__collapse"');
    expect(markup).not.toContain("sidebar--collapsed");
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('aria-modal="true"');
  });

  it("advertises the global conversation-search shortcut beside its trigger", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain('aria-controls="conversation-browser-dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(markup).toContain('<kbd aria-hidden="true">⌘ K</kbd>');
  });

  it("reports which conversation browser trigger owns the open dialog", () => {
    const markup = renderSidebar([], undefined, {
      activeConversationId: null,
      conversationBrowserView: "archived",
      runStatusByConversation: {},
    });

    expect(markup).toContain(
      'aria-controls="conversation-browser-dialog" aria-expanded="true" aria-haspopup="dialog" aria-label="已归档"',
    );
  });

  it("advertises the global new-conversation shortcut on its existing trigger", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain(
      'aria-keyshortcuts="Meta+Shift+O Control+Shift+O" aria-label="新建研究"',
    );
  });

  it("renders the library as a first-level workspace destination", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain('aria-label="资料库"');
    expect(markup).toContain("<span>资料库</span>");
  });

  it("marks only the library destination current on the library surface", () => {
    const item = conversation("1", 0);
    const markup = renderSidebar(
      [item],
      {
        nextCursor: null,
        isLoadingMore: false,
        loadMoreError: null,
      },
      {
        activeConversationId: item.id,
        isLibraryActive: true,
        runStatusByConversation: { [item.id]: null },
      },
    );

    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).toContain(
      'aria-current="page" aria-label="资料库" class="sidebar__workspace-link--active"',
    );
    expect(markup).not.toContain("conversation-link--active");
  });

  it("uses modal semantics only for an open mobile drawer", () => {
    expect(conversationSidebarIsModal(true, true)).toBe(true);
    expect(conversationSidebarIsModal(true, false)).toBe(false);
    expect(conversationSidebarIsModal(false, true)).toBe(false);
    expect(conversationSidebarIsModal(false, false)).toBe(false);
  });

  it("uses the conversation nav as the observer root with a 220px bottom margin", () => {
    const conversationNav = {} as Element;

    expect(
      conversationSidebarLoadMoreObserverOptions(conversationNav),
    ).toEqual({
      root: conversationNav,
      rootMargin: "0px 0px 220px 0px",
      threshold: 0,
    });
  });

  it("reveals a late active row once without making later appends pending", () => {
    const pendingConversationId =
      "10000000-0000-4000-8000-000000000042";
    const waitingForRow = resolveConversationSidebarPendingReveal({
      pendingConversationId,
      hasConversationNav: true,
      hasConversationRow: false,
      isCollapsed: false,
      isMobileViewport: false,
      isOpen: false,
    });
    const rowMounted = resolveConversationSidebarPendingReveal({
      ...waitingForRow,
      hasConversationNav: true,
      hasConversationRow: true,
      isCollapsed: false,
      isMobileViewport: false,
      isOpen: false,
    });
    const ordinaryLaterAppend = resolveConversationSidebarPendingReveal({
      ...rowMounted,
      hasConversationNav: true,
      hasConversationRow: true,
      isCollapsed: false,
      isMobileViewport: false,
      isOpen: false,
    });

    expect(waitingForRow).toEqual({
      shouldReveal: false,
      pendingConversationId,
    });
    expect(rowMounted).toEqual({
      shouldReveal: true,
      pendingConversationId: null,
    });
    expect(ordinaryLaterAppend).toEqual({
      shouldReveal: false,
      pendingConversationId: null,
    });
  });

  it("keeps a late active row pending while its sidebar is not visible", () => {
    const pendingConversationId =
      "10000000-0000-4000-8000-000000000042";
    const baseInput = {
      pendingConversationId,
      hasConversationNav: true,
      hasConversationRow: true,
      isCollapsed: false,
      isMobileViewport: false,
      isOpen: false,
    };

    expect(
      resolveConversationSidebarPendingReveal({
        ...baseInput,
        isCollapsed: true,
      }),
    ).toEqual({
      shouldReveal: false,
      pendingConversationId,
    });
    expect(
      resolveConversationSidebarPendingReveal({
        ...baseInput,
        isMobileViewport: true,
      }),
    ).toEqual({
      shouldReveal: false,
      pendingConversationId,
    });
  });

  it("only observes more conversations while the visible sidebar can load", () => {
    const observableState = {
      nextCursor: "next-page",
      isLoadingMore: false,
      loadMoreError: null,
      isCollapsed: false,
      isMobileViewport: false,
      isOpen: false,
    };

    expect(conversationSidebarCanObserveLoadMore(observableState)).toBe(true);
    expect(
      conversationSidebarCanObserveLoadMore({
        ...observableState,
        nextCursor: null,
      }),
    ).toBe(false);
    expect(
      conversationSidebarCanObserveLoadMore({
        ...observableState,
        isLoadingMore: true,
      }),
    ).toBe(false);
    expect(
      conversationSidebarCanObserveLoadMore({
        ...observableState,
        loadMoreError: "请求失败",
      }),
    ).toBe(false);
    expect(
      conversationSidebarCanObserveLoadMore({
        ...observableState,
        isCollapsed: true,
      }),
    ).toBe(false);
    expect(
      conversationSidebarCanObserveLoadMore({
        ...observableState,
        isMobileViewport: true,
      }),
    ).toBe(false);
    expect(
      conversationSidebarCanObserveLoadMore({
        ...observableState,
        isMobileViewport: true,
        isOpen: true,
      }),
    ).toBe(true);
  });

  it("appends an accessible loading status without replacing conversations", () => {
    const markup = renderSidebar([conversation("1", 0)], {
      nextCursor: "next-page",
      isLoadingMore: true,
      loadMoreError: null,
    });

    expect(markup).toContain('<nav aria-label="对话列表" aria-busy="true"');
    expect(markup).toContain('<strong title="会话 1">会话 1</strong>');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在加载更多对话…");
  });

  it("appends an accessible retry after loading more conversations fails", () => {
    const markup = renderSidebar([conversation("1", 0)], {
      nextCursor: "next-page",
      isLoadingMore: false,
      loadMoreError: "网络连接已中断",
    });

    expect(markup).toContain('<strong title="会话 1">会话 1</strong>');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("加载更多对话失败");
    expect(markup).toContain("网络连接已中断");
    expect(markup).toContain('aria-label="重试加载更多对话"');
    expect(markup).toContain(">重试</button>");
  });

  it("renders an inert sentinel only while another page is available", () => {
    const paginatedMarkup = renderSidebar([], {
      nextCursor: "next-page",
      isLoadingMore: false,
      loadMoreError: null,
    });
    const terminalMarkup = renderSidebar([]);

    expect(paginatedMarkup).toContain(
      'aria-hidden="true" class="conversation-nav__load-sentinel"',
    );
    expect(terminalMarkup).not.toContain("conversation-nav__load-sentinel");
  });

  it("keeps the backdrop out of the accessibility tree", () => {
    const markup = renderSidebar([]);
    const closeLabels = markup.match(/aria-label="关闭会话侧边栏"/gu);

    expect(markup).toContain(
      '<div aria-hidden="true" class="sidebar-backdrop sidebar-backdrop--visible"></div>',
    );
    expect(closeLabels).toHaveLength(1);
    expect(markup).toContain('id="conversation-sidebar"');
  });

  it("prevents the backdrop mousedown default before closing the drawer", () => {
    const backdrop = {} as EventTarget & HTMLDivElement;
    const preventDefault = vi.fn();
    const onClose = vi.fn();

    closeConversationSidebarFromBackdrop(
      { currentTarget: backdrop, preventDefault, target: backdrop },
      onClose,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores mousedown events originating inside the sidebar", () => {
    const preventDefault = vi.fn();
    const onClose = vi.fn();

    closeConversationSidebarFromBackdrop(
      {
        currentTarget: {} as EventTarget & HTMLDivElement,
        preventDefault,
        target: {} as EventTarget,
      },
      onClose,
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders the user card as an accessible menu trigger", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="workspace-user-menu"');
    expect(markup).toContain('class="user-card"');
  });

  it("renders the credit balance as the account usage dialog trigger", () => {
    const markup = renderSidebar([]);

    expect(markup).toContain('aria-controls="account-usage-dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-label="积分余额"');
    expect(markup).toContain('class="credit-card"');
    expect(markup).toContain("预留/冻结 0");
  });

  it("connects each conversation action trigger to its menu", () => {
    const markup = renderSidebar([conversation("1", 0)]);
    const menuId = "conversation-menu-10000000-0000-4000-8000-000000000001";

    expect(markup).toContain(`aria-controls="${menuId}"`);
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('<strong title="会话 1">会话 1</strong>');
  });

  it("renders compact single-line rows without generic row icons, dates, or loaded counts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0));
    const pinnedAt = new Date().toISOString();
    const markup = renderSidebar([
      conversation("1", 0, pinnedAt),
      conversation("2", 0),
    ]);

    expect(markup).toContain(
      '<span class="conversation-link__copy"><strong title="会话 1">会话 1</strong></span>',
    );
    expect(markup).not.toContain("conversation-link__icon");
    expect(markup).not.toContain("conversation-link__meta");
    expect(markup).toContain(
      '<div class="sidebar__section-heading"><span id="pinned-conversations-heading">置顶</span></div>',
    );
    expect(markup).toContain(
      '<div class="sidebar__section-heading"><span id="conversation-today-heading">今天</span></div>',
    );
  });

  it.each([
    ["waiting", "队列已暂停"],
    ["running", "研究中"],
    ["completed", "已完成"],
    ["failed", "失败"],
    ["cancelled", "已停止"],
    ["reconciliation_required", "待对账"],
  ] as const)(
    "keeps an accessible compact %s run signal beside the title",
    (status, label) => {
      const item = {
        ...conversation("1", 0),
        attention: {
          terminalEventId: "1",
          runId: "20000000-0000-4000-8000-000000000001",
          status: "completed" as const,
          finishedAt: updatedAtDaysAgo(0),
        },
      };
      const markup = renderSidebar(
        [item],
        undefined,
        {
          activeConversationId: item.id,
          runStatusByConversation: { [item.id]: status },
        },
      );

      expect(markup).toContain('aria-current="page"');
      expect(markup).toContain('aria-label="有新的运行结果"');
      expect(markup).toContain('class="conversation-attention-dot"');
      expect(markup).toContain(`aria-label="运行状态：${label}"`);
      expect(markup).toContain(`conversation-run-status--${status}`);
    },
  );

  it("does not move an active conversation that is already fully visible", () => {
    const scrollIntoView = vi.fn();

    expect(
      revealConversationRowIfOutsideViewport(
        { getBoundingClientRect: () => ({ top: 100, bottom: 300 }) },
        {
          getBoundingClientRect: () => ({ top: 100, bottom: 300 }),
          scrollIntoView,
        },
      ),
    ).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([
    { rowTop: 99, rowBottom: 150 },
    { rowTop: 250, rowBottom: 301 },
  ])(
    "reveals an active conversation outside the viewport: %o",
    ({ rowTop, rowBottom }) => {
      const scrollIntoView = vi.fn();

      expect(
        revealConversationRowIfOutsideViewport(
          { getBoundingClientRect: () => ({ top: 100, bottom: 300 }) },
          {
            getBoundingClientRect: () => ({
              top: rowTop,
              bottom: rowBottom,
            }),
            scrollIntoView,
          },
        ),
      ).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    },
  );

  it("places a conversation menu below when it fits and above near the viewport bottom", () => {
    expect(
      conversationMenuPosition({
        trigger: { top: 100, bottom: 128, right: 260 },
        viewportWidth: 1280,
        viewportHeight: 720,
        menuWidth: 168,
        menuHeight: conversationMenuHeight,
        gap: 5,
        gutter: 8,
      }),
    ).toEqual({ left: 92, top: 133 });
    expect(
      conversationMenuPosition({
        trigger: { top: 640, bottom: 668, right: 260 },
        viewportWidth: 1280,
        viewportHeight: 720,
        menuWidth: 168,
        menuHeight: conversationMenuHeight,
        gap: 5,
        gutter: 8,
      }),
    ).toEqual({ left: 92, top: 444 });
  });

  it("clamps the fixed menu inside the horizontal and vertical viewport gutters", () => {
    expect(
      conversationMenuPosition({
        trigger: { top: 20, bottom: 48, right: 100 },
        viewportWidth: 180,
        viewportHeight: 204,
        menuWidth: 168,
        menuHeight: conversationMenuHeight,
        gap: 5,
        gutter: 8,
      }),
    ).toEqual({ left: 8, top: 8 });
  });

  it("keeps conversation actions visible for the active row and hoverless pointers", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const conversationActionStyles = styles.slice(
      styles.indexOf(".conversation-more-button {"),
    );

    expect(conversationActionStyles).toMatch(
      /\.conversation-row--active \.conversation-more-button,[\s\S]*?opacity: 1;/u,
    );
    expect(conversationActionStyles).toMatch(
      /@media \(hover: none\) \{\s*\.conversation-more-button \{\s*opacity: 1;\s*\}\s*\}/u,
    );
    expect(conversationActionStyles).toMatch(
      /@media \(max-width: 780px\) \{\s*\.conversation-more-button \{\s*opacity: 1;\s*\}\s*\}/u,
    );
    expect(conversationActionStyles).toMatch(
      /\.conversation-more-button \{[\s\S]*?width: 36px;[\s\S]*?height: 36px;/u,
    );
  });

  it("reserves a high-density desktop conversation viewport without weakening mobile targets", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const sidebarBaseStyles = styles.slice(
      styles.indexOf(".sidebar {"),
      styles.indexOf(".user-menu {"),
    );
    const conversationDiscoveryStyles = styles.slice(
      styles.indexOf("/* Conversation discovery and management */"),
      styles.indexOf(".conversation-dialog-backdrop"),
    );
    const mobileAccessibilityStyles = styles.slice(
      styles.indexOf("/* Mobile accessibility targets */"),
    );

    expect(sidebarBaseStyles).toMatch(
      /\.sidebar \{[\s\S]*?width: 264px;[\s\S]*?padding: 14px 10px 10px;[\s\S]*?background: var\(--sidebar\);/u,
    );
    expect(sidebarBaseStyles).toMatch(
      /\.sidebar::after \{\s*content: none;\s*\}/u,
    );
    expect(sidebarBaseStyles).not.toContain("radial-gradient");
    expect(sidebarBaseStyles).toMatch(
      /\.sidebar__brand-row \{[\s\S]*?min-height: 40px;/u,
    );
    expect(sidebarBaseStyles).toMatch(
      /\.new-conversation-button \{[\s\S]*?height: 36px;[\s\S]*?justify-content: flex-start;[\s\S]*?margin-top: 8px;[\s\S]*?border: 0;[\s\S]*?background: transparent;[\s\S]*?box-shadow: none;/u,
    );
    expect(sidebarBaseStyles).toMatch(
      /\.conversation-nav \{[\s\S]*?min-height: 0;[\s\S]*?flex: 1;[\s\S]*?overflow-y: auto;/u,
    );
    expect(sidebarBaseStyles).toMatch(
      /\.sidebar__footer \{[\s\S]*?padding-top: 6px;/u,
    );
    expect(sidebarBaseStyles).toMatch(
      /\.credit-card \{[\s\S]*?min-height: 52px;[\s\S]*?grid-template-columns: 28px minmax\(0, 1fr\) auto;[\s\S]*?padding: 6px 8px;/u,
    );
    expect(sidebarBaseStyles).toMatch(
      /\.user-menu-root \{[\s\S]*?margin-top: 3px;[\s\S]*?\.user-card \{[\s\S]*?min-height: 40px;/u,
    );
    expect(conversationDiscoveryStyles).toMatch(
      /\.sidebar__conversation-tools \{[\s\S]*?gap: 2px;[\s\S]*?margin: 2px 0 0;[\s\S]*?\.sidebar__conversation-tools button \{[\s\S]*?height: 36px;/u,
    );
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.new-conversation-button \{[\s\S]*?background: transparent;/u,
    );
    expect(mobileAccessibilityStyles).toMatch(
      /\.new-conversation-button,[\s\S]*?\.credit-card,[\s\S]*?\.user-card,[\s\S]*?min-height: 44px;/u,
    );

    const desktopViewportHeight = 720;
    const fixedSidebarChromeHeight =
      14 +
      10 +
      40 +
      8 +
      36 +
      2 +
      3 * 36 +
      2 * 2 +
      6 +
      52 +
      3 +
      40;
    expect(desktopViewportHeight - fixedSidebarChromeHeight).toBe(397);
    expect(desktopViewportHeight - fixedSidebarChromeHeight).toBeGreaterThanOrEqual(
      350,
    );
  });

  it("uses compact neutral rows with clear hover, focus, active, and dark states", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const linkStyles = styles.slice(
      styles.indexOf(".conversation-link {"),
      styles.indexOf(".conversation-nav__empty {"),
    );

    expect(linkStyles).toMatch(
      /\.conversation-link \{[\s\S]*?min-height: 36px;[\s\S]*?border-radius: 9px;/u,
    );
    expect(linkStyles).toMatch(
      /\.conversation-link:hover \{[\s\S]*?background: rgba\(0, 0, 0, 0\.045\);/u,
    );
    expect(linkStyles).toMatch(
      /\.conversation-link:focus-visible \{[\s\S]*?outline-width: 2px;[\s\S]*?outline-offset: -2px;/u,
    );
    expect(linkStyles).toMatch(
      /\.conversation-link--active \{[\s\S]*?background: rgba\(0, 0, 0, 0\.075\);[\s\S]*?box-shadow: none;/u,
    );
    expect(linkStyles).toMatch(
      /\.conversation-link__copy strong \{[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/u,
    );
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.conversation-link--active \{[\s\S]*?background: #2f2f2f;[\s\S]*?box-shadow: none;/u,
    );
    expect(styles).not.toContain(".conversation-link--active::before");
    expect(styles).not.toContain(".conversation-link__icon");
  });

  it("renders conversation menus as fixed overlays without row-position guesses", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const menuStyles = styles.slice(styles.indexOf(".conversation-menu {"));

    expect(menuStyles).toMatch(
      /\.conversation-menu \{[\s\S]*?position: fixed;[\s\S]*?z-index: 65;/u,
    );
    expect(menuStyles).not.toMatch(/nth-last-child/u);
  });

  it("anchors portal menu Tab navigation to the original row trigger", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/conversation-sidebar.tsx"),
      "utf8",
    );
    const handlerStart = source.indexOf(
      "function handleConversationMenuKeyDown",
    );
    const handlerEnd = source.indexOf(
      "function renderConversation",
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThan(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain("menuTriggerRefs.current.get(openMenuId)");
    expect(handler).toContain("trigger ?? document.activeElement");
  });

  it("opens sharing from a history-row menu without selecting that conversation", async () => {
    const [sidebarSource, workspaceSource] = await Promise.all([
      readFile(
        path.join(process.cwd(), "components/conversation-sidebar.tsx"),
        "utf8",
      ),
      readFile(
        path.join(process.cwd(), "components/research-workspace.tsx"),
        "utf8",
      ),
    ]);

    expect(sidebarSource).toMatch(
      /focusTriggerBeforeOpeningDialog\([\s\S]*?menuTriggerRefs\.current\.get\(conversation\.id\)[\s\S]*?setOpenMenuId\(null\);[\s\S]*?onRequestShare\(conversation\.id\);[\s\S]*?<ShareIcon \/>[\s\S]*?分享/u,
    );
    expect(workspaceSource).toContain(
      "onRequestShare={setShareTargetConversationId}",
    );
    expect(sidebarSource).not.toMatch(
      /onRequestShare\(conversation\.id\);[\s\S]{0,180}?onSelect\(conversation\.id\)/u,
    );
  });

  it("opens the top-level keyboard shortcut dialog from the user-menu trigger", async () => {
    const [sidebarSource, workspaceSource] = await Promise.all([
      readFile(
        path.join(process.cwd(), "components/conversation-sidebar.tsx"),
        "utf8",
      ),
      readFile(
        path.join(process.cwd(), "components/research-workspace.tsx"),
        "utf8",
      ),
    ]);

    expect(sidebarSource).toContain("KeyboardIcon,");
    expect(sidebarSource).toContain("onOpenKeyboardShortcuts: () => void;");
    expect(sidebarSource).toMatch(
      /focusTriggerBeforeOpeningDialog\(\s*userMenuTriggerRef\.current,\s*\(\) => \{[\s\S]*?setIsUserMenuOpen\(false\);[\s\S]*?onOpenKeyboardShortcuts\(\);[\s\S]*?<KeyboardIcon \/>[\s\S]*?<span>快捷键<\/span>/u,
    );
    expect(workspaceSource).toContain(
      'import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";',
    );
    expect(workspaceSource).toMatch(
      /const \[isKeyboardShortcutsOpen, setIsKeyboardShortcutsOpen\] =\s*useState\(false\);/u,
    );
    expect(workspaceSource).toContain(
      "onOpenKeyboardShortcuts={() => setIsKeyboardShortcutsOpen(true)}",
    );
    expect(workspaceSource).toMatch(
      /\{isKeyboardShortcutsOpen \? \(\s*<KeyboardShortcutsDialog[\s\S]*?onClose=\{\(\) => setIsKeyboardShortcutsOpen\(false\)\}[\s\S]*?\) : null\}/u,
    );
    expect(sidebarSource).not.toContain("<KeyboardShortcutsDialog");
  });

  it("stores a share target by id and resolves its latest summary for every render", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /const \[shareTargetConversationId, setShareTargetConversationId\] =\s*useState<string \| null>\(null\);/u,
    );
    expect(source).toMatch(
      /const shareTargetConversation =\s*shareTargetConversationId === null\s*\? null\s*:\s*\(findBootstrapConversation\(bootstrap, shareTargetConversationId\) \?\?\s*\(detachedConversation\?\.id === shareTargetConversationId\s*\? detachedConversation\s*: null\)\);/u,
    );
    expect(source).toContain(
      "setShareTargetConversationId(activeConversation.id);",
    );
    expect(source).toContain(
      "onRequestShare={setShareTargetConversationId}",
    );
    expect(source).toContain("setShareTargetConversationId(null)");
    expect(source).toMatch(
      /\{shareTargetConversation === null \? null : \(\s*<ConversationShareDialog\s+conversation=\{shareTargetConversation\}/u,
    );
    expect(source).not.toMatch(
      /const \[shareTarget, setShareTarget\] =\s*useState<ConversationSummary/u,
    );
  });

  it("removes the closed mobile sidebar and backdrop from keyboard navigation", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 780px)"));

    expect(styles).toMatch(
      /\.sidebar-backdrop \{[\s\S]*?visibility: hidden;[\s\S]*?\}/u,
    );
    expect(mobileStyles).toMatch(
      /\.sidebar \{[\s\S]*?visibility: hidden;[\s\S]*?\}/u,
    );
    expect(mobileStyles).toMatch(
      /\.sidebar--open \{[\s\S]*?visibility: visible;[\s\S]*?\}/u,
    );
    expect(mobileStyles).toMatch(
      /\.sidebar-backdrop--visible \{[\s\S]*?visibility: visible;[\s\S]*?\}/u,
    );
  });

  it("renders pinned conversations separately and recent conversations by age", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0));
    const pinnedAt = new Date().toISOString();
    const markup = renderSidebar([
      conversation("1", 0, pinnedAt),
      conversation("2", 0),
      conversation("3", 1),
      conversation("4", 3),
      conversation("5", 10),
      conversation("6", 40),
    ]);

    expect(markup).toContain('id="pinned-conversations-heading">置顶</span>');
    expect(markup).toContain('id="conversation-today-heading">今天</span>');
    expect(markup).toContain(
      'id="conversation-yesterday-heading">昨天</span>',
    );
    expect(markup).toContain(
      'id="conversation-previous_7_days-heading">过去 7 天</span>',
    );
    expect(markup).toContain(
      'id="conversation-previous_30_days-heading">过去 30 天</span>',
    );
    expect(markup).toContain('id="conversation-older-heading">更早</span>');
    expect(markup).not.toContain("最近会话");
  });
});
