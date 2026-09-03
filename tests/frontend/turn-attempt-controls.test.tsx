import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TurnAttemptControls,
  TurnBranchControls,
} from "@/components/research-message";

function openingTag(markup: string, marker: string): string {
  const markerIndex = markup.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find markup marker: ${marker}`);
  }
  const start = markup.lastIndexOf("<", markerIndex);
  const end = markup.indexOf(">", markerIndex);
  if (start === -1 || end === -1) {
    throw new Error(`Could not find opening tag for marker: ${marker}`);
  }
  return markup.slice(start, end + 1);
}

describe("turn attempt controls", () => {
  it("offers regenerate for the latest completed single answer", () => {
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={1}
        attemptIndex={0}
        isRegenerateEligible
        isRegenerating={false}
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="重新生成回答"');
    expect(markup).not.toContain("查看上一个回答");
  });

  it("renders regenerate as a compact inline message action", () => {
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={1}
        attemptIndex={0}
        inline
        isRegenerateEligible
        isRegenerating={false}
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
      />,
    );

    expect(openingTag(markup, 'aria-label="回答版本"')).toContain(
      "turn-attempt-controls--inline",
    );
    expect(markup).toContain(
      '<span class="visually-hidden">重新生成</span>',
    );
    expect(markup).toContain('aria-label="重新生成回答"');
  });

  it("renders bounded previous and next navigation with a live position", () => {
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={2}
        attemptIndex={0}
        isRegenerateEligible={false}
        isRegenerating={false}
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
      />,
    );

    expect(openingTag(markup, 'aria-label="查看上一个回答"')).toContain(
      "disabled",
    );
    expect(openingTag(markup, 'aria-label="查看下一个回答"')).not.toContain(
      "disabled",
    );
    expect(markup).toContain("1 / 2");
    expect(markup).toContain('aria-live="polite"');
  });

  it("announces and disables a pending regenerate", () => {
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={1}
        attemptIndex={0}
        isRegenerateEligible={false}
        isRegenerating
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
      />,
    );

    expect(openingTag(markup, 'aria-label="正在重新生成回答"')).toContain(
      "disabled",
    );
    expect(markup).toContain("正在重新生成…");
  });

  it("rejects an impossible selection position", () => {
    expect(() =>
      renderToStaticMarkup(
        <TurnAttemptControls
          attemptCount={1}
          attemptIndex={1}
          isRegenerateEligible={false}
          isRegenerating={false}
          isSelecting={false}
          onNext={() => undefined}
          onPrevious={() => undefined}
          onRegenerate={() => undefined}
        />,
      ),
    ).toThrow("回答版本位置无效");
  });

  it("disables answer navigation and announces a persisted branch switch", () => {
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={2}
        attemptIndex={0}
        isRegenerateEligible={false}
        isRegenerating={false}
        isSelecting
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
      />,
    );

    expect(openingTag(markup, 'aria-label="回答版本"')).toContain(
      'aria-busy="true"',
    );
    expect(
      openingTag(
        markup,
        'aria-label="查看下一个回答不可用：正在切换会话分支，请稍候"',
      ),
    ).toContain("disabled");
    expect(markup).toContain("正在切换…");
  });

  it("keeps regenerate and answer navigation visible but disabled under the conversation mutation lock", () => {
    const mutationDisabledReason = "该对话正在处理其他操作，请稍候。";
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={2}
        attemptIndex={0}
        isRegenerateEligible
        isRegenerating={false}
        isSelecting={false}
        mutationDisabledReason={mutationDisabledReason}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
      />,
    );

    expect(openingTag(markup, 'aria-label="回答版本"')).toContain(
      'aria-disabled="true"',
    );
    expect(
      openingTag(
        markup,
        `aria-label="重新生成回答不可用：${mutationDisabledReason}"`,
      ),
    ).toContain("disabled");
    expect(
      openingTag(
        markup,
        `aria-label="查看下一个回答不可用：${mutationDisabledReason}"`,
      ),
    ).toContain("disabled");
    expect(markup).toContain(`title="${mutationDisabledReason}"`);
  });

  it.each([
    "研究正在运行或等待中，完成或停止后才能重新生成回答。",
    "恢复已归档对话后才能重新生成回答。",
  ])(
    "keeps an intrinsically eligible single-answer regenerate visible with its temporary disabled reason: %s",
    (regenerateDisabledReason) => {
      const ariaLabel = `重新生成回答不可用：${regenerateDisabledReason}`;
      const markup = renderToStaticMarkup(
        <TurnAttemptControls
          attemptCount={1}
          attemptIndex={0}
          isRegenerateEligible
          isRegenerating={false}
          isSelecting={false}
          onNext={() => undefined}
          onPrevious={() => undefined}
          onRegenerate={() => undefined}
          regenerateDisabledReason={regenerateDisabledReason}
        />,
      );

      expect(openingTag(markup, 'aria-label="回答版本"')).toContain(
        'aria-disabled="true"',
      );
      expect(openingTag(markup, `aria-label="${ariaLabel}"`)).toContain(
        "disabled",
      );
      expect(openingTag(markup, `aria-label="${ariaLabel}"`)).toContain(
        `title="${regenerateDisabledReason}"`,
      );
    },
  );

  it("keeps answer navigation enabled when only regenerate is temporarily blocked", () => {
    const regenerateDisabledReason =
      "恢复已归档对话后才能重新生成回答。";
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={2}
        attemptIndex={0}
        isRegenerateEligible
        isRegenerating={false}
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
        regenerateDisabledReason={regenerateDisabledReason}
      />,
    );

    expect(openingTag(markup, 'aria-label="回答版本"')).not.toContain(
      "aria-disabled",
    );
    expect(
      openingTag(
        markup,
        `aria-label="重新生成回答不可用：${regenerateDisabledReason}"`,
      ),
    ).toContain("disabled");
    expect(openingTag(markup, 'aria-label="查看下一个回答"')).not.toContain(
      "disabled",
    );
  });

  it("does not expose regenerate when the selected attempt is intrinsically ineligible", () => {
    const markup = renderToStaticMarkup(
      <TurnAttemptControls
        attemptCount={1}
        attemptIndex={0}
        isRegenerateEligible={false}
        isRegenerating={false}
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onRegenerate={() => undefined}
        regenerateDisabledReason="研究正在运行或等待中"
      />,
    );

    expect(markup).toBe("");
  });
});

describe("turn branch controls", () => {
  it("renders bounded user branch arrows and N/M", () => {
    const markup = renderToStaticMarkup(
      <TurnBranchControls
        branchCount={3}
        branchIndex={1}
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="用户消息分支"');
    expect(markup).toContain("2 / 3");
    expect(
      openingTag(markup, 'aria-label="查看上一个用户消息分支"'),
    ).not.toContain("disabled");
    expect(
      openingTag(markup, 'aria-label="查看下一个用户消息分支"'),
    ).not.toContain("disabled");
  });

  it("hides navigation when there is only one user branch", () => {
    const markup = renderToStaticMarkup(
      <TurnBranchControls
        branchCount={1}
        branchIndex={0}
        isSelecting={false}
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );

    expect(markup).toBe("");
  });

  it("disables both branch directions with an accessible mutation reason", () => {
    const mutationDisabledReason = "该对话正在处理其他操作，请稍候。";
    const markup = renderToStaticMarkup(
      <TurnBranchControls
        branchCount={3}
        branchIndex={1}
        isSelecting={false}
        mutationDisabledReason={mutationDisabledReason}
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );

    expect(openingTag(markup, 'aria-label="用户消息分支"')).toContain(
      'aria-disabled="true"',
    );
    expect(
      openingTag(
        markup,
        `aria-label="查看上一个用户消息分支不可用：${mutationDisabledReason}"`,
      ),
    ).toContain("disabled");
    expect(
      openingTag(
        markup,
        `aria-label="查看下一个用户消息分支不可用：${mutationDisabledReason}"`,
      ),
    ).toContain("disabled");
  });

  it("reports the branch group as disabled while a selection is pending", () => {
    const markup = renderToStaticMarkup(
      <TurnBranchControls
        branchCount={3}
        branchIndex={1}
        isSelecting
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );

    expect(openingTag(markup, 'aria-label="用户消息分支"')).toContain(
      'aria-busy="true"',
    );
    expect(openingTag(markup, 'aria-label="用户消息分支"')).toContain(
      'aria-disabled="true"',
    );
    expect(markup).toContain("正在切换会话分支，请稍候");
  });
});
