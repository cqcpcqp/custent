import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RunCompletionNotification } from "@/components/run-completion-notification-state";
import {
  RunCompletionSystemNotifications,
  runCompletionSystemNotificationPresentation,
} from "@/components/run-completion-system-notifications";

const notification: RunCompletionNotification = {
  conversationId: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  title: "德国泵类买家",
  outcome: "completed",
};

describe("Run-completion system notifications", () => {
  it.each([
    ["completed", "后台研究已完成"],
    ["failed", "后台研究未能完成"],
    ["cancelled", "后台研究已停止"],
    ["reconciliation_required", "后台研究需要核对积分"],
  ] as const)("presents %s with exact system copy", (outcome, title) => {
    expect(
      runCompletionSystemNotificationPresentation({
        ...notification,
        outcome,
      }),
    ).toEqual({
      title,
      options: {
        body: "“德国泵类买家”",
        lang: "zh-CN",
        tag: `custent:run-completion:${JSON.stringify([
          notification.conversationId,
          notification.runId,
        ])}`,
      },
    });
  });

  it("renders no duplicate visual surface because the existing in-app toast remains responsible for UI", () => {
    expect(
      renderToStaticMarkup(
        <RunCompletionSystemNotifications
          notifications={[notification]}
          onOpenConversation={() => undefined}
        />,
      ),
    ).toBe("");
  });

  it("uses the Web Locks claim and never requests permission from a completion effect", async () => {
    const source = await readFile(
      path.join(
        process.cwd(),
        "components/run-completion-system-notifications.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("window.navigator.locks.request(");
    expect(source).toContain('{ mode: "exclusive" }');
    expect(source).toContain("coordinateRunCompletionSystemNotification");
    expect(source).not.toContain("requestPermission");
  });

  it("mounts alongside rather than replacing the in-app completion notifications", async () => {
    const workspaceSource = await readFile(
      path.join(process.cwd(), "components/research-workspace.tsx"),
      "utf8",
    );

    expect(workspaceSource).toMatch(
      /<RunCompletionNotifications[\s\S]*?notifications=\{runCompletionNotifications\}[\s\S]*?<RunCompletionSystemNotifications[\s\S]*?notifications=\{runCompletionNotifications\}/u,
    );
  });
});
