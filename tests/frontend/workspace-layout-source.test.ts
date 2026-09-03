import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function projectSource(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`缺少样式规则 ${selector}`);
  }
  const end = source.indexOf("}", start);
  if (end < 0) {
    throw new Error(`样式规则 ${selector} 缺少结束括号`);
  }
  return source.slice(start, end + 1);
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  const linearChannels = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return (
    0.2126 * linearChannels[0] +
    0.7152 * linearChannels[1] +
    0.0722 * linearChannels[2]
  );
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

describe("persistent workspace layout", () => {
  it("owns one ResearchWorkspace above both leaf pages", async () => {
    const [
      layout,
      homePage,
      conversationPage,
      libraryLayout,
      libraryPage,
      libraryResearchPage,
      libraryArtifactsPage,
      snapshotPage,
    ] =
      await Promise.all([
        projectSource("app/layout.tsx"),
        projectSource("app/page.tsx"),
        projectSource("app/c/[conversationId]/page.tsx"),
        projectSource("app/library/layout.tsx"),
        projectSource("app/library/page.tsx"),
        projectSource("app/library/research/page.tsx"),
        projectSource("app/library/artifacts/page.tsx"),
        projectSource("app/library/research/[snapshotId]/page.tsx"),
      ]);

    expect(layout).toContain(
      "<WorkspaceRouteShell>{children}</WorkspaceRouteShell>",
    );
    expect(homePage).not.toContain("ResearchWorkspace");
    expect(conversationPage).not.toContain("ResearchWorkspace");
    expect(libraryLayout).not.toContain("ResearchWorkspace");
    expect(libraryLayout).toContain('title: "资料库 · 外贸研究助手"');
    expect(libraryPage).not.toContain("ResearchWorkspace");
    expect(libraryResearchPage).not.toContain("ResearchWorkspace");
    expect(libraryArtifactsPage).not.toContain("ResearchWorkspace");
    expect(snapshotPage).not.toContain("ResearchWorkspace");
  });

  it("drives Library tabs from canonical paths without local tab state", async () => {
    const [workspace, libraryView] = await Promise.all([
      projectSource("components/research-workspace.tsx"),
      projectSource("components/library-view.tsx"),
    ]);

    expect(workspace).toContain(
      'navigateWithinWorkspace(libraryRoute("research"))',
    );
    expect(workspace).toContain(
      "navigateWithinWorkspace(libraryRoute(tab))",
    );
    expect(workspace).toMatch(
      /snapshotId === null\s*\? libraryRoute\("research"\)\s*: libraryResearchRoute\(snapshotId\)/u,
    );
    expect(workspace).toContain("onNavigateTab={handleNavigateLibraryTab}");
    expect(workspace).toContain("tab={route.tab}");
    expect(libraryView).toContain("tab: LibraryTab;");
    expect(libraryView).toContain("onNavigateTab(nextTab);");
    expect(libraryView).not.toContain(
      'useState<LibraryTab>("research")',
    );
  });

  it("routes global new-conversation and composer-focus shortcuts through existing actions", async () => {
    const workspace = await projectSource(
      "components/research-workspace.tsx",
    );

    expect(workspace).toMatch(
      /case "new_conversation":\s*handleCreateConversation\(\);\s*return;/u,
    );
    expect(workspace).toMatch(
      /case "focus_composer":\s*requestComposerFocus\(\);\s*return;/u,
    );
    expect(workspace).toContain(
      "[handleCreateConversation, openConversationBrowser, requestComposerFocus]",
    );
    expect(workspace).toContain(
      "workspaceKeyboardShortcutAriaKeyShortcuts.new_conversation",
    );
  });

  it("keeps the workspace in one viewport-sized flex layout on narrow screens", async () => {
    const styles = await projectSource("app/globals.css");

    expect(cssRule(styles, "html,\nbody")).toContain("overflow: hidden");
    expect(cssRule(styles, ".workspace-shell")).toMatch(
      /height: 100dvh;[\s\S]*overflow: hidden;/u,
    );
    expect(cssRule(styles, ".research-pane")).toMatch(
      /height: 100%;[\s\S]*min-height: 0;[\s\S]*overflow: hidden;/u,
    );
    expect(cssRule(styles, ".conversation-scroll")).toMatch(
      /min-height: 0;[\s\S]*flex: 1;[\s\S]*overflow-y: auto;/u,
    );
    expect(cssRule(styles, ".composer-shell")).toContain("flex: 0 0 auto");
  });

  it("uses content-driven markdown columns inside a horizontal scroll region", async () => {
    const styles = await projectSource("app/globals.css");
    const tableRule = cssRule(styles, ".research-markdown table");
    const scrollRule = cssRule(
      styles,
      ".research-markdown__table-scroll",
    );
    const cellRule = cssRule(
      styles,
      ".research-markdown th,\n.research-markdown td",
    );

    expect(tableRule).toMatch(
      /width: max-content;[\s\S]*min-width: 100%;[\s\S]*max-width: none;[\s\S]*table-layout: auto;/u,
    );
    expect(tableRule).toContain("white-space: normal");
    expect(tableRule).not.toContain("overflow-x: auto");
    expect(scrollRule).toContain("overflow-x: auto");
    expect(cellRule).toContain("border-bottom: 1px solid var(--line)");
    expect(cellRule).toContain("overflow-wrap: break-word");
    expect(cellRule).toContain("word-break: normal");
  });

  it("visibly highlights a located search message without changing layout", async () => {
    const styles = await projectSource("app/globals.css");
    const targetRule = cssRule(styles, ".message--search-match");
    const highlightedContentRule = cssRule(
      styles,
      ".message--search-match .user-message-bubble,\n.message--search-match .assistant-message-body",
    );

    expect(targetRule).toContain("scroll-margin-block: 112px");
    expect(highlightedContentRule).toContain(
      "animation: message-search-highlight 2.6s ease-out",
    );
    expect(styles).toContain("@keyframes message-search-highlight");
  });

  it("styles every exact background notification outcome", async () => {
    const styles = await projectSource("app/globals.css");

    expect(cssRule(styles, ".run-completion-notification--failed")).toContain(
      "border-color",
    );
    expect(
      cssRule(styles, ".run-completion-notification--cancelled"),
    ).toContain("border-color");
    expect(
      cssRule(
        styles,
        ".run-completion-notification--reconciliation_required",
      ),
    ).toContain("border-color");
    expect(styles).not.toContain("run-completion-notification--ended");
  });

  it("keeps current Run activity distinct from cross-conversation background tasks", async () => {
    const [workspace, activity, backgroundCenter, styles] = await Promise.all([
      projectSource("components/research-workspace.tsx"),
      projectSource("components/run-activity.tsx"),
      projectSource("components/background-run-center.tsx"),
      projectSource("app/globals.css"),
    ]);

    expect(workspace).toContain('aria-controls="run-activity-panel"');
    expect(workspace).toContain('aria-label="活动"');
    expect(workspace).toContain(
      "disabled={selectedActivityRun === null && !isActivityOpen}",
    );
    expect(workspace).toContain(
      "if (isActivityOpen) {\n                  if (selectedActivityRun === null) {",
    );
    expect(workspace).toContain(
      "closeDesktopPanelAndRestoreFocus(\n                      closeActiveActivity,\n                      headerBackgroundRunButtonRef.current,",
    );
    expect(workspace).toContain(
      "activityReturnFocusRef.current = returnFocusTarget",
    );
    expect(workspace).toContain(
      "headerBackgroundRunButtonRef.current,\n      );",
    );
    expect(workspace).not.toContain(
      "activityReturnFocusRef.current = headerActivityButtonRef.current",
    );
    expect(workspace).toContain("<BackgroundRunCenterTrigger");
    expect(workspace).toContain("count={backgroundRunBadgeCount}");
    expect(workspace).toContain(
      "triggerRef={headerBackgroundRunButtonRef}",
    );
    expect(workspace).not.toContain(
      '? "background-run-center-dialog"\n                  : "run-activity-panel"',
    );
    expect(backgroundCenter).toContain(
      'aria-controls="background-run-center-dialog"',
    );
    expect(backgroundCenter).toContain("后台任务，当前没有待处理任务");
    expect(workspace).toContain(
      'aria-label={isCreating ? "正在创建新研究" : "新建研究"}',
    );
    expect(workspace).toContain('aria-label="分享对话"');
    expect(workspace).toContain('aria-controls="conversation-share-dialog"');
    expect(workspace).toContain('aria-expanded={isHeaderShareDialogOpen}');
    expect(workspace).toContain('className="header-share-button"');
    expect(activity).toContain('id="run-activity-panel"');
    expect(backgroundCenter).toContain('id="background-run-center-dialog"');
    expect(backgroundCenter).toContain('aria-modal="true"');
    expect(cssRule(styles, ".header-run-button__badge")).toContain(
      "border-radius: 999px",
    );
    expect(styles).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]*?\.background-run-center \{[\s\S]*?width: 100vw;/u,
    );
  });

  it("keeps the activity surface and assistant document flow compact", async () => {
    const styles = await projectSource("app/globals.css");

    expect(cssRule(styles, ".workspace-shell--activity")).toContain("440px");
    expect(cssRule(styles, ".activity-panel__header")).toMatch(
      /height: 60px;[\s\S]*flex: 0 0 60px;/u,
    );
    expect(cssRule(styles, ".message--assistant")).toContain("display: block");
    expect(styles).toMatch(
      /\n\.assistant-message-body \{[\s\S]*?width: 100%;[\s\S]*?\n\}/u,
    );
    expect(cssRule(styles, ".research-markdown")).toContain("line-height: 1.6");
    expect(styles).toContain(".activity-panel__notice > summary");
  });

  it("aligns the compact desktop header, document column, and composer", async () => {
    const [workspace, styles] = await Promise.all([
      projectSource("components/research-workspace.tsx"),
      projectSource("app/globals.css"),
    ]);

    expect(cssRule(styles, ".research-header")).toMatch(
      /height: 56px;[\s\S]*flex: 0 0 56px;/u,
    );
    expect(cssRule(styles, ".research-header")).toContain(
      "border-bottom: 1px solid transparent",
    );
    expect(cssRule(styles, ".research-header__identity > span")).toMatch(
      /align-items: baseline;[\s\S]*gap: 8px;/u,
    );
    expect(cssRule(styles, ".research-header__identity small")).toContain(
      "order: 2",
    );
    expect(cssRule(styles, ".conversation-progress")).toContain("top: 55px");
    expect(cssRule(styles, ":root")).toContain(
      "--conversation-measure: 760px",
    );
    expect(cssRule(styles, ".message-list")).toContain(
      "width: min(var(--conversation-measure), calc(100% - 44px))",
    );
    expect(cssRule(styles, ".historical-attempt-notice")).toContain(
      "width: min(var(--conversation-measure), calc(100% - 44px))",
    );
    expect(cssRule(styles, ".archived-conversation-notice")).toContain(
      "width: min(var(--conversation-measure), calc(100% - 44px))",
    );
    expect(styles).toContain(
      "max-width: min(var(--conversation-measure), calc(100% - 28px))",
    );
    expect(cssRule(styles, ".composer-shell")).toMatch(
      /padding: 10px\s+max\(22px, calc\(\(100% - var\(--conversation-measure\)\) \/ 2\)\) 17px;/u,
    );
    expect(cssRule(styles, ".message + .message")).toContain(
      "margin-top: 22px",
    );
    expect(cssRule(styles, ".user-message-bubble")).toMatch(
      /padding: 9px 15px;[\s\S]*border: 0;[\s\S]*border-radius: 20px;[\s\S]*background: var\(--canvas-strong\);[\s\S]*box-shadow: none;/u,
    );
    expect(cssRule(styles, ".composer")).toMatch(
      /min-height: 54px;[\s\S]*border-radius: 26px;/u,
    );
    expect(cssRule(styles, ".composer__send")).toContain(
      "border-radius: 999px",
    );
    expect(cssRule(styles, ".composer__attach")).toContain(
      "border-radius: 999px",
    );
    expect(cssRule(styles, ".research-header .header-credit")).toContain(
      "display: none",
    );
    expect(styles).toMatch(
      /@media \(min-width: 781px\) \{\s*\.research-header \.header-new-button \{\s*display: none;\s*\}\s*\}/u,
    );
    expect(styles).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]*?\.header-new-button \{\s*width: 34px;[\s\S]*?justify-content: center;\s*\}/u,
    );
    expect(workspace).toContain('className="header-new-button"');
  });

  it("keeps completion notices clear of each open desktop side panel", async () => {
    const styles = await projectSource("app/globals.css");

    expect(
      cssRule(
        styles,
        ".workspace-shell--activity .run-completion-notifications",
      ),
    ).toContain("right: 458px");
    expect(
      cssRule(
        styles,
        ".workspace-shell--sources .run-completion-notifications",
      ),
    ).toContain("right: 378px");
    expect(styles).toMatch(
      /@media \(max-width: 1280px\) and \(min-width: 1181px\) \{[\s\S]*?\.workspace-shell--activity \.run-completion-notifications \{\s*right: 438px;\s*\}[\s\S]*?\.workspace-shell--sources \.run-completion-notifications \{\s*right: 358px;\s*\}/u,
    );
    expect(styles).toMatch(
      /@media \(max-width: 1180px\) \{[\s\S]*?\.workspace-shell--activity \.run-completion-notifications,\s*\.workspace-shell--sources \.run-completion-notifications \{\s*right: 18px;\s*\}/u,
    );
  });

  it("keeps the dark activity connection warning above AA small-text contrast", async () => {
    const styles = await projectSource("app/globals.css");
    const warningRule = cssRule(
      styles,
      'html[data-theme="dark"] .run-process-card__connection--warning',
    );
    const foreground = warningRule.match(/\bcolor: (#[0-9a-f]{6});/u)?.[1];
    const background = warningRule.match(
      /\bbackground: (#[0-9a-f]{6});/u,
    )?.[1];

    expect(foreground).toBeDefined();
    expect(background).toBeDefined();
    expect(contrastRatio(foreground!, background!)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps header actions on one line when the activity panel narrows the conversation", async () => {
    const styles = await projectSource("app/globals.css");

    expect(cssRule(styles, ".research-header__identity")).toContain(
      "flex: 1 1 auto",
    );
    expect(cssRule(styles, ".research-header__actions")).toMatch(
      /flex: 0 0 auto;[\s\S]*white-space: nowrap;/u,
    );
  });

  it("keeps share available from the active conversation header", async () => {
    const [workspace, styles] = await Promise.all([
      projectSource("components/research-workspace.tsx"),
      projectSource("app/globals.css"),
    ]);

    expect(workspace).toContain(
      'import { ConversationShareDialog } from "@/components/conversation-share-dialog";',
    );
    expect(workspace).toContain(
      "setShareTargetConversationId(activeConversation.id)",
    );
    expect(workspace).toContain("<ConversationShareDialog");
    expect(cssRule(styles, ".header-share-button")).toContain(
      "background: var(--accent)",
    );
    expect(styles).toContain(".conversation-share-dialog__link-row");
  });

  it("opens the compact conversation menu toward the available viewport", async () => {
    const styles = await projectSource("app/globals.css");

    expect(styles).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]*?\.conversation-header-menu__panel \{\s*right: auto;\s*left: 0;\s*\}/u,
    );
  });
});
