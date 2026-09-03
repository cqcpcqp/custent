import { readFile } from "node:fs/promises";
import path from "node:path";

import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversationBulkActionDialog } from "@/components/conversation-mutation-dialogs";
import {
  conversationBulkActionSuccessMessage,
  SettingsDialog,
  settingsSidebarOptions,
  settingsThemeOptions,
} from "@/components/settings-dialog";

const SETTINGS_STYLES_MARKER = "/* Settings dialog */";

async function projectSource(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

function settingsStyles(styles: string): string {
  const start = styles.indexOf(SETTINGS_STYLES_MARKER);
  if (start < 0) {
    throw new Error("缺少独立的设置对话框样式区块");
  }
  const end = styles.indexOf("\n/* ", start + SETTINGS_STYLES_MARKER.length);
  return styles.slice(start, end < 0 ? undefined : end);
}

function renderSettingsDialog(isSidebarCollapsed = false): string {
  return renderToStaticMarkup(
    <SettingsDialog
      isSidebarCollapsed={isSidebarCollapsed}
      onArchiveAllConversations={async () => ({
        conversationCount: 0,
        error: null,
      })}
      onClose={() => undefined}
      onDeleteAllConversations={async () => ({
        conversationCount: 0,
        error: null,
      })}
      onSidebarCollapsedChange={() => undefined}
      returnFocusRef={createRef<HTMLButtonElement>()}
    />,
  );
}

describe("settings dialog", () => {
  it("renders an accessible modal for browser-local display preferences", () => {
    const markup = renderSettingsDialog();

    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'aria-describedby="settings-dialog-description" aria-labelledby="settings-dialog-title" aria-modal="true"',
    );
    expect(markup).toContain('id="workspace-settings-dialog"');
    expect(markup).toContain('role="dialog" tabindex="-1"');
    expect(markup).toContain('aria-label="关闭设置"');
    expect(markup).toContain("调整界面、个性化、提醒偏好与账户数据控制");
    expect(markup).toContain(
      "界面与提醒偏好只保存在当前浏览器；数据控制会直接管理当前账户的数据。",
    );
    expect(markup).toContain("<legend>浏览器通知</legend>");
    expect(markup).toContain("<legend>个性化</legend>");
    expect(markup).toContain("自定义指令");
    expect(markup).toContain(
      "为以后新建的对话设置背景、目标市场与回答偏好",
    );
    expect(markup).toContain("<legend>数据控制</legend>");
    expect(markup).toContain(
      "管理共享链接，并归档或永久删除当前账户中的对话。",
    );
    expect(markup).toContain("共享链接");
    expect(markup).toContain("打开或撤销通过公开链接共享的对话快照");
    expect(markup).toContain("归档所有对话");
    expect(markup).toContain("删除所有对话");
    expect(markup.match(/aria-controls="conversation-bulk-action-dialog"/gu))
      .toHaveLength(2);
    expect(markup.match(/aria-expanded="false"/gu)).toHaveLength(2);
    expect(markup.match(/aria-haspopup="dialog"/gu)).toHaveLength(2);
    expect(markup).toContain(
      'class="settings-dialog__data-control settings-dialog__data-control--danger"',
    );
    expect(markup).toContain("永久删除当前账户中的全部对话，包括已归档对话");
  });

  it("renders action-specific accessible confirmations", () => {
    const returnFocusRef = createRef<HTMLButtonElement>();
    const archiveMarkup = renderToStaticMarkup(
      <ConversationBulkActionDialog
        action="archive_all"
        onClose={() => undefined}
        onComplete={() => undefined}
        onConfirm={async () => ({ conversationCount: 3, error: null })}
        returnFocusRef={returnFocusRef}
      />,
    );
    const deleteMarkup = renderToStaticMarkup(
      <ConversationBulkActionDialog
        action="delete_all"
        onClose={() => undefined}
        onComplete={() => undefined}
        onConfirm={async () => ({ conversationCount: 3, error: null })}
        returnFocusRef={returnFocusRef}
      />,
    );

    expect(archiveMarkup).toContain(
      'class="conversation-mutation-backdrop settings-conversation-bulk-action-backdrop"',
    );
    expect(archiveMarkup).toContain('data-modal-layer=""');
    expect(archiveMarkup).toContain('aria-busy="false"');
    expect(archiveMarkup).toContain(
      'aria-describedby="conversation-bulk-action-description"',
    );
    expect(archiveMarkup).toContain(
      'aria-labelledby="conversation-bulk-action-title" aria-modal="true"',
    );
    expect(archiveMarkup).toContain(
      'id="conversation-bulk-action-dialog" role="dialog" tabindex="-1"',
    );
    expect(archiveMarkup).toContain("归档所有对话？");
    expect(archiveMarkup).toContain(
      "所有未归档对话都会移到“已归档”。你可以稍后逐个恢复。",
    );
    expect(archiveMarkup).toContain(">取消</button>");
    expect(archiveMarkup).not.toContain("此操作不可撤销。");

    expect(deleteMarkup).toContain(
      'class="conversation-mutation-dialog conversation-mutation-dialog--danger"',
    );
    expect(deleteMarkup).toContain(
      'id="conversation-bulk-action-dialog" role="alertdialog" tabindex="-1"',
    );
    expect(deleteMarkup).toContain("永久删除所有对话？");
    expect(deleteMarkup).toContain("包括已归档对话");
    expect(deleteMarkup).toContain("相关公开共享链接也会立即失效");
    expect(deleteMarkup).toContain("此操作不可撤销。");
    expect(deleteMarkup).toContain("永久删除所有对话</button>");
  });

  it("formats the exact successful conversation count", () => {
    expect(conversationBulkActionSuccessMessage("archive_all", 0)).toBe(
      "已归档 0 个对话。",
    );
    expect(conversationBulkActionSuccessMessage("delete_all", 1_234)).toBe(
      "已永久删除 1,234 个对话。",
    );
  });

  it("offers exactly the fixed light, dark, and system theme choices", () => {
    expect(settingsThemeOptions.map(({ label, value }) => ({ label, value })))
      .toEqual([
        { label: "浅色", value: "light" },
        { label: "深色", value: "dark" },
        { label: "跟随系统", value: "system" },
      ]);

    const markup = renderSettingsDialog();
    expect(markup.match(/name="workspace-theme-preference"/gu)).toHaveLength(
      3,
    );
    expect(markup).toContain('data-theme-value="light"');
    expect(markup).toContain('data-theme-value="dark"');
    expect(markup).toContain('data-theme-value="system"');
    expect(markup).toMatch(
      /<input(?=[^>]*name="workspace-theme-preference")(?=[^>]*checked="")(?=[^>]*value="system")[^>]*>/u,
    );
  });

  it("offers exactly expanded and collapsed desktop-sidebar choices", () => {
    expect(
      settingsSidebarOptions.map(({ label, value }) => ({ label, value })),
    ).toEqual([
      { label: "展开", value: "expanded" },
      { label: "收起", value: "collapsed" },
    ]);

    const expandedMarkup = renderSettingsDialog(false);
    const collapsedMarkup = renderSettingsDialog(true);
    expect(expandedMarkup.match(/name="workspace-sidebar-preference"/gu))
      .toHaveLength(2);
    expect(expandedMarkup).toMatch(
      /<input(?=[^>]*name="workspace-sidebar-preference")(?=[^>]*checked="")(?=[^>]*value="expanded")[^>]*>/u,
    );
    expect(collapsedMarkup).toMatch(
      /<input(?=[^>]*name="workspace-sidebar-preference")(?=[^>]*checked="")(?=[^>]*value="collapsed")[^>]*>/u,
    );
  });

  it("uses the shared modal focus contract and returns focus to the user menu", async () => {
    const [dialogSource, mutationDialogSource, sidebarSource] = await Promise.all([
      projectSource("components/settings-dialog.tsx"),
      projectSource("components/conversation-mutation-dialogs.tsx"),
      projectSource("components/conversation-sidebar.tsx"),
    ]);

    expect(dialogSource).toMatch(
      /useModalFocus\(\{[\s\S]*?backdropRef,[\s\S]*?canClose: true,[\s\S]*?containerRef: dialogRef,[\s\S]*?initialFocusRef: closeButtonRef,[\s\S]*?onClose,[\s\S]*?returnFocusRef,[\s\S]*?\}\);/u,
    );
    expect(dialogSource).toMatch(
      /surface !== "preferences"[\s\S]*?backButtonRef\.current\?\.focus\(\)[\s\S]*?previousSurface === "custom_instructions"[\s\S]*?manageCustomInstructionsButtonRef\.current\?\.focus\(\)/u,
    );
    expect(dialogSource).toMatch(
      /surface === "custom_instructions"[\s\S]*?<CustomInstructionsSettings \/>/u,
    );
    expect(dialogSource).toMatch(
      /handleBackdropMouseDown[\s\S]*?event\.target === event\.currentTarget[\s\S]*?event\.preventDefault\(\);[\s\S]*?onClose\(\);/u,
    );
    expect(dialogSource).toMatch(
      /className="settings-dialog__data-control-notice"[\s\S]*?role="status"[\s\S]*?conversationBulkActionSuccessMessage/u,
    );
    expect(mutationDialogSource).toMatch(
      /export function ConversationBulkActionDialog[\s\S]*?canClose: !isSubmitting,[\s\S]*?initialFocusRef: cancelButtonRef,[\s\S]*?returnFocusRef/u,
    );
    expect(mutationDialogSource).toMatch(
      /handleBackdropMouseDown[\s\S]*?event\.target !== event\.currentTarget[\s\S]*?event\.preventDefault\(\);[\s\S]*?if \(!isSubmitting\) \{[\s\S]*?onClose\(\);/u,
    );
    expect(mutationDialogSource).toMatch(
      /disabled=\{isSubmitting\}[\s\S]*?isSubmitting \? copy\.pendingLabel : copy\.confirmLabel/u,
    );
    expect(sidebarSource).toMatch(
      /<button[\s\S]*?onClick=\{\(\) => \{[\s\S]*?setIsUserMenuOpen\(false\);[\s\S]*?setIsSettingsOpen\(true\);[\s\S]*?role="menuitem"[\s\S]*?<SettingsIcon \/>[\s\S]*?<span>设置<\/span>/u,
    );
    expect(sidebarSource).toMatch(
      /<SettingsDialog[\s\S]*?isSidebarCollapsed=\{isCollapsed\}[\s\S]*?onSidebarCollapsedChange=\{commitSidebarCollapsedPreference\}[\s\S]*?returnFocusRef=\{userMenuTriggerRef\}/u,
    );
  });

  it("keeps desktop, compact mobile, and dark-theme styles isolated", async () => {
    const styles = settingsStyles(await projectSource("app/globals.css"));

    expect(styles).toContain(".settings-dialog-backdrop");
    expect(styles).toContain(".settings-dialog {");
    expect(styles).toContain(".settings-dialog__notification {");
    expect(styles).toContain(".settings-dialog__data-control {");
    expect(styles).toContain(".settings-dialog__data-controls {");
    expect(styles).toContain(".settings-dialog__data-control--danger {");
    expect(styles).toContain(".settings-dialog__data-control-notice {");
    expect(styles).toMatch(
      /\.settings-conversation-bulk-action-backdrop \{\s*z-index: 170;/u,
    );
    expect(styles).toContain(".custom-instructions-settings {");
    expect(styles).toContain(".custom-instructions-settings__switch {");
    expect(styles).toContain(".shared-links-manager__item {");
    expect(styles).toContain(
      'html[data-theme="dark"] .settings-dialog-backdrop',
    );
    expect(styles).toContain('html[data-theme="dark"] .settings-dialog');
    expect(styles).toContain(
      'html[data-theme="dark"] .settings-dialog__notification',
    );
    expect(styles).toContain(
      'html[data-theme="dark"] .settings-dialog__data-control',
    );
    expect(styles).toContain(
      'html[data-theme="dark"] .custom-instructions-settings__toggle',
    );
    expect(styles).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]*?\.settings-dialog-backdrop[\s\S]*?\.settings-dialog/u,
    );
    expect(styles).toMatch(
      /@media \(max-width: 600px\) \{[\s\S]*?\.custom-instructions-settings__actions/u,
    );
    expect(styles).toMatch(
      /\.settings-conversation-bulk-action-backdrop[\s\S]*?\.conversation-mutation-dialog__actions \{[\s\S]*?padding-bottom: calc\(20px \+ env\(safe-area-inset-bottom\)\);/u,
    );
  });

  it("applies the saved collapsed preference only to desktop sidebars", async () => {
    const styles = await projectSource("app/globals.css");
    const desktopCollapseStart = styles.indexOf("@media (min-width: 781px) {");
    const desktopCollapseEnd = styles.indexOf(
      "\n.artifact-viewer-backdrop",
      desktopCollapseStart,
    );

    expect(desktopCollapseStart).toBeGreaterThan(0);
    expect(desktopCollapseEnd).toBeGreaterThan(desktopCollapseStart);
    expect(
      styles.slice(desktopCollapseStart, desktopCollapseEnd),
    ).toContain(".sidebar.sidebar--collapsed");
    expect(styles.slice(0, desktopCollapseStart)).not.toContain(
      ".sidebar.sidebar--collapsed",
    );
    expect(styles.slice(desktopCollapseEnd)).not.toContain(
      ".sidebar.sidebar--collapsed",
    );
    expect(styles).toMatch(
      /@media \(max-width: 780px\) \{[\s\S]*?\.sidebar \{[\s\S]*?width: min\(310px, calc\(100vw - 48px\)\);/u,
    );
  });
});
