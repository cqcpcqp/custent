import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MessageView,
  TurnAttemptControls,
} from "@/components/research-message";
import type { ChatMessage, MessageFeedback } from "@/lib/contracts";

const assistantMessage: ChatMessage = {
  id: "10000000-0000-4000-8000-000000000001",
  runId: null,
  role: "assistant",
  content: "已找到三家目标买家。",
  citations: [],
  artifacts: [],
  attachments: [],
  feedback: null,
  createdAt: "2026-08-26T08:00:00.000Z",
};

function renderFeedback(
  feedback: MessageFeedback | null,
  isFeedbackPending = false,
): string {
  return renderToStaticMarkup(
    <MessageView
      events={[]}
      isFeedbackPending={isFeedbackPending}
      message={{ ...assistantMessage, feedback }}
      onFeedback={() => undefined}
      onOpenActivity={() => undefined}
      run={null}
    />,
  );
}

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

describe("assistant message feedback UI", () => {
  it("uses a full-width document flow without assistant chrome or completion metadata", () => {
    const markup = renderFeedback(null);

    expect(markup).toContain('class="assistant-message-body"');
    expect(markup).toContain('class="assistant-message-footer"');
    expect(markup).not.toContain("assistant-mark");
    expect(markup).not.toContain("assistant-message-meta");
    expect(markup).not.toContain("08:00");
  });

  it("marks an exact search target on the persisted message article", () => {
    const markup = renderToStaticMarkup(
      <MessageView
        events={[]}
        isFeedbackPending={false}
        isSearchMatch
        message={assistantMessage}
        onFeedback={() => undefined}
        onOpenActivity={() => undefined}
        run={null}
      />,
    );

    expect(markup).toContain(
      'class="message message--assistant message--search-match"',
    );
    expect(markup).toContain(`data-message-id="${assistantMessage.id}"`);
  });

  it("renders mutually exclusive unselected feedback controls", () => {
    const markup = renderFeedback(null);

    expect(markup).toContain(
      'class="message-actions message-actions--persistent"',
    );
    expect(openingTag(markup, 'aria-label="回答反馈"')).toContain(
      'aria-busy="false"',
    );
    expect(openingTag(markup, 'aria-label="赞同此回答"')).toContain(
      'aria-pressed="false"',
    );
    expect(openingTag(markup, 'aria-label="不赞同此回答"')).toContain(
      'aria-pressed="false"',
    );
    expect(markup).toContain("尚未评价此回答");
  });

  it("keeps the actions visible and announces a pending save", () => {
    const markup = renderFeedback(null, true);

    expect(markup).toContain("message-actions--persistent");
    expect(openingTag(markup, 'aria-label="回答反馈"')).toContain(
      'aria-busy="true"',
    );
    expect(openingTag(markup, 'aria-label="正在保存回答反馈"')).toContain(
      "disabled",
    );
    expect(markup).toContain("正在保存回答反馈");
  });

  it("renders and announces the persisted selected value", () => {
    const markup = renderFeedback("up");

    expect(markup).toContain("message-actions--persistent");
    expect(openingTag(markup, 'aria-label="取消赞同此回答"')).toContain(
      'aria-pressed="true"',
    );
    expect(openingTag(markup, 'aria-label="不赞同此回答"')).toContain(
      'aria-pressed="false"',
    );
    expect(markup).toContain("已赞同此回答");
  });

  it("composes copy, feedback, and regenerate into one ordered action bar", () => {
    const markup = renderToStaticMarkup(
      <MessageView
        assistantActions={
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
          />
        }
        events={[]}
        isFeedbackPending={false}
        message={assistantMessage}
        onFeedback={() => undefined}
        onOpenActivity={() => undefined}
        run={null}
      />,
    );
    const copyIndex = markup.indexOf('aria-label="复制消息"');
    const upIndex = markup.indexOf('aria-label="赞同此回答"');
    const downIndex = markup.indexOf('aria-label="不赞同此回答"');
    const regenerateIndex = markup.indexOf('aria-label="重新生成回答"');

    expect(
      markup.match(
        /class="message-actions message-actions--persistent"/gu,
      ),
    ).toHaveLength(1);
    expect(copyIndex).toBeGreaterThan(-1);
    expect(upIndex).toBeGreaterThan(copyIndex);
    expect(downIndex).toBeGreaterThan(upIndex);
    expect(regenerateIndex).toBeGreaterThan(downIndex);
  });
});
