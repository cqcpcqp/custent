import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MOBILE_ACCESSIBILITY_MARKER = "/* Mobile accessibility targets */";

async function mobileAccessibilityStyles(): Promise<string> {
  const styles = await readFile(
    path.join(process.cwd(), "app/globals.css"),
    "utf8",
  );
  const markerIndex = styles.indexOf(MOBILE_ACCESSIBILITY_MARKER);

  if (markerIndex < 0) {
    throw new Error("缺少移动端可访问性样式区块");
  }

  return styles.slice(markerIndex);
}

function cssRule(styles: string, selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`缺少移动端样式规则 ${selector}`);
  }
  const end = styles.indexOf("}", start);
  if (end < 0) {
    throw new Error(`移动端样式规则 ${selector} 缺少结束括号`);
  }
  return styles.slice(start, end + 1);
}

function widestWrappedLine(
  itemWidths: readonly number[],
  availableWidth: number,
  gap: number,
): number {
  let currentLineWidth = 0;
  let widestLine = 0;

  for (const itemWidth of itemWidths) {
    const nextWidth =
      currentLineWidth === 0
        ? itemWidth
        : currentLineWidth + gap + itemWidth;
    if (currentLineWidth > 0 && nextWidth > availableWidth) {
      widestLine = Math.max(widestLine, currentLineWidth);
      currentLineWidth = itemWidth;
    } else {
      currentLineWidth = nextWidth;
    }
  }

  return Math.max(widestLine, currentLineWidth);
}

describe("mobile accessibility styles", () => {
  it("prevents iOS input zoom for every editable conversation field", async () => {
    const styles = await mobileAccessibilityStyles();

    expect(styles).toMatch(
      /\.conversation-search-field input \{\s*font-size: 16px;\s*\}/u,
    );
    expect(styles).toMatch(
      /\.conversation-mutation-dialog__field input \{\s*font-size: 16px;\s*\}/u,
    );
    expect(styles).toMatch(
      /\.user-message-editor textarea \{\s*font-size: 16px;\s*\}/u,
    );
  });

  it("keeps primary mobile controls at least 44 by 44 CSS pixels", async () => {
    const styles = await mobileAccessibilityStyles();
    const directTargetsStart = styles.indexOf("  .icon-button,");
    const directTargetsEnd = styles.indexOf(
      "  .composer__input-row {",
      directTargetsStart,
    );
    const directTargets = styles.slice(directTargetsStart, directTargetsEnd);

    expect(directTargetsStart).toBeGreaterThan(0);
    expect(directTargetsEnd).toBeGreaterThan(directTargetsStart);
    expect(directTargets).toContain(".conversation-link,");
    expect(directTargets).toContain(".conversation-more-button,");
    expect(directTargets).toContain(".message-action-button,");
    expect(directTargets).toContain(
      ".activity-event__tool-details > summary,",
    );
    expect(directTargets).toContain(
      ".activity-event__search-details > summary,",
    );
    expect(directTargets).toContain(".activity-panel__notice > summary,");
    expect(directTargets).toContain(".run-process-card__toggle,");
    expect(directTargets).toContain(
      ".background-run-center__history-filter,",
    );
    expect(directTargets).toContain(
      ".background-run-center__history-failure button,",
    );
    expect(directTargets).toContain(
      ".background-run-center__history-load-more,",
    );
    expect(directTargets).toContain(".composer__attach,");
    expect(directTargets).toContain(".composer__send,");
    expect(directTargets).toContain(".artifact-viewer__action,");
    expect(directTargets).toContain(".artifact-viewer__error button,");
    expect(directTargets).toContain(".conversation-share-dialog__copy,");
    expect(directTargets).toContain(".conversation-share-dialog__revoke,");
    expect(directTargets).toContain("min-width: 44px;");
    expect(directTargets).toContain("min-height: 44px;");
    expect(styles).toMatch(
      /\.composer__input-row \{\s*grid-template-columns: 44px minmax\(0, 1fr\) auto;\s*\}/u,
    );
    expect(styles).toMatch(
      /\.conversation-row \.conversation-link \{\s*min-width: 44px;\s*\}/u,
    );
    expect(styles).toMatch(
      /\.turn-attempt-controls--inline \.turn-attempt-controls__regenerate \{\s*width: 44px;\s*min-width: 44px;\s*\}/u,
    );
  });

  it("expands compact header buttons without changing their visual size", async () => {
    const styles = await mobileAccessibilityStyles();

    expect(styles).toMatch(
      /\.header-new-button,\s*\.header-activity-button,\s*\.header-share-button \{\s*position: relative;\s*\}/u,
    );
    expect(styles).toMatch(
      /\.header-new-button::after,\s*\.header-activity-button::after,\s*\.header-share-button::after \{[\s\S]*width: 44px;[\s\S]*height: 44px;[\s\S]*content: "";/u,
    );
  });

  it.each([320, 390])(
    "wraps the complete answer action set without horizontal overflow at %ipx",
    async (viewportWidth) => {
      const styles = await mobileAccessibilityStyles();
      const footerRule = cssRule(styles, "  .assistant-message-footer");
      const messageActionsRule = cssRule(
        styles,
        "  .assistant-message-footer .message-actions",
      );
      const attemptRule = cssRule(styles, "  .turn-attempt-controls");
      const inlineAttemptRule = cssRule(
        styles,
        "  .turn-attempt-controls--inline",
      );
      const branchRule = cssRule(styles, "  .turn-branch-controls");

      expect(footerRule).toMatch(
        /max-width: 100%;[\s\S]*flex-wrap: wrap;/u,
      );
      expect(messageActionsRule).toMatch(
        /width: 100%;[\s\S]*max-width: 100%;[\s\S]*flex: 1 1 100%;[\s\S]*flex-wrap: wrap;/u,
      );
      expect(attemptRule).toMatch(
        /max-width: calc\(100% - 37px\);[\s\S]*flex-wrap: wrap;/u,
      );
      expect(inlineAttemptRule).toContain("max-width: 100%");
      expect(branchRule).toContain("max-width: 100%");

      const target = 44;
      const compactGap = 2;
      const actionGap = 6;
      const position = 34;
      const feedbackActions = target + actionGap + target;
      const attemptNavigator =
        target + compactGap + position + compactGap + target;
      const inlineAttempt = target + actionGap + attemptNavigator;
      const assistantBodyWidth = viewportWidth - 24 - 28 - 9;
      const wrappedActionWidth = widestWrappedLine(
        [target, feedbackActions, inlineAttempt],
        assistantBodyWidth,
        actionGap,
      );
      const userMessageWidth = (viewportWidth - 24) * 0.9;
      const branchControlsWidth = attemptNavigator;

      expect(wrappedActionWidth).toBeLessThanOrEqual(assistantBodyWidth);
      expect(inlineAttempt).toBeLessThanOrEqual(assistantBodyWidth);
      expect(branchControlsWidth).toBeLessThanOrEqual(userMessageWidth);
    },
  );

  it("keeps the 44px notification dismiss target inside its grid track", async () => {
    const styles = await mobileAccessibilityStyles();

    expect(cssRule(styles, "  .run-completion-notification")).toContain(
      "grid-template-columns: minmax(0, 1fr) 44px",
    );
    expect(
      cssRule(styles, "  .run-completion-notification__dismiss"),
    ).toMatch(/width: 44px;[\s\S]*height: 44px;/u);
  });
});
