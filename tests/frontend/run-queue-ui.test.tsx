import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationSidebar } from "@/components/conversation-sidebar";
import { DeleteConversationDialog } from "@/components/conversation-mutation-dialogs";
import {
  TerminalRunMessage,
  WaitingRunMessage,
  terminalRunRetryControlState,
} from "@/components/research-message";
import {
  closeRunActivityPanelFromButton,
  closeRunActivityPanelFromBackdrop,
  resolveRunActivityDetailState,
  runActivityPanelIsModal,
  RunActivityPanel,
  RunProcessCard,
} from "@/components/run-activity";
import type {
  AgentRun,
  AgentRunStatus,
  ArtifactSummary,
  ConversationSummary,
  RunEvent,
} from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const conversationId = "10000000-0000-4000-8000-000000000001";

function agentRun(status: AgentRunStatus): AgentRun {
  const terminal =
    status === "failed" ||
    status === "cancelled" ||
    status === "reconciliation_required";
  return {
    id: "20000000-0000-4000-8000-000000000001",
    requestId: "30000000-0000-4000-8000-000000000001",
    conversationId,
    inputMessageId: "40000000-0000-4000-8000-000000000001",
    assistantMessageId: null,
    status,
    conversationTurn: "1",
    attemptIndex: 1,
    predecessorRunId: null,
    retryOfRunId: null,
    regenerateOfRunId: null,
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
    failure: terminal
      ? {
          code: status === "cancelled" ? "RUN_CANCELLED" : "RUN_FAILED",
          message: "供应商暂时不可用",
        }
      : null,
    createdAt: "2026-08-25T08:00:00.000Z",
    startedAt:
      status === "waiting" || status === "queued"
        ? null
        : "2026-08-25T08:00:01.000Z",
    finishedAt: terminal ? "2026-08-25T08:00:05.000Z" : null,
    cancelRequestedAt: null,
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

function findInspectableElement(
  root: unknown,
  predicate: (element: InspectableElement) => boolean,
): InspectableElement {
  if (isInspectableElement(root)) {
    if (predicate(root)) {
      return root;
    }

    return findInspectableElement(root.props.children, predicate);
  }

  if (Array.isArray(root)) {
    for (const child of root) {
      try {
        return findInspectableElement(child, predicate);
      } catch (error) {
        if (!(error instanceof TypeError)) {
          throw error;
        }
      }
    }
  }

  throw new TypeError("Could not find inspectable React element");
}

async function inspectableRunProcessCard(
  onOpenActivity: (runId: string, surface?: "inline" | "panel") => void,
  status: "completed" | "running" = "completed",
): Promise<InspectableElement> {
  vi.resetModules();
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      useEffect: () => undefined,
      useState: (initial: unknown) => [
        typeof initial === "function"
          ? (initial as () => unknown)()
          : initial,
        vi.fn(),
      ],
    };
  });

  try {
    const { RunProcessCard: InspectableRunProcessCard } = await import(
      "@/components/run-activity"
    );
    return InspectableRunProcessCard({
      events: [],
      onOpenActivity,
      run:
        status === "completed"
          ? {
              ...agentRun("completed"),
              finishedAt: "2026-08-25T08:00:05.000Z",
            }
          : agentRun("running"),
    });
  } finally {
    vi.doUnmock("react");
  }
}

type CapturedEffect = () => void | (() => void);

async function capturedRunActivityPanelEffects(input: {
  isNarrowViewport: boolean;
  onClose: () => void;
  returnFocusRef: { current: HTMLButtonElement | null };
}): Promise<{
  effects: CapturedEffect[];
  useModalFocus: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const effects: CapturedEffect[] = [];
  const useModalFocus = vi.fn();

  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      useEffect: (effect: CapturedEffect) => {
        effects.push(effect);
      },
      useLayoutEffect: () => undefined,
      useRef: (initial: unknown) => ({ current: initial }),
      useState: (initial: unknown) => [
        typeof initial === "function"
          ? (initial as () => unknown)()
          : initial,
        vi.fn(),
      ],
      useSyncExternalStore: () => input.isNarrowViewport,
    };
  });
  vi.doMock("@/components/modal-focus", () => ({ useModalFocus }));

  try {
    const { RunActivityPanel: InspectableRunActivityPanel } = await import(
      "@/components/run-activity"
    );
    InspectableRunActivityPanel({
      connectionState: { phase: "idle" },
      detailState: { phase: "ready" },
      events: [],
      isOpen: true,
      onClose: input.onClose,
      onRetryLoad: () => undefined,
      onRetryConnection: () => undefined,
      replayState: "not_loaded",
      returnFocusRef: input.returnFocusRef,
      run: agentRun("waiting"),
    });
    return { effects, useModalFocus };
  } finally {
    vi.doUnmock("react");
    vi.doUnmock("@/components/modal-focus");
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("stopped generation continuation", () => {
  it("shows a stopped run and actionable continuation instead of asking the user to reconcile credits", () => {
    const stoppedRun: AgentRun = {
      ...agentRun("reconciliation_required"),
      cancelRequestedAt: "2026-08-25T08:00:04.000Z",
    };
    const markup = renderToStaticMarkup(
      <TerminalRunMessage
        events={[]}
        onOpenActivity={() => undefined}
        run={stoppedRun}
      />,
    );
    expect(markup).toContain("这次研究已停止");
    expect(markup).toContain("你可以输入“继续”，或直接发送新的要求");
    expect(markup).toContain("费用确认无需你操作");
    expect(markup).not.toContain("待对账");
    expect(markup).not.toContain("核对积分");
    expect(markup).not.toContain("重试这轮研究");
  });
});

function renderTerminal(
  status: "failed" | "cancelled" | "reconciliation_required",
  input: {
    canRetry?: boolean;
    events?: RunEvent[];
    isRetrying?: boolean;
    mutationDisabledReason?: string | null;
  } = {},
): string {
  return renderToStaticMarkup(
    <TerminalRunMessage
      canRetry={input.canRetry}
      events={input.events ?? []}
      isRetrying={input.isRetrying}
      mutationDisabledReason={input.mutationDisabledReason}
      onOpenActivity={() => undefined}
      onRetry={() => undefined}
      run={agentRun(status)}
    />,
  );
}

const conversation: ConversationSummary = {
  id: conversationId,
  title: "德国泵类买家",
  updatedAt: "2026-08-25T08:00:00.000Z",
  pinnedAt: null,
  archivedAt: null,
  selectedRunId: null,
  activeRun: null,
  waitingRunCount: 0,
  attention: null,
};

describe("queued run UI", () => {
  it("labels a persisted queued Run as waiting instead of thinking", () => {
    const markup = renderToStaticMarkup(
      <RunProcessCard
        events={[]}
        onOpenActivity={() => undefined}
        run={agentRun("queued")}
      />,
    );

    expect(markup).toContain("<strong>排队中 · 0 秒</strong>");
    expect(markup).not.toContain("正在思考");
    expect(markup).toContain(
      'aria-label="收起排队中 · 0 秒的思考与工具活动"',
    );
  });

  it("shows a persisted running cancellation as stopping after reload", () => {
    const markup = renderToStaticMarkup(
      <RunProcessCard
        events={[]}
        onOpenActivity={() => undefined}
        run={{
          ...agentRun("running"),
          cancelRequestedAt: "2026-08-25T08:00:03.000Z",
        }}
      />,
    );

    expect(markup).toContain(
      'aria-label="收起正在停止 · 0 秒的思考与工具活动"',
    );
    expect(markup).toContain("<strong>正在停止 · 0 秒</strong>");
    expect(markup).toContain("<details");
    expect(markup).toContain("思考与工具活动");
    expect(markup).toContain("分析、搜索和工具活动会实时显示在这里");
  });

  it("renders a cancellable waiting message without invented activity", () => {
    const markup = renderToStaticMarkup(
      <WaitingRunMessage
        isBlocked={false}
        isCancelling={false}
        onCancel={() => undefined}
        run={agentRun("waiting")}
      />,
    );

    expect(markup).toContain("已加入队列");
    expect(markup).toContain("等待前一轮成功完成。");
    expect(openingTag(markup, 'aria-label="取消等待中的研究"')).not.toContain(
      "disabled",
    );
    expect(markup).not.toContain("查看完整活动");
    expect(markup).not.toContain("项活动");
  });

  it("shows a blocked queue and disables only its pending cancel action", () => {
    const markup = renderToStaticMarkup(
      <WaitingRunMessage
        isBlocked
        isCancelling
        onCancel={() => undefined}
        run={agentRun("waiting")}
      />,
    );

    expect(markup).toContain("队列已暂停");
    expect(markup).toContain("请重试前一轮或取消。");
    expect(
      openingTag(markup, 'aria-label="正在取消等待中的研究"'),
    ).toContain("disabled");
  });

  it("keeps waiting process cards static and without an activity entry", () => {
    const markup = renderToStaticMarkup(
      <RunProcessCard
        events={[]}
        onOpenActivity={() => undefined}
        run={agentRun("waiting")}
      />,
    );

    expect(markup).toContain("等待中");
    expect(markup).toContain("尚未开始运行");
    expect(markup).not.toContain("查看完整活动");
    expect(markup).not.toContain("项活动");
  });

  it("keeps completed inline activity collapsed until requested", () => {
    const markup = renderToStaticMarkup(
      <RunProcessCard
        events={[]}
        onOpenActivity={() => undefined}
        run={{
          ...agentRun("completed"),
          finishedAt: "2026-08-25T08:00:05.000Z",
        }}
      />,
    );

    expect(markup).toContain("<details");
    expect(markup).toContain("<strong>思考了 4 秒</strong>");
    expect(markup).toContain("尚无可展示活动");
    expect(
      openingTag(
        markup,
        'aria-label="展开思考了 4 秒的思考与工具活动"',
      ),
    ).not.toContain("aria-controls");
    expect(markup).not.toContain("activity-timeline");
  });

  it("requests persisted activity when the inline disclosure opens", async () => {
    const onOpenActivity = vi.fn();
    const card = await inspectableRunProcessCard(onOpenActivity);
    const disclosure = findInspectableElement(
      card,
      (element) =>
        element.type === "details" &&
        element.props.className === "run-process-card__disclosure",
    );
    const onToggle = disclosure.props.onToggle as (event: {
      currentTarget: { open: boolean };
    }) => void;

    onToggle({ currentTarget: { open: true } });

    expect(onOpenActivity).toHaveBeenCalledOnce();
    expect(onOpenActivity).toHaveBeenCalledWith(
      "20000000-0000-4000-8000-000000000001",
      "inline",
    );
  });

  it("opens the full activity panel from the expanded inline activity", async () => {
    const onOpenActivity = vi.fn();
    const card = await inspectableRunProcessCard(onOpenActivity, "running");
    const openPanelButton = findInspectableElement(
      card,
      (element) =>
        element.type === "button" &&
        element.props.className === "run-process-card__open-panel",
    );
    const onClick = openPanelButton.props.onClick as () => void;

    onClick();

    expect(onOpenActivity).toHaveBeenCalledOnce();
    expect(onOpenActivity).toHaveBeenCalledWith(
      "20000000-0000-4000-8000-000000000001",
      "panel",
    );
  });

  it.each([
    [
      { phase: "connecting", mode: "replay_once" } as const,
      null,
    ],
    [
      { phase: "connected", mode: "replay_once" } as const,
      null,
    ],
    [
      {
        phase: "reconnecting",
        mode: "replay_once",
        attempt: 1,
        retryDelayMs: 800,
      } as const,
      "活动载入中断，正在第 1 次重连",
    ],
    [
      {
        phase: "failed",
        mode: "replay_once",
        message: "连接已断开",
      } as const,
      "运行活动载入失败",
    ],
  ])("keeps only actionable connection state in the compact entry", (
    connectionState,
    expectedMessage,
  ) => {
    const markup = renderToStaticMarkup(
      <RunProcessCard
        connectionState={connectionState}
        events={[]}
        onOpenActivity={() => undefined}
        run={{
          ...agentRun("completed"),
          finishedAt: "2026-08-25T08:00:05.000Z",
        }}
      />,
    );

    if (expectedMessage === null) {
      expect(markup).not.toContain("run-process-card__connection");
    } else {
      expect(markup).toContain(expectedMessage);
    }
    expect(markup).toContain("尚无可展示活动");
  });

  it("summarizes completed activity while its inline disclosure is collapsed", () => {
    const completedRun = {
      ...agentRun("completed"),
      finishedAt: "2026-08-25T08:00:08.000Z",
    };
    const events: RunEvent[] = [
      {
        id: "1",
        runId: completedRun.id,
        createdAt: "2026-08-25T08:00:01.000Z",
        payload: {
          type: "status",
          phase: "thinking",
          message: "普通运行状态不应进入正文活动摘要",
        },
      },
      {
        id: "2",
        runId: completedRun.id,
        createdAt: "2026-08-25T08:00:02.000Z",
        payload: {
          type: "reasoning",
          itemId: "reasoning-1",
          summaryIndex: 0,
          providerSequence: 1,
          text: "比较目标市场与采购角色。\n核验真实公司主体。\n正文不应内联显示。",
        },
      },
      {
        id: "3",
        runId: completedRun.id,
        createdAt: "2026-08-25T08:00:03.000Z",
        payload: {
          type: "web_search",
          callId: "search-1",
          phase: "completed",
          outputIndex: 0,
          providerSequence: 2,
          action: {
            type: "search",
            query: "German pump distributors",
            queries: ["German pump distributors"],
            sources: [
              { type: "url", url: "https://example.com/buyers" },
              { type: "url", url: "https://www.example.com/about" },
              { type: "url", url: "https://buyers.test/directory" },
              { type: "url", url: "https://trade.test/pumps" },
              { type: "url", url: "https://hidden.test/results" },
            ],
          },
        },
      },
      {
        id: "4",
        runId: completedRun.id,
        createdAt: "2026-08-25T08:00:04.000Z",
        payload: {
          type: "tool_started",
          callId: "tool-1",
          toolName: "save_research_results",
          title: "保存结构化买家清单",
          input: '{"companies":2}',
        },
      },
      {
        id: "5",
        runId: completedRun.id,
        createdAt: "2026-08-25T08:00:05.000Z",
        payload: {
          type: "tool_completed",
          callId: "tool-1",
          toolName: "save_research_results",
          title: "结构化买家清单已保存",
          output: '{"companyCount":2}',
        },
      },
      {
        id: "6",
        runId: completedRun.id,
        createdAt: "2026-08-25T08:00:06.000Z",
        payload: { type: "delta", text: "正文增量不应进入活动摘要" },
      },
      {
        id: "7",
        runId: completedRun.id,
        createdAt: "2026-08-25T08:00:07.000Z",
        payload: {
          type: "done",
          message: {
            id: "70000000-0000-4000-8000-000000000001",
            runId: completedRun.id,
            role: "assistant",
            content: "研究回答",
            citations: [],
            artifacts: [],
            attachments: [],
            feedback: null,
            createdAt: "2026-08-25T08:00:07.000Z",
          },
          credits: { available: 900, reserved: 0 },
        },
      },
    ];
    const markup = renderToStaticMarkup(
      <RunProcessCard
        events={events}
        onOpenActivity={() => undefined}
        run={completedRun}
      />,
    );

    expect(markup).toContain(
      "1 项网页活动 · 1 次工具调用 · 1 条分析摘要",
    );
    expect(markup).toContain("<strong>思考了 7 秒</strong>");
    expect(markup).not.toContain("比较目标市场与采购角色。");
    expect(markup).not.toContain("核验真实公司主体。");
    expect(markup).not.toContain("正文不应内联显示。");
    expect(markup).not.toContain("German pump distributors");
    expect(markup).not.toContain("{&quot;companies&quot;:2}");
    expect(markup).not.toContain("{&quot;companyCount&quot;:2}");
    expect(markup).not.toContain("普通运行状态不应进入正文活动摘要");
    expect(markup).not.toContain("正文增量不应进入活动摘要");
    expect(markup).not.toContain("研究回答已完成");
    expect(markup).not.toContain("activity-event");
    expect(markup).not.toContain("activity-timeline");
  });

  it("shows only the latest four analysis and tool items inline", () => {
    const runningRun = agentRun("running");
    const events: RunEvent[] = Array.from({ length: 5 }, (_, index) => ({
      id: String(index + 1),
      runId: runningRun.id,
      createdAt: `2026-08-25T08:00:0${index + 1}.000Z`,
      payload: {
        type: "reasoning" as const,
        itemId: `reasoning-${index + 1}`,
        summaryIndex: 0,
        providerSequence: index + 1,
        text: `活动摘要 ${index + 1}`,
      },
    }));
    const markup = renderToStaticMarkup(
      <RunProcessCard
        events={events}
        onOpenActivity={() => undefined}
        run={runningRun}
      />,
    );

    expect(markup).toContain("5 条分析摘要");
    expect(markup).toContain("activity-timeline");
    expect(markup).not.toContain("活动摘要 1");
    expect(markup).toContain("活动摘要 2");
    expect(markup).toContain("活动摘要 5");
    expect(markup).toContain('aria-controls="run-activity-panel"');
    expect(markup).toContain('aria-expanded="false"');

    const openMarkup = renderToStaticMarkup(
      <RunProcessCard
        events={events}
        isActivityPanelOpen
        onOpenActivity={() => undefined}
        run={runningRun}
      />,
    );
    expect(openMarkup).toContain('aria-expanded="true"');
  });

  it("renders a dedicated waiting activity blank state", () => {
    const markup = renderToStaticMarkup(
      <RunActivityPanel
        connectionState={{ phase: "idle" }}
        detailState={{ phase: "ready" }}
        events={[]}
        isOpen
        onClose={() => undefined}
        onRetryLoad={() => undefined}
        onRetryConnection={() => undefined}
        replayState="not_loaded"
        run={agentRun("waiting")}
      />,
    );

    expect(markup).toContain("尚未开始运行");
    expect(markup).toContain(
      "这轮研究正在等待前一轮完成，目前没有可展示的活动。",
    );
    expect(markup).not.toContain("项活动");
    expect(markup).not.toContain("activity-timeline");
  });

  it("distinguishes a cross-conversation activity load from an empty activity", () => {
    expect(
      resolveRunActivityDetailState({
        requestedRunId: agentRun("running").id,
        run: null,
        conversationState: undefined,
      }),
    ).toEqual({ phase: "loading" });

    const markup = renderToStaticMarkup(
      <RunActivityPanel
        connectionState={{ phase: "idle" }}
        detailState={{ phase: "loading" }}
        events={[]}
        isOpen
        onClose={() => undefined}
        onRetryConnection={() => undefined}
        onRetryLoad={() => undefined}
        replayState="not_loaded"
        run={null}
      />,
    );

    expect(markup).toContain("正在载入运行活动");
    expect(markup).toContain("正在打开目标对话并读取这次运行的活动记录。");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("还没有运行活动");
  });

  it("shows an exact conversation-load failure with an explicit retry", () => {
    const detailState = resolveRunActivityDetailState({
      requestedRunId: agentRun("running").id,
      run: null,
      conversationState: {
        isLoaded: false,
        isLoading: false,
        loadError: "服务暂时无法完成这个请求，请稍后重试。",
      },
    });
    expect(detailState).toEqual({
      phase: "failed",
      message: "服务暂时无法完成这个请求，请稍后重试。",
    });

    const markup = renderToStaticMarkup(
      <RunActivityPanel
        connectionState={{ phase: "idle" }}
        detailState={detailState}
        events={[]}
        isOpen
        onClose={() => undefined}
        onRetryConnection={() => undefined}
        onRetryLoad={() => undefined}
        replayState="not_loaded"
        run={null}
      />,
    );

    expect(markup).toContain("暂时无法载入运行活动");
    expect(markup).toContain("服务暂时无法完成这个请求，请稍后重试。");
    expect(markup).toContain("重新载入");
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("还没有运行活动");
  });

  it("reports a loaded conversation that lacks the requested Run as a load failure", () => {
    expect(
      resolveRunActivityDetailState({
        requestedRunId: agentRun("running").id,
        run: null,
        conversationState: {
          isLoaded: true,
          isLoading: false,
          loadError: null,
        },
      }),
    ).toEqual({
      phase: "failed",
      message: "已载入对话，但没有找到指定的运行活动。请重新载入。",
    });
  });

  it("combines run status, duration, and activity count in the panel header", () => {
    const runningRun = agentRun("running");
    const markup = renderToStaticMarkup(
      <RunActivityPanel
        connectionState={{ phase: "connected", mode: "follow" }}
        detailState={{ phase: "ready" }}
        events={[
          {
            id: "1",
            runId: runningRun.id,
            createdAt: "2026-08-25T08:00:02.000Z",
            payload: {
              type: "reasoning",
              itemId: "reasoning-1",
              summaryIndex: 0,
              providerSequence: 1,
              text: "核验目标客户",
            },
          },
        ]}
        isOpen
        onClose={() => undefined}
        onRetryLoad={() => undefined}
        onRetryConnection={() => undefined}
        replayState="loaded"
        run={runningRun}
      />,
    );

    expect(markup).toContain("研究中 · 0 秒 · 1 项活动");
    expect(markup).not.toContain("activity-panel__summary");
    expect(markup).not.toContain("activity-panel__connection");
    expect(markup).toContain(
      '<details class="activity-panel__notice"><summary><span>关于活动与思考过程</span>',
    );
  });

  it("uses modal semantics only for an open narrow activity panel", () => {
    expect(runActivityPanelIsModal(true, true)).toBe(true);
    expect(runActivityPanelIsModal(true, false)).toBe(false);
    expect(runActivityPanelIsModal(false, true)).toBe(false);
    expect(runActivityPanelIsModal(false, false)).toBe(false);
  });

  it("lets only the desktop non-modal panel handle Escape and restores its trigger", async () => {
    const documentListeners = new Map<
      string,
      (event: KeyboardEvent) => void
    >();
    const removeEventListener = vi.fn();
    const returnFocus = vi.fn();
    const onClose = vi.fn();
    vi.stubGlobal("document", {
      addEventListener: (
        name: string,
        listener: (event: KeyboardEvent) => void,
      ) => documentListeners.set(name, listener),
      removeEventListener,
    });
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    const desktop = await capturedRunActivityPanelEffects({
      isNarrowViewport: false,
      onClose,
      returnFocusRef: {
        current: { focus: returnFocus } as unknown as HTMLButtonElement,
      },
    });
    const desktopCleanups = desktop.effects.flatMap((effect) => {
      const cleanup = effect();
      return typeof cleanup === "function" ? [cleanup] : [];
    });
    const handleDesktopKeyDown = documentListeners.get("keydown");
    const preventDefault = vi.fn();

    expect(desktop.useModalFocus).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(handleDesktopKeyDown).toBeDefined();
    handleDesktopKeyDown?.({
      defaultPrevented: false,
      key: "Enter",
      preventDefault,
    } as unknown as KeyboardEvent);
    expect(onClose).not.toHaveBeenCalled();

    handleDesktopKeyDown?.({
      defaultPrevented: false,
      key: "Escape",
      preventDefault,
    } as unknown as KeyboardEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(returnFocus).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(returnFocus).toHaveBeenCalledOnce();

    desktopCleanups.forEach((cleanup) => cleanup());
    expect(removeEventListener).toHaveBeenCalledWith(
      "keydown",
      handleDesktopKeyDown,
    );

    documentListeners.clear();
    const narrow = await capturedRunActivityPanelEffects({
      isNarrowViewport: true,
      onClose,
      returnFocusRef: { current: null },
    });
    narrow.effects.forEach((effect) => effect());

    expect(narrow.useModalFocus).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(documentListeners.has("keydown")).toBe(false);
  });

  it("keeps the server-rendered desktop panel complementary and its backdrop inert", () => {
    const markup = renderToStaticMarkup(
      <RunActivityPanel
        connectionState={{ phase: "idle" }}
        detailState={{ phase: "ready" }}
        events={[]}
        isOpen
        onClose={() => undefined}
        onRetryLoad={() => undefined}
        onRetryConnection={() => undefined}
        replayState="not_loaded"
        run={agentRun("waiting")}
      />,
    );
    const backdropTag = openingTag(markup, 'class="activity-backdrop"');
    const panelTag = openingTag(markup, 'aria-label="运行活动"');

    expect(backdropTag).toMatch(/^<div /u);
    expect(backdropTag).toContain('aria-hidden="true"');
    expect(backdropTag).not.toContain("tabindex");
    expect(backdropTag).not.toContain("aria-label");
    expect(panelTag).toMatch(/^<aside /u);
    expect(panelTag).not.toContain('role="dialog"');
    expect(panelTag).not.toContain("aria-modal");
  });

  it("keeps the closed activity panel and backdrop out of keyboard navigation", () => {
    const markup = renderToStaticMarkup(
      <RunActivityPanel
        connectionState={{ phase: "idle" }}
        detailState={{ phase: "ready" }}
        events={[]}
        isOpen={false}
        onClose={() => undefined}
        onRetryLoad={() => undefined}
        onRetryConnection={() => undefined}
        replayState="not_loaded"
        run={agentRun("waiting")}
      />,
    );
    const backdropTag = openingTag(markup, 'class="activity-backdrop"');
    const panelTag = openingTag(markup, 'aria-label="运行活动"');

    expect(backdropTag).toContain('aria-hidden="true"');
    expect(backdropTag).not.toContain("tabindex");
    expect(panelTag).toContain('aria-hidden="true"');
    expect(panelTag).toContain("inert");
  });

  it("prevents backdrop focus loss before closing the activity modal", () => {
    const backdrop = {} as EventTarget & HTMLDivElement;
    const preventDefault = vi.fn();
    const onClose = vi.fn();

    closeRunActivityPanelFromBackdrop(
      { currentTarget: backdrop, preventDefault, target: backdrop },
      onClose,
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores the activity trigger after the desktop close button closes", async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => order.push("close"));
    const focus = vi.fn(() => order.push("focus"));

    closeRunActivityPanelFromButton(false, onClose, { focus });

    expect(onClose).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(focus).toHaveBeenCalledOnce();
    expect(order).toEqual(["close", "focus"]);
  });

  it("ignores activity backdrop events that originate inside another target", () => {
    const preventDefault = vi.fn();
    const onClose = vi.fn();

    closeRunActivityPanelFromBackdrop(
      {
        currentTarget: {} as EventTarget & HTMLDivElement,
        preventDefault,
        target: {} as EventTarget,
      },
      onClose,
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a reconnecting page transport without claiming the Agent stopped", () => {
    const markup = renderToStaticMarkup(
      <RunProcessCard
        connectionState={{
          phase: "reconnecting",
          mode: "follow",
          attempt: 2,
          retryDelayMs: 1_600,
        }}
        events={[]}
        onOpenActivity={() => undefined}
        run={agentRun("running")}
      />,
    );

    expect(markup).toContain("活动连接中断，正在第 2 次重连");
    expect(markup).toContain("页面断线不等于 Agent 停止");
    expect(markup).toContain('role="status"');
  });

  it("offers an explicit retry after a permanent activity connection failure", () => {
    const markup = renderToStaticMarkup(
      <RunActivityPanel
        connectionState={{
          phase: "failed",
          mode: "follow",
          message: "事件契约无效",
        }}
        detailState={{ phase: "ready" }}
        events={[]}
        isOpen
        onClose={() => undefined}
        onRetryLoad={() => undefined}
        onRetryConnection={() => undefined}
        replayState="failed"
        run={agentRun("running")}
      />,
    );

    expect(markup).toContain("实时活动连接失败");
    expect(markup).toContain("Agent 是否仍在运行以运行状态为准");
    expect(markup).toContain("重试连接");
    expect(markup).toContain('role="alert"');
  });

  it("shows waiting status in the conversation sidebar", () => {
    const markup = renderToStaticMarkup(
      <ConversationSidebar
        activeConversationId={null}
        busyConversationIds={new Set()}
        conversations={[{ ...conversation, waitingRunCount: 1 }]}
        conversationBrowserView={null}
        credits={{ available: 1000, reserved: 0 }}
        isCreating={false}
        isLibraryActive={false}
        isLoadingMore={false}
        isOpen
        loadMoreError={null}
        nextCursor={null}
        onArchiveAllConversations={async () => ({
          conversationCount: 0,
          error: null,
        })}
        onClose={() => undefined}
        onCreate={() => undefined}
        onDeleteAllConversations={async () => ({
          conversationCount: 0,
          error: null,
        })}
        onLoadMore={() => undefined}
        onOpenArchived={() => undefined}
        onOpenKeyboardShortcuts={() => undefined}
        onOpenLibrary={() => undefined}
        onOpenSearch={() => undefined}
        onRequestDelete={() => undefined}
        onRequestRename={() => undefined}
        onRequestShare={() => undefined}
        onSelect={() => undefined}
        onSetArchived={async () => undefined}
        onSetPinned={async () => undefined}
        runStatusByConversation={{ [conversationId]: "waiting" }}
        user={{
          id: "50000000-0000-4000-8000-000000000001",
          name: "测试用户",
        }}
      />,
    );

    expect(markup).toContain("conversation-run-status--waiting");
    expect(markup).toContain("队列已暂停");
  });

  it("protects deletion from a paused waiting count without loading runs", () => {
    const pausedConversation = { ...conversation, waitingRunCount: 1 };
    const markup = renderToStaticMarkup(
      <DeleteConversationDialog
        conversation={pausedConversation}
        isBusy={false}
        onClose={() => undefined}
        onDelete={async () => null}
      />,
    );

    expect(markup).toContain(
      "该对话仍有正在运行或等待中的研究，请先停止或取消后再归档或删除。",
    );
    expect(openingTag(markup, "conversation-dialog-button--danger")).toContain(
      "disabled",
    );
  });
});

describe("terminal run retry UI", () => {
  it("keeps streamed text and artifacts after a run stops", () => {
    const artifact: ArtifactSummary = {
      id: "60000000-0000-4000-8000-000000000001",
      name: "partial-buyers.csv",
      mimeType: "text/csv",
      sizeBytes: 128,
      downloadUrl:
        "/api/artifacts/60000000-0000-4000-8000-000000000001/download",
      createdAt: "2026-08-25T08:00:04.000Z",
    };
    const terminalRun = agentRun("cancelled");
    const events: RunEvent[] = [
      {
        id: "1",
        runId: terminalRun.id,
        createdAt: "2026-08-25T08:00:02.000Z",
        payload: { type: "delta", text: "已找到两家德国泵类买家。" },
      },
      {
        id: "2",
        runId: terminalRun.id,
        createdAt: "2026-08-25T08:00:04.000Z",
        payload: { type: "artifact", artifact },
      },
    ];
    const markup = renderTerminal("cancelled", { events });
    const articleTag = openingTag(markup, 'class="message message--assistant"');

    expect(markup).toContain("回答未完成 · 以下为已生成的部分内容");
    expect(markup).toContain("已找到两家德国泵类买家。");
    expect(markup).toContain("partial-buyers.csv");
    expect(markup).toContain('aria-label="复制消息"');
    expect(markup).toContain("message-actions--persistent");
    expect(markup).toContain('class="terminal-run-notice terminal-run-notice--cancelled" role="status"');
    expect(articleTag).not.toContain("aria-live");
  });

  it("does not invent a partial-answer section without deltas or artifacts", () => {
    const markup = renderTerminal("failed");

    expect(markup).not.toContain("回答未完成 · 以下为已生成的部分内容");
  });

  it("never renders backend or provider failure details", () => {
    const sensitiveDetails =
      "SELECT * FROM secrets at https://provider.internal.example/v1/responses";
    const run = {
      ...agentRun("failed"),
      failure: { code: "PROVIDER_ERROR", message: sensitiveDetails },
    };
    const markup = renderToStaticMarkup(
      <TerminalRunMessage
        events={[
          {
            id: "1",
            runId: run.id,
            createdAt: "2026-08-25T08:00:04.000Z",
            payload: {
              type: "error",
              error: {
                code: "PROVIDER_ERROR",
                message: sensitiveDetails,
                runId: run.id,
              },
            },
          },
        ]}
        onOpenActivity={() => undefined}
        run={run}
      />,
    );

    expect(markup).toContain("运行未能完成，请稍后重试。");
    expect(markup).not.toContain("provider.internal.example");
    expect(markup).not.toContain("SELECT * FROM secrets");
  });

  it("does not call retained reconciliation content incomplete", () => {
    const reconciliationRun = agentRun("reconciliation_required");
    const markup = renderTerminal("reconciliation_required", {
      events: [
        {
          id: "1",
          runId: reconciliationRun.id,
          createdAt: "2026-08-25T08:00:02.000Z",
          payload: { type: "delta", text: "完整生成内容" },
        },
      ],
    });

    expect(markup).toContain("已保留生成内容 · 这次研究仍需核对积分");
    expect(markup).not.toContain("回答未完成");
  });

  it.each(["failed", "cancelled"] as const)(
    "offers retry for a retryable %s run",
    (status) => {
      const markup = renderTerminal(status, { canRetry: true });

      expect(markup).toContain('aria-label="重试这轮研究"');
      expect(openingTag(markup, 'aria-label="重试这轮研究"')).not.toContain(
        "disabled",
      );
    },
  );

  it("disables only retry while a retry request is pending", () => {
    const markup = renderTerminal("failed", {
      canRetry: true,
      isRetrying: true,
    });

    expect(openingTag(markup, 'aria-label="正在重试这轮研究"')).toContain(
      "disabled",
    );
    expect(markup).toContain("正在重试…");
  });

  it("keeps retry visible but disabled with a reason during another conversation mutation", () => {
    const mutationDisabledReason = "该对话正在处理其他操作，请稍候。";
    const ariaLabel = `重试这轮研究不可用：${mutationDisabledReason}`;
    const markup = renderTerminal("failed", {
      canRetry: true,
      mutationDisabledReason,
    });

    expect(openingTag(markup, `aria-label="${ariaLabel}"`)).toContain(
      "disabled",
    );
    expect(openingTag(markup, `aria-label="${ariaLabel}"`)).toContain(
      `title="${mutationDisabledReason}"`,
    );
    expect(markup).toContain("重试这轮研究");
  });

  it("never offers retry for reconciliation-required runs", () => {
    const markup = renderTerminal("reconciliation_required", {
      canRetry: true,
      isRetrying: true,
    });

    expect(markup).not.toContain("重试这轮研究");
    expect(markup).not.toContain("正在重试");
  });

  it("derives retry controls from the terminal status without fallback", () => {
    expect(
      terminalRunRetryControlState({
        status: "cancelled",
        canRetry: true,
        isRetrying: true,
      }),
    ).toMatchObject({
      showRetry: true,
      retryDisabled: true,
      label: "正在重试…",
    });
    expect(
      terminalRunRetryControlState({
        status: "reconciliation_required",
        canRetry: true,
        isRetrying: true,
      }),
    ).toMatchObject({
      showRetry: false,
      retryDisabled: false,
    });
  });
});
