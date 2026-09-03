import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RunCompletionNotification } from "@/components/run-completion-notification-state";
import { RunCompletionNotifications } from "@/components/run-completion-notifications";

const notifications: readonly RunCompletionNotification[] = [
  {
    conversationId: "10000000-0000-4000-8000-000000000001",
    runId: "20000000-0000-4000-8000-000000000001",
    title: "德国泵类买家",
    outcome: "completed",
  },
  {
    conversationId: "10000000-0000-4000-8000-000000000002",
    runId: "20000000-0000-4000-8000-000000000002",
    title: "法国经销商",
    outcome: "failed",
  },
  {
    conversationId: "10000000-0000-4000-8000-000000000003",
    runId: "20000000-0000-4000-8000-000000000003",
    title: "美国采购经理",
    outcome: "cancelled",
  },
  {
    conversationId: "10000000-0000-4000-8000-000000000004",
    runId: "20000000-0000-4000-8000-000000000004",
    title: "英国进口商",
    outcome: "reconciliation_required",
  },
];

describe("run completion notifications", () => {
  it("renders an accessible live status and named notification list", () => {
    const markup = renderToStaticMarkup(
      <RunCompletionNotifications
        notifications={notifications}
        onDismiss={() => undefined}
        onOpenConversation={() => undefined}
      />,
    );

    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      'aria-label="后台运行通知列表，仅显示最新 1 项，共 4 项"',
    );
    expect(markup).toContain("“英国进口商”后台研究需要核对积分");
    expect(markup).toContain("另有 3 项可在后台任务中查看");
    expect(markup.match(/class="run-completion-notification /gu)).toHaveLength(
      1,
    );
  });

  it("renders exact copy and style classes for each terminal outcome", () => {
    const expectations = [
      [notifications[0], "后台研究已完成", "completed"],
      [notifications[1], "后台研究未能完成", "failed"],
      [notifications[2], "后台研究已停止", "cancelled"],
      [notifications[3], "后台研究需要核对积分", "reconciliation_required"],
    ] as const;

    for (const [notification, label, className] of expectations) {
      const markup = renderToStaticMarkup(
        <RunCompletionNotifications
          notifications={[notification]}
          onDismiss={() => undefined}
          onOpenConversation={() => undefined}
        />,
      );

      expect(markup).toContain(
        `aria-label="“${notification.title}”${label}，打开对话"`,
      );
      expect(markup).toContain(
        `aria-label="关闭“${notification.title}”的后台运行通知"`,
      );
      expect(markup).toContain(
        `class="run-completion-notification run-completion-notification--${className}"`,
      );
    }
  });

  it("renders nothing for an empty queue", () => {
    expect(
      renderToStaticMarkup(
        <RunCompletionNotifications
          notifications={[]}
          onDismiss={() => undefined}
          onOpenConversation={() => undefined}
        />,
      ),
    ).toBe("");
  });
});
