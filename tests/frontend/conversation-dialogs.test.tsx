import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  applyArchivedRestoreCompletion,
  conversationBrowserEnterResultIndex,
  conversationBrowserInitialPageRequest,
  conversationBrowserMergePage,
  ConversationBrowserLoadFailure,
  conversationBrowserPageRequestIsCurrent,
  conversationBrowserQueryIsPending,
  conversationBrowserResultIndexForKey,
  conversationBrowserResultId,
  conversationBrowserResultSurface,
  conversationBrowserSearchMatch,
  conversationBrowserSelection,
  conversationBrowserScrollIsNearEnd,
  conversationBrowserViewForTabKey,
  ConversationBrowserDialog,
  ConversationBrowserSearchExcerpt,
  formatConversationBrowserDate,
  revealConversationBrowserResultIfOutsideViewport,
} from "@/components/conversation-browser-dialog";
import {
  DeleteConversationDialog,
  RenameConversationDialog,
} from "@/components/conversation-mutation-dialogs";
import type {
  ConversationListItem,
  ConversationSummary,
} from "@/lib/contracts";

const conversation: ConversationSummary = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  updatedAt: "2026-08-27T08:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

function listItem(
  searchMatch: ConversationListItem["searchMatch"] = null,
): ConversationListItem {
  return { ...conversation, searchMatch };
}

describe("conversation dialogs", () => {
  it("focuses search before removing the still-focused archived result", () => {
    const order: string[] = [];
    const activeElement = {} as Node;

    expect(
      applyArchivedRestoreCompletion({
        activeElement,
        currentRequestKey: "archived\u0000pump\u00000",
        removeResult: () => order.push("remove"),
        requestKey: "archived\u0000pump\u00000",
        resultRow: {
          contains: (candidate) => candidate === activeElement,
        },
        searchInput: { focus: () => order.push("focus") },
      }),
    ).toBe(true);

    expect(order).toEqual(["focus", "remove"]);
  });

  it("removes a restored result without stealing focus moved elsewhere", () => {
    const order: string[] = [];

    expect(
      applyArchivedRestoreCompletion({
        activeElement: {} as Node,
        currentRequestKey: "archived\u0000pump\u00000",
        removeResult: () => order.push("remove"),
        requestKey: "archived\u0000pump\u00000",
        resultRow: { contains: () => false },
        searchInput: { focus: () => order.push("focus") },
      }),
    ).toBe(true);

    expect(order).toEqual(["remove"]);
  });

  it.each([
    ["view", "active\u0000pump\u00000"],
    ["query", "archived\u0000valve\u00000"],
  ])(
    "ignores a restore completion after the %s changes",
    (_change, currentRequestKey) => {
      const order: string[] = [];
      const activeElement = {} as Node;

      expect(
        applyArchivedRestoreCompletion({
          activeElement,
          currentRequestKey,
          removeResult: () => order.push("remove"),
          requestKey: "archived\u0000pump\u00000",
          resultRow: { contains: () => true },
          searchInput: { focus: () => order.push("focus") },
        }),
      ).toBe(false);

      expect(order).toEqual([]);
    },
  );

  it("exposes active search results as a labelled combobox and listbox", () => {
    const markup = renderToStaticMarkup(
      <ConversationBrowserDialog
        busyConversationIds={new Set()}
        initialView="active"
        onClose={() => undefined}
        onRequestDelete={() => undefined}
        onRestore={async () => null}
        onSelect={() => undefined}
        refreshVersion={0}
      />,
    );

    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'aria-labelledby="conversation-browser-title" aria-modal="true"',
    );
    expect(markup).toContain('id="conversation-browser-dialog"');
    expect(markup).toContain('role="dialog" tabindex="-1"');
    expect(markup).toContain('aria-autocomplete="list"');
    expect(markup).toContain('aria-controls="conversation-search-result-list"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-label="对话范围"');
    expect(markup).toContain(
      'aria-labelledby="conversation-browser-active-tab" class="conversation-browser-dialog__panel" id="conversation-browser-view-panel" role="tabpanel"',
    );
    expect(markup).toContain(
      'aria-hidden="true" class="conversation-search-results__loading"',
    );
    expect(markup).toContain(
      'aria-busy="true" class="conversation-search-results"',
    );
    expect(markup).toContain(
      'aria-label="搜索结果" aria-multiselectable="false" id="conversation-search-result-list" role="listbox"',
    );
    expect(markup).not.toContain('role="option"');
    expect(markup).not.toContain("aria-activedescendant");
  });

  it("uses grid popup semantics for archived results with row actions", () => {
    const markup = renderToStaticMarkup(
      <ConversationBrowserDialog
        busyConversationIds={new Set()}
        initialView="archived"
        onClose={() => undefined}
        onRequestDelete={() => undefined}
        onRestore={async () => null}
        onSelect={() => undefined}
        refreshVersion={0}
      />,
    );

    expect(markup).toContain('aria-haspopup="grid"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain(
      'aria-label="搜索结果" aria-multiselectable="false" id="conversation-search-result-list" role="grid"',
    );
  });

  it("selects the highlighted result on Enter and the first result without a highlight", () => {
    expect(conversationBrowserEnterResultIndex(2, 4)).toBe(2);
    expect(conversationBrowserEnterResultIndex(-1, 4)).toBe(0);
    expect(conversationBrowserEnterResultIndex(4, 4)).toBe(0);
    expect(conversationBrowserEnterResultIndex(-1, 0)).toBe(-1);
  });

  it("does not expose stale results while a debounced query is pending", () => {
    expect(conversationBrowserQueryIsPending("pump", "")).toBe(true);
    expect(conversationBrowserQueryIsPending("  pump  ", "pump")).toBe(false);
    expect(conversationBrowserQueryIsPending("pump buyer", "pump")).toBe(true);
  });

  it("uses the fixed server search match and fails closed on query mismatches", () => {
    const titleMatch = {
      kind: "title" as const,
      excerpt: {
        before: "德国",
        match: "泵类",
        after: "买家",
        beforeTruncated: false,
        afterTruncated: false,
      },
    };
    expect(conversationBrowserSearchMatch(listItem(), "")).toBeNull();
    expect(
      conversationBrowserSearchMatch(listItem(titleMatch), "泵类"),
    ).toEqual(titleMatch);
    expect(() =>
      conversationBrowserSearchMatch(listItem(titleMatch), ""),
    ).toThrow("空搜索结果不应包含 searchMatch");
    expect(() =>
      conversationBrowserSearchMatch(listItem(), "pump"),
    ).toThrow("非空搜索结果缺少固定的 searchMatch");
  });

  it("preserves the exact message target when selecting a search result", () => {
    const messageMatch: ConversationListItem["searchMatch"] = {
      kind: "message",
      messageId: "20000000-0000-4000-8000-000000000001",
      role: "assistant",
      createdAt: "2026-08-27T07:00:00.000Z",
      excerpt: {
        before: "德国 ",
        match: "泵类",
        after: " 买家",
        beforeTruncated: false,
        afterTruncated: false,
      },
    };

    expect(conversationBrowserSelection(listItem(messageMatch), "泵类")).toEqual(
      {
        conversation,
        searchMatch: messageMatch,
      },
    );
    expect(conversationBrowserSelection(listItem(), "")).toEqual({
      conversation,
      searchMatch: null,
    });
  });

  it("merges paginated results without losing exact search metadata", () => {
    const firstMatch = {
      kind: "message" as const,
      messageId: "20000000-0000-4000-8000-000000000001",
      role: "user" as const,
      createdAt: "2026-08-27T07:00:00.000Z",
      excerpt: {
        before: "German ",
        match: "pump",
        after: " buyer",
        beforeTruncated: false,
        afterTruncated: false,
      },
    };
    const refreshedMatch = {
      ...firstMatch,
      excerpt: { ...firstMatch.excerpt, before: "Verified German " },
    };
    const second = {
      ...listItem(),
      id: "10000000-0000-4000-8000-000000000002",
    };

    expect(
      conversationBrowserMergePage(
        [listItem(firstMatch)],
        [listItem(refreshedMatch), second],
      ),
    ).toEqual([listItem(refreshedMatch), second]);
  });

  it("renders the server excerpt as escaped text with explicit truncation", () => {
    const markup = renderToStaticMarkup(
      <ConversationBrowserSearchExcerpt
        excerpt={{
          before: "<script>alert(1)</script> ",
          match: "literal-target",
          after: " **not rendered Markdown**",
          beforeTruncated: true,
          afterTruncated: true,
        }}
      />,
    );

    expect(markup).toContain("…&lt;script&gt;alert(1)&lt;/script&gt; ");
    expect(markup).toContain("<mark>literal-target</mark>");
    expect(markup).toContain(" **not rendered Markdown**…");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<strong>not rendered Markdown</strong>");
  });

  it("supports result and range-tab keyboard navigation without stealing unrelated keys", () => {
    expect(conversationBrowserResultIndexForKey("ArrowDown", -1, 3)).toBe(0);
    expect(conversationBrowserResultIndexForKey("ArrowUp", -1, 3)).toBe(2);
    expect(conversationBrowserResultIndexForKey("ArrowDown", -1, 0)).toBeNull();
    expect(conversationBrowserResultIndexForKey("Home", 2, 3)).toBeNull();
    expect(conversationBrowserResultIndexForKey("End", 0, 3)).toBeNull();
    expect(conversationBrowserResultIndexForKey("x", 0, 3)).toBeNull();

    expect(conversationBrowserViewForTabKey("active", "ArrowRight")).toBe(
      "archived",
    );
    expect(conversationBrowserViewForTabKey("archived", "ArrowLeft")).toBe(
      "active",
    );
    expect(conversationBrowserViewForTabKey("archived", "Home")).toBe("active");
    expect(conversationBrowserViewForTabKey("active", "End")).toBe("archived");
    expect(conversationBrowserViewForTabKey("active", "ArrowDown")).toBeNull();
    expect(conversationBrowserViewForTabKey("active", "Enter")).toBeNull();
  });

  it("starts incremental loading only near the results viewport end", () => {
    expect(
      conversationBrowserScrollIsNearEnd({
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 503,
      }),
    ).toBe(false);
    expect(
      conversationBrowserScrollIsNearEnd({
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 504,
      }),
    ).toBe(true);
  });

  it("derives stable result ids and visible dates from fixed summary fields", () => {
    expect(conversationBrowserResultId(conversation.id)).toBe(
      `conversation-search-result-${conversation.id}`,
    );
    expect(formatConversationBrowserDate(conversation.updatedAt)).toBe(
      "2026年8月27日",
    );
  });

  it("does not move a highlighted result that is already fully visible", () => {
    const scrollIntoView = vi.fn();

    expect(
      revealConversationBrowserResultIfOutsideViewport(
        { getBoundingClientRect: () => ({ top: 100, bottom: 300 }) },
        {
          getBoundingClientRect: () => ({ top: 120, bottom: 180 }),
          scrollIntoView,
        },
      ),
    ).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it.each([
    { resultTop: 99, resultBottom: 150 },
    { resultTop: 250, resultBottom: 301 },
  ])(
    "reveals a highlighted result outside the scroll viewport: %o",
    ({ resultTop, resultBottom }) => {
      const scrollIntoView = vi.fn();

      expect(
        revealConversationBrowserResultIfOutsideViewport(
          { getBoundingClientRect: () => ({ top: 100, bottom: 300 }) },
          {
            getBoundingClientRect: () => ({
              top: resultTop,
              bottom: resultBottom,
            }),
            scrollIntoView,
          },
        ),
      ).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    },
  );

  it("wires keyboard highlight changes to scrolling and renders updatedAt as time", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/conversation-browser-dialog.tsx"),
      "utf8",
    );
    const handlerStart = source.indexOf("function handleSearchKeyDown");
    const handlerEnd = source.indexOf(
      "function handleBackdropMouseDown",
      handlerStart,
    );
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThan(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain(
      "const nextIndex = conversationBrowserResultIndexForKey(",
    );
    expect(handler).toContain(
      "revealConversationBrowserResultIfOutsideViewport(",
    );
    expect(handler).toContain("conversationBrowserEnterResultIndex(");
    expect(handler).toContain("navigableItems.length");
    expect(source).toContain("<time dateTime={conversation.updatedAt}>");
    expect(source).toMatch(
      /formatConversationBrowserDate\(\s+conversation\.updatedAt,\s+\)/,
    );
    expect(source).toContain("conversationBrowserSearchMatch(");
    expect(source).toContain("searchMatch.excerpt");
    expect(source).toContain("conversation-search-result__excerpt");
    expect(source).toContain("onScroll={handleResultsScroll}");
    expect(source).toContain("controller.signal,");
    expect(source).toContain("current.nextCursor === loadMoreCursor");
  });

  it("reuses the fixed conversation-list contract for every initial page attempt", () => {
    expect(
      conversationBrowserInitialPageRequest("archived", "pump buyer"),
    ).toEqual({
      view: "archived",
      query: "pump buyer",
      cursor: null,
      limit: 20,
    });
  });

  it("gives an initial load failure precedence over the empty result surface", () => {
    expect(
      conversationBrowserResultSurface({
        isLoading: false,
        loadError: "网络暂时不可用",
        itemCount: 0,
      }),
    ).toBe("failure");
    expect(
      conversationBrowserResultSurface({
        isLoading: false,
        loadError: null,
        itemCount: 0,
      }),
    ).toBe("empty");
  });

  it("renders an announced load failure with a keyboard-focusable retry action", () => {
    const markup = renderToStaticMarkup(
      <ConversationBrowserLoadFailure
        message="网络暂时不可用"
        onRetry={() => undefined}
        view="archived"
      />,
    );

    expect(markup).toContain(
      'class="conversation-search-results__failure" role="alert"',
    );
    expect(markup).toContain("暂时无法加载已归档对话");
    expect(markup).toContain("网络暂时不可用");
    expect(markup).toContain('aria-label="重新加载已归档对话"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("重新加载");
    expect(markup).not.toContain("disabled");
    expect(markup).not.toContain("这里还没有对话");
    expect(markup).not.toContain("没有匹配的对话");
  });

  it("rejects aborted, superseded, and stale-key page completions", () => {
    const currentController = new AbortController();
    const supersededController = new AbortController();
    const requestKey = "archived\u0000pump\u00000";

    expect(
      conversationBrowserPageRequestIsCurrent({
        controller: currentController,
        currentController,
        currentRequestKey: requestKey,
        requestKey,
      }),
    ).toBe(true);
    expect(
      conversationBrowserPageRequestIsCurrent({
        controller: supersededController,
        currentController,
        currentRequestKey: requestKey,
        requestKey,
      }),
    ).toBe(false);
    expect(
      conversationBrowserPageRequestIsCurrent({
        controller: currentController,
        currentController,
        currentRequestKey: "active\u0000pump\u00000",
        requestKey,
      }),
    ).toBe(false);

    currentController.abort();
    expect(
      conversationBrowserPageRequestIsCurrent({
        controller: currentController,
        currentController,
        currentRequestKey: requestKey,
        requestKey,
      }),
    ).toBe(false);
  });

  it("labels and describes the rename dialog", () => {
    const markup = renderToStaticMarkup(
      <RenameConversationDialog
        conversation={conversation}
        isBusy={false}
        onClose={() => undefined}
        onRename={async () => null}
      />,
    );
    const descriptionId = `rename-conversation-description-${conversation.id}`;

    expect(markup).toContain(
      `aria-describedby="${descriptionId}" aria-labelledby="rename-conversation-title" aria-modal="true"`,
    );
    expect(markup).toContain('role="dialog" tabindex="-1"');
    expect(markup).toContain(`id="${descriptionId}"`);
  });

  it("uses alert-dialog semantics and a description for permanent deletion", () => {
    const markup = renderToStaticMarkup(
      <DeleteConversationDialog
        conversation={conversation}
        isBusy={false}
        onClose={() => undefined}
        onDelete={async () => null}
      />,
    );
    const descriptionId = `delete-conversation-description-${conversation.id}`;

    expect(markup).toContain(
      `aria-describedby="${descriptionId}" aria-labelledby="delete-conversation-title" aria-modal="true"`,
    );
    expect(markup).toContain('role="alertdialog" tabindex="-1"');
    expect(markup).toContain(`id="${descriptionId}"`);
  });
});
