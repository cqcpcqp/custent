import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";

function renderDialog(): string {
  return renderToStaticMarkup(
    <KeyboardShortcutsDialog onClose={() => undefined} />,
  );
}

describe("keyboard shortcuts dialog", () => {
  it("renders an accessible modal with a named shortcut list", () => {
    const markup = renderDialog();

    expect(markup).toContain('data-modal-layer=""');
    expect(markup).toContain(
      'aria-describedby="keyboard-shortcuts-dialog-description" aria-labelledby="keyboard-shortcuts-dialog-title" aria-modal="true"',
    );
    expect(markup).toContain('id="keyboard-shortcuts-dialog"');
    expect(markup).toContain('role="dialog" tabindex="-1"');
    expect(markup).toContain('aria-label="关闭快捷键"');
    expect(markup).toContain('<ul aria-label="工作区快捷键">');
    expect(markup).toContain("<kbd");
  });

  it("shows exactly seven truthful keyboard contracts", () => {
    const markup = renderDialog();

    expect(markup.match(/<li(?:\s[^>]*)?>/gu)).toHaveLength(7);
    for (const label of [
      "新建研究",
      "聚焦研究输入框",
      "搜索对话",
      "发送消息",
      "消息内换行",
      "关闭当前窗口或菜单",
      "显示快捷键",
    ]) {
      expect(markup.match(new RegExp(`>${label}<`, "gu"))).toHaveLength(1);
    }
    expect(markup).toContain(">⌘</kbd>");
    expect(markup).toContain(">O</kbd>");
    expect(markup).toContain(">K</kbd>");
    expect(markup).toContain(">Enter</kbd>");
    expect(markup).toContain(">⇧</kbd>");
    expect(markup).toContain(">Esc</kbd>");
    expect(markup).toContain(">/</kbd>");
    expect(markup).toContain("当前输入框可用时");
  });

  it("has dedicated desktop, compact mobile, and dark-theme styling", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const shortcutStylesStart = styles.indexOf(
      ".keyboard-shortcuts-backdrop {",
    );
    const mobileStylesStart = styles.indexOf(
      "@media (max-width: 600px) {",
      shortcutStylesStart,
    );
    const mobileStylesEnd = styles.indexOf(
      "/* Input attachments */",
      mobileStylesStart,
    );
    const mobileStyles = styles.slice(mobileStylesStart, mobileStylesEnd);

    expect(shortcutStylesStart).toBeGreaterThanOrEqual(0);
    expect(styles).toContain(".keyboard-shortcuts-dialog {");
    expect(styles).toContain(".keyboard-shortcuts-dialog__body {");
    expect(styles).toContain(".keyboard-shortcuts-dialog__body li {");
    expect(styles).toMatch(
      /\.keyboard-shortcuts-dialog__keys kbd,?\s*(?:\.keyboard-shortcuts-dialog__platform-note kbd)?\s*\{/u,
    );
    expect(mobileStylesStart).toBeGreaterThan(shortcutStylesStart);
    expect(mobileStylesEnd).toBeGreaterThan(mobileStylesStart);
    expect(mobileStyles).toContain(".conversation-mutation-dialog {");
    expect(mobileStyles).toContain(".keyboard-shortcuts-dialog__body {");
    expect(styles).toMatch(
      /html\[data-theme="dark"\] \.keyboard-shortcuts-dialog__keys kbd,?\s*(?:html\[data-theme="dark"\] \.keyboard-shortcuts-dialog__platform-note kbd)?\s*\{/u,
    );
  });
});
