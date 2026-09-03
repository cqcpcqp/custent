import { readFile } from "node:fs/promises";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  MessageBranchToNewConversationAction,
  messageBranchToNewConversationState,
  type MessageBranchToNewConversationControls,
} from "@/components/message-branch-action";
import {
  MessageView,
  TurnAttemptControls,
} from "@/components/research-message";
import type { AgentRun, AgentRunStatus, ChatMessage, RunEvent } from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const conversationId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000001";
const userMessageId = "30000000-0000-4000-8000-000000000001";
const assistantMessageId = "40000000-0000-4000-8000-000000000001";

const userMessage: ChatMessage = {
  id: userMessageId,
  runId,
  role: "user",
  content: "研究德国泵类买家",
  citations: [],
  artifacts: [],
  attachments: [],
  feedback: null,
  createdAt: "2026-08-28T08:00:00.000Z",
};

const assistantMessage: ChatMessage = {
  id: assistantMessageId,
  runId,
  role: "assistant",
  content: "已完成买家研究。",
  citations: [],
  artifacts: [],
  attachments: [],
  feedback: null,
  createdAt: "2026-08-28T08:01:00.000Z",
};

function agentRun(status: AgentRunStatus): AgentRun {
  const isTerminal =
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "reconciliation_required";
  return {
    id: runId,
    requestId: "50000000-0000-4000-8000-000000000001",
    conversationId,
    inputMessageId: userMessageId,
    assistantMessageId: status === "completed" ? assistantMessageId : null,
    status,
    conversationTurn: "1",
    attemptIndex: 1,
    predecessorRunId: null,
    retryOfRunId: null,
    regenerateOfRunId: null,
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
    failure:
      status === "failed" ||
      status === "cancelled" ||
      status === "reconciliation_required"
        ? { code: "RUN_TERMINAL", message: "研究已结束" }
        : null,
    createdAt: "2026-08-28T08:00:00.000Z",
    startedAt:
      status === "waiting" || status === "queued"
        ? null
        : "2026-08-28T08:00:01.000Z",
    finishedAt: isTerminal ? "2026-08-28T08:01:00.000Z" : null,
    cancelRequestedAt: null,
  };
}

function controls(
  input: Partial<MessageBranchToNewConversationControls> = {},
): MessageBranchToNewConversationControls {
  return {
    disabledReason: null,
    isPending: false,
    onBranch: () => undefined,
    ...input,
  };
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

type InspectableElement = {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
};

function isInspectableElement(value: unknown): value is InspectableElement {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value
  );
}

function findButton(root: unknown): InspectableElement {
  if (isInspectableElement(root)) {
    if (root.type === "button") {
      return root;
    }
    return findButton(root.props.children);
  }
  if (Array.isArray(root)) {
    for (const child of root) {
      try {
        return findButton(child);
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
      }
    }
  }
  throw new TypeError("Could not find branch action button");
}

describe("message branch-to-new-conversation action", () => {
  it("renders an enabled persisted assistant-message action", () => {
    const markup = renderToStaticMarkup(
      <MessageBranchToNewConversationAction
        controls={controls()}
        events={[]}
        message={assistantMessage}
        run={agentRun("completed")}
      />,
    );
    const button = openingTag(markup, 'aria-label="在新对话中分支"');

    expect(button).not.toContain("disabled");
    expect(button).toContain('title="在新对话中分支"');
    expect(markup).toContain('class="message-branch-action"');
  });

  it.each(["waiting", "queued", "running"] as const)(
    "disables a %s target using the effective Run state",
    (status) => {
      const markup = renderToStaticMarkup(
        <MessageBranchToNewConversationAction
          controls={controls()}
          events={[]}
          message={userMessage}
          run={agentRun(status)}
        />,
      );

      expect(markup).toContain(
        "在新对话中分支不可用：研究正在运行或等待中，完成或停止后才能在新对话中分支",
      );
      expect(
        openingTag(markup, "在新对话中分支不可用"),
      ).toContain("disabled");
    },
  );

  it("uses a terminal event immediately instead of waiting for stale Run detail", () => {
    const terminalEvent: RunEvent = {
      id: "1",
      runId,
      createdAt: "2026-08-28T08:01:00.000Z",
      payload: {
        type: "error",
        error: {
          code: "RUN_CANCELLED",
          message: "研究已停止",
          runId,
        },
      },
    };

    expect(
      messageBranchToNewConversationState({
        controls: controls(),
        events: [terminalEvent],
        message: userMessage,
        run: agentRun("running"),
      })?.disabledReason,
    ).toBeNull();
  });

  it("exposes explicit pending and caller-disabled accessibility states", () => {
    const pendingMarkup = renderToStaticMarkup(
      <MessageBranchToNewConversationAction
        controls={controls({ isPending: true })}
        events={[]}
        message={assistantMessage}
        run={agentRun("completed")}
      />,
    );
    expect(pendingMarkup).toContain('aria-busy="true"');
    expect(pendingMarkup).toContain('aria-label="正在创建新对话分支"');
    expect(pendingMarkup).toContain('role="status"');
    expect(openingTag(pendingMarkup, "正在创建新对话分支")).toContain(
      "disabled",
    );

    const disabledMarkup = renderToStaticMarkup(
      <MessageBranchToNewConversationAction
        controls={controls({ disabledReason: "当前会话正在进行其他变更" })}
        events={[]}
        message={assistantMessage}
        run={agentRun("completed")}
      />,
    );
    expect(disabledMarkup).toContain(
      "在新对话中分支不可用：当前会话正在进行其他变更",
    );
  });

  it("passes the fixed persisted target and trigger to the callback", () => {
    const onBranch = vi.fn();
    const action = MessageBranchToNewConversationAction({
      controls: controls({ onBranch }),
      events: [],
      message: assistantMessage,
      run: agentRun("completed"),
    });
    const button = findButton(action);
    const trigger = {} as HTMLButtonElement;

    (
      button.props.onClick as (event: {
        currentTarget: HTMLButtonElement;
      }) => void
    )({ currentTarget: trigger });

    expect(onBranch).toHaveBeenCalledOnce();
    expect(onBranch).toHaveBeenCalledWith(
      {
        conversationId,
        messageId: assistantMessageId,
        role: "assistant",
        runId,
      },
      trigger,
    );
  });

  it("omits standalone messages and rejects mismatched persisted targets", () => {
    expect(
      renderToStaticMarkup(
        <MessageBranchToNewConversationAction
          controls={controls()}
          events={[]}
          message={{ ...userMessage, runId: null }}
          run={null}
        />,
      ),
    ).toBe("");
    expect(() =>
      messageBranchToNewConversationState({
        controls: controls(),
        events: [],
        message: userMessage,
        run: {
          ...agentRun("completed"),
          id: "20000000-0000-4000-8000-000000000002",
        },
      }),
    ).toThrow("与分支目标");
  });

  it("moves the assistant branch action into More while preserving the user action", () => {
    const branchControls = controls();
    const assistantMarkup = renderToStaticMarkup(
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
        branchToNewConversation={branchControls}
        events={[]}
        isFeedbackPending={false}
        message={assistantMessage}
        onFeedback={() => undefined}
        onOpenActivity={() => undefined}
        run={agentRun("completed")}
      />,
    );
    expect(assistantMarkup).not.toContain(
      'aria-label="在新对话中分支"',
    );
    expect(assistantMarkup.indexOf('aria-label="更多回答操作"')).toBeGreaterThan(
      assistantMarkup.indexOf('aria-label="重新生成回答"'),
    );
    expect(assistantMarkup).toContain('aria-haspopup="menu"');
    expect(assistantMarkup).toContain('aria-expanded="false"');

    const userMarkup = renderToStaticMarkup(
      <MessageView
        branchToNewConversation={branchControls}
        events={[]}
        isFeedbackPending={false}
        message={userMessage}
        onFeedback={() => undefined}
        onOpenActivity={() => undefined}
        run={agentRun("completed")}
      />,
    );
    expect(userMarkup).toContain('aria-label="在新对话中分支"');
    expect(userMarkup).not.toContain("message-actions--persistent");
  });
});

describe("message branch source contract", () => {
  it("stays callback-only and does not invent an API client", async () => {
    const actionSource = await readFile(
      path.join(process.cwd(), "components/message-branch-action.tsx"),
      "utf8",
    );
    const messageSource = await readFile(
      path.join(process.cwd(), "components/research-message.tsx"),
      "utf8",
    );

    expect(actionSource).not.toContain("@/components/api-client");
    expect(actionSource).not.toMatch(/\bfetch\s*\(/u);
    expect(actionSource).toContain(
      "controls.onBranch(state.target, event.currentTarget)",
    );
    expect(
      messageSource.match(/<MessageBranchToNewConversationAction/gu),
    ).toHaveLength(1);
    expect(
      messageSource.match(/<AssistantMessageMoreMenu/gu),
    ).toHaveLength(1);
  });
});
