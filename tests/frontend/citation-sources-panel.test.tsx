import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CitationSourcesPanel,
  citationSourcesPanelIsModal,
  closeCitationSourcesPanelFromBackdrop,
  closeCitationSourcesPanelFromButton,
  closeDesktopCitationSourcesPanelFromEscape,
  scrollActiveCitationSourceIntoView,
} from "@/components/citation-sources-panel";
import type { NumberedCitation } from "@/components/inline-citation-state";

const citations: readonly NumberedCitation[] = [
  {
    citation: {
      url: "https://www.example.com/buyers/report",
      title: "Example Buyers Report",
      startIndex: 4,
      endIndex: 16,
    },
    citedText: "德国进口增长",
    number: 1,
    originalIndex: 1,
  },
  {
    citation: {
      url: "https://trade.example.org/directory",
      title: "Trade Directory",
      startIndex: 20,
      endIndex: 28,
    },
    citedText: "采购负责人",
    number: 2,
    originalIndex: 0,
  },
];

function renderPanel(input: {
  activeNumber?: number;
  citations?: readonly NumberedCitation[];
  isOpen?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    <CitationSourcesPanel
      activeNumber={input.activeNumber}
      citations={input.citations ?? citations}
      isOpen={input.isOpen ?? true}
      onClose={() => undefined}
    />,
  );
}

describe("citation sources panel", () => {
  it("renders only the strict citation fields and explicit original-page links", () => {
    const markup = renderPanel({ activeNumber: 2 });

    expect(markup).toContain('id="citation-sources-panel"');
    expect(markup).toContain('id="citation-sources-panel-title"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("2 个回答引用");
    expect(markup).toContain("Example Buyers Report");
    expect(markup).toContain("example.com");
    expect(markup).toContain("德国进口增长");
    expect(markup).toContain("Trade Directory");
    expect(markup).toContain("trade.example.org");
    expect(markup).toContain("采购负责人");
    expect(markup).toContain(
      'aria-label="打开原网页：Trade Directory"',
    );
    expect(markup).toContain(
      'href="https://trade.example.org/directory"',
    );
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain("打开原网页");
    expect(markup).toContain(
      "不包含额外抓取或网页摘要",
    );
    expect(markup).not.toContain("来源摘要");
  });

  it("marks only the requested active citation", () => {
    const markup = renderPanel({ activeNumber: 2 });

    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
    expect(markup.match(/citation-sources-panel__item--active/gu)).toHaveLength(
      1,
    );
  });

  it("scrolls the active source into the nearest visible position", () => {
    const scrollIntoView = vi.fn();

    scrollActiveCitationSourceIntoView(true, 2, { scrollIntoView });

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(() =>
      scrollActiveCitationSourceIntoView(true, 2, null),
    ).toThrow("活动引用 2 缺少对应的来源元素");
  });

  it("does not scroll without both an open panel and an active source", () => {
    const scrollIntoView = vi.fn();

    scrollActiveCitationSourceIntoView(false, 2, { scrollIntoView });
    scrollActiveCitationSourceIntoView(true, undefined, { scrollIntoView });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("fails closed for an invalid or unknown active number", () => {
    expect(() => renderPanel({ activeNumber: 0 })).toThrow(
      "活动引用编号必须是正安全整数",
    );
    expect(() => renderPanel({ activeNumber: 3 })).toThrow(
      "活动引用编号 3 不在回答来源中",
    );
  });

  it("renders an exact empty state without inventing source content", () => {
    const markup = renderPanel({ citations: [] });

    expect(markup).toContain("0 个回答引用");
    expect(markup).toContain("这条回答没有保存来源引用。");
    expect(markup).not.toContain('aria-label="回答来源列表"');
  });

  it("keeps a closed panel inert while preserving its dialog trigger contract", () => {
    const markup = renderPanel({ isOpen: false });
    const asideStart = markup.indexOf("<aside");
    const asideEnd = markup.indexOf(">", asideStart);
    const aside = markup.slice(asideStart, asideEnd + 1);

    expect(aside).toContain('aria-hidden="true"');
    expect(aside).toContain("inert=\"\"");
    expect(aside).toContain('role="dialog"');
    expect(aside).not.toContain('aria-modal="true"');
  });

  it("uses a non-modal dialog on desktop and modal semantics only when narrow", () => {
    const markup = renderPanel();
    const asideStart = markup.indexOf("<aside");
    const asideEnd = markup.indexOf(">", asideStart);
    const aside = markup.slice(asideStart, asideEnd + 1);

    expect(aside).toContain('role="dialog"');
    expect(aside).toContain(
      'aria-labelledby="citation-sources-panel-title"',
    );
    expect(aside).not.toContain('aria-modal="true"');
    expect(citationSourcesPanelIsModal(true, true)).toBe(true);
    expect(citationSourcesPanelIsModal(true, false)).toBe(false);
    expect(citationSourcesPanelIsModal(false, true)).toBe(false);
  });

  it("keeps titles, domains, and cited text wrap-safe", async () => {
    const styles = await readFile(
      path.join(process.cwd(), "app/globals.css"),
      "utf8",
    );
    const selector = [
      ".citation-sources-panel__source > strong,",
      ".citation-sources-panel__domain,",
      ".citation-sources-panel__cited-text blockquote {",
    ].join("\n");
    const ruleStart = styles.indexOf(selector);
    const ruleEnd = styles.indexOf("}", ruleStart);

    expect(ruleStart).toBeGreaterThanOrEqual(0);
    expect(ruleEnd).toBeGreaterThan(ruleStart);
    const rule = styles.slice(ruleStart, ruleEnd + 1);
    expect(rule).toContain("min-width: 0;");
    expect(rule).toContain("max-width: 100%;");
    expect(rule).toContain("overflow-wrap: anywhere;");
    expect(rule).toContain("white-space: normal;");
    expect(rule).toContain("word-break: break-word;");
  });

  it("closes only from the actual backdrop and preserves focus semantics", () => {
    const onClose = vi.fn();
    const backdrop = {};
    const preventDefault = vi.fn();

    closeCitationSourcesPanelFromBackdrop(
      {
        currentTarget: backdrop as HTMLDivElement,
        target: {} as EventTarget,
        preventDefault,
      },
      onClose,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();

    closeCitationSourcesPanelFromBackdrop(
      {
        currentTarget: backdrop as HTMLDivElement,
        target: backdrop as HTMLDivElement,
        preventDefault,
      },
      onClose,
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes a desktop panel on Escape and restores its trigger after close", async () => {
    const order: string[] = [];
    const preventDefault = vi.fn();
    const onClose = vi.fn(() => order.push("close"));
    const focus = vi.fn(() => order.push("focus"));

    expect(
      closeDesktopCitationSourcesPanelFromEscape(
        { key: "Escape", preventDefault },
        onClose,
        { focus },
        false,
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(focus).toHaveBeenCalledOnce();
    expect(order).toEqual(["close", "focus"]);
  });

  it("restores the citation trigger after the desktop close button closes", async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    const focus = vi.fn(() => order.push("focus"));

    closeCitationSourcesPanelFromButton(false, onClose, { focus });

    expect(onClose).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(focus).toHaveBeenCalledOnce();
    expect(order).toEqual(["close", "focus"]);
  });

  it("leaves desktop focus and state unchanged for non-Escape keys", async () => {
    const preventDefault = vi.fn();
    const onClose = vi.fn();
    const focus = vi.fn();

    expect(
      closeDesktopCitationSourcesPanelFromEscape(
        { key: "Enter", preventDefault },
        onClose,
        { focus },
        false,
      ),
    ).toBe(false);
    await Promise.resolve();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not let desktop Escape close sources behind an existing aria modal", async () => {
    const preventDefault = vi.fn();
    const onClose = vi.fn();
    const focus = vi.fn();

    expect(
      closeDesktopCitationSourcesPanelFromEscape(
        { key: "Escape", preventDefault },
        onClose,
        { focus },
        true,
      ),
    ).toBe(false);
    await Promise.resolve();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("isolates desktop handling from narrow modal focus management", async () => {
    const source = await readFile(
      path.join(process.cwd(), "components/citation-sources-panel.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /useModalFocus\(\{[\s\S]*backdropRef,[\s\S]*canClose: true,[\s\S]*containerRef: panelRef,[\s\S]*enabled: isModalOpen,[\s\S]*initialFocusRef: closeButtonRef,[\s\S]*onClose,[\s\S]*returnFocusRef,[\s\S]*\}\);/u,
    );
    expect(source).toContain("if (!isOpen || isNarrowViewport)");
    expect(source).toContain(
      "closeDesktopCitationSourcesPanelFromEscape(",
    );
    expect(source).toContain("documentHasOpenModal(document)");
    expect(source).toContain("ref={isActive ? activeItemRef : undefined}");
    expect(source).toContain('aria-label="关闭来源面板"');
  });
});
