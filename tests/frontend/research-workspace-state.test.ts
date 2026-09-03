import { describe, expect, it } from "vitest";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

import { buildActivityItems } from "@/components/run-activity";
import {
  activityRunForSelection,
  advanceConversationRefreshFence,
  canRetryRun,
  claimConversationMutationOwner,
  conversationLoadInvalidatedMessage,
  conversationLoadFenceStatus,
  conversationRefreshIsCurrent,
  conversationSummaryRequiresDetailRefresh,
  conversationSummaryAtReadWatermark,
  conversationStateHasOutstandingRuns,
  conversationStateShowsTerminalResult,
  conversationStateReducer,
  createConversationViewState,
  effectiveRunStatus,
  eventsForRun,
  followSupersededConversationLoad,
  loadedRunSubscriptionRequests,
  projectLoadedConversationTimeline,
  projectConversationTimeline,
  refreshIncompatibleBootstrapConversationDetails,
  releaseConversationMutationOwner,
  runCancellationIsPending,
  runForMessage,
  runEventSubscriptionMode,
  selectedConversationAttemptIndex,
  shouldCommitCancelRunResponse,
  shouldCommitTerminalCredits,
  shouldMarkConversationRead,
  shouldRetryConversationLoad,
  shouldSubscribeToRun,
  statusEventAdvancesConversationObservation,
  terminalRunsWithoutAssistantMessages,
  textForRun,
  visibleConversationDetailRefreshIsCurrent,
  waitingRunIsBlocked,
  type ConversationLoadResult,
  type ConversationStateMap,
} from "@/components/research-workspace-state";
import type {
  AgentRun,
  ChatMessage,
  ChatStartResponse,
  ConversationResponse,
  ConversationSummary,
  RunEvent,
} from "@/lib/contracts";

const conversationA = "10000000-0000-4000-8000-000000000001";
const conversationB = "10000000-0000-4000-8000-000000000002";
const runA = "20000000-0000-4000-8000-000000000001";
const runB = "20000000-0000-4000-8000-000000000002";

describe("cancel Run response observation fence", () => {
  it("commits only at the observation revision captured before the request", () => {
    expect(
      shouldCommitCancelRunResponse({
        observationRevisionAtRequestStart: 0,
        currentObservationRevision: 0,
      }),
    ).toBe(true);
    expect(
      shouldCommitCancelRunResponse({
        observationRevisionAtRequestStart: 7,
        currentObservationRevision: 7,
      }),
    ).toBe(true);
  });

  it("rejects a response after any newer status or terminal observation", () => {
    expect(
      shouldCommitCancelRunResponse({
        observationRevisionAtRequestStart: 4,
        currentObservationRevision: 5,
      }),
    ).toBe(false);
    expect(
      shouldCommitCancelRunResponse({
        observationRevisionAtRequestStart: 9,
        currentObservationRevision: 11,
      }),
    ).toBe(false);
  });

  it("lets only the first of two responses from one revision commit", () => {
    const observationRevisionAtRequestStart = 12;
    expect(
      shouldCommitCancelRunResponse({
        observationRevisionAtRequestStart,
        currentObservationRevision: 12,
      }),
    ).toBe(true);
    expect(
      shouldCommitCancelRunResponse({
        observationRevisionAtRequestStart,
        currentObservationRevision: 13,
      }),
    ).toBe(false);
  });
});

describe("persisted Run cancellation presentation", () => {
  it("merges the local request window with the persisted timestamp", () => {
    const running = run(runA, conversationA);
    const persisted = {
      ...running,
      cancelRequestedAt: "2026-08-27T08:00:30.000Z",
    };

    expect(runCancellationIsPending(running, true)).toBe(true);
    expect(runCancellationIsPending(persisted, false)).toBe(true);
    expect(runCancellationIsPending(running, false)).toBe(false);
    expect(
      runCancellationIsPending(
        { ...persisted, status: "completed" },
        false,
      ),
    ).toBe(false);
  });
});

describe("conversation load request fence", () => {
  it("accepts only the latest request identity at the requested observation revision", () => {
    const supersededRequest = {};
    const latestRequest = {};

    expect(
      conversationLoadFenceStatus({
        candidateRequest: supersededRequest,
        currentRequest: latestRequest,
        currentObservationRevision: 2,
        requestedObservationRevision: 2,
      }),
    ).toBe("superseded");
    expect(
      conversationLoadFenceStatus({
        candidateRequest: latestRequest,
        currentRequest: latestRequest,
        currentObservationRevision: 2,
        requestedObservationRevision: 2,
      }),
    ).toBe("current");
    expect(
      conversationLoadFenceStatus({
        candidateRequest: latestRequest,
        currentRequest: undefined,
        currentObservationRevision: 2,
        requestedObservationRevision: 2,
      }),
    ).toBe("superseded");
    expect(
      conversationLoadFenceStatus({
        candidateRequest: latestRequest,
        currentRequest: latestRequest,
        currentObservationRevision: 3,
        requestedObservationRevision: 2,
      }),
    ).toBe("revision_changed");
  });

  it("rejects an old running detail after a background terminal observation", () => {
    const request = {};
    const runningRun = run(runA, conversationA);
    let states = conversationStateReducer({}, {
      type: "load_succeeded",
      conversationId: conversationA,
      detail: {
        conversation: conversationSummary({
          activeRun: {
            id: runA,
            status: "running",
            startedAt: runningRun.startedAt,
          },
        }),
        messages: [],
        runs: [runningRun],
      },
      feedbackDataRevision: 1,
    });
    states = conversationStateReducer(states, {
      type: "run_updated",
      conversationId: conversationA,
      run: { ...runningRun, status: "completed" },
    });

    expect(
      conversationLoadFenceStatus({
        candidateRequest: request,
        currentRequest: request,
        currentObservationRevision: 1,
        requestedObservationRevision: 0,
      }),
    ).toBe("revision_changed");
    expect(states[conversationA].runs[0].status).toBe("completed");
  });

  it("does not let an old detail summary resurrect the observed terminal activeRun", () => {
    const request = {};
    const observedSummary = conversationSummary({ activeRun: null });
    const staleDetailSummary = conversationSummary({
      activeRun: {
        id: runA,
        status: "running",
        startedAt: "2026-08-24T08:00:01.000Z",
      },
    });
    let committedSummary = observedSummary;

    if (
      conversationLoadFenceStatus({
        candidateRequest: request,
        currentRequest: request,
        currentObservationRevision: 8,
        requestedObservationRevision: 7,
      }) === "current"
    ) {
      committedSummary = staleDetailSummary;
    }

    expect(committedSummary.activeRun).toBeNull();
  });

  it("allows a detail load started after the latest observation to commit", () => {
    const request = {};
    const detailRun = {
      ...run(runA, conversationA),
      status: "completed" as const,
      finishedAt: "2026-08-24T08:00:05.000Z",
    };
    const detail: ConversationResponse = {
      conversation: conversationSummary({ activeRun: null }),
      messages: [],
      runs: [detailRun],
    };

    expect(
      conversationLoadFenceStatus({
        candidateRequest: request,
        currentRequest: request,
        currentObservationRevision: 9,
        requestedObservationRevision: 9,
      }),
    ).toBe("current");
    const states = conversationStateReducer({}, {
      type: "load_succeeded",
      conversationId: conversationA,
      detail,
      feedbackDataRevision: 1,
    });
    expect(states[conversationA].runs).toEqual([detailRun]);
  });

  it("keeps the detail revision current for a running Run's ordinary status", () => {
    expect(
      statusEventAdvancesConversationObservation({
        runId: runA,
        backgroundRunStatus: "running",
        conversation: conversationSummary({
          activeRun: {
            id: runA,
            status: "running",
            startedAt: "2026-08-24T08:00:01.000Z",
          },
        }),
      }),
    ).toBe(false);
    expect(
      conversationLoadFenceStatus({
        candidateRequest: "detail",
        currentRequest: "detail",
        currentObservationRevision: 4,
        requestedObservationRevision: 4,
      }),
    ).toBe("current");
  });

  it("invalidates an older detail when status advances queued to running", () => {
    expect(
      statusEventAdvancesConversationObservation({
        runId: runA,
        backgroundRunStatus: "queued",
        conversation: conversationSummary({
          activeRun: {
            id: runA,
            status: "queued",
            startedAt: null,
          },
        }),
      }),
    ).toBe(true);
    expect(
      conversationLoadFenceStatus({
        candidateRequest: "detail",
        currentRequest: "detail",
        currentObservationRevision: 5,
        requestedObservationRevision: 4,
      }),
    ).toBe("revision_changed");
  });

  it("invalidates an older detail for every live terminal observation", () => {
    expect(
      conversationLoadFenceStatus({
        candidateRequest: "detail",
        currentRequest: "detail",
        currentObservationRevision: 6,
        requestedObservationRevision: 5,
      }),
    ).toBe("revision_changed");
  });

  it("follows the latest successful load when an older load settles as superseded", async () => {
    let settleOlder: ((status: { status: "superseded" }) => void) | undefined;
    let settleLatest:
      | ((status: { status: "loaded"; detail: ConversationResponse }) => void)
      | undefined;
    const olderLoad = new Promise<{ status: "superseded" }>((resolve) => {
      settleOlder = resolve;
    });
    const detail: ConversationResponse = {
      conversation: {
        id: conversationA,
        title: "德国买家",
        updatedAt: "2026-08-24T08:01:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        selectedRunId: null,
        activeRun: null,
        waitingRunCount: 0,
        attention: null,
      },
      messages: [],
      runs: [],
    };
    const latestLoad = new Promise<{
      status: "loaded";
      detail: ConversationResponse;
    }>((resolve) => {
      settleLatest = resolve;
    });
    const followed = followSupersededConversationLoad(
      olderLoad,
      () => latestLoad,
    );

    settleLatest?.({ status: "loaded", detail });
    settleOlder?.({ status: "superseded" });

    await expect(followed).resolves.toEqual({ status: "loaded", detail });
  });
});

describe("conversation mutation ownership", () => {
  it("lets an older submission release only its own owner token", () => {
    const owners = new Map<string, object>();
    const olderOwner = {};
    const latestOwner = {};

    expect(
      claimConversationMutationOwner(owners, conversationA, olderOwner),
    ).toBe(true);
    expect(
      claimConversationMutationOwner(owners, conversationA, latestOwner),
    ).toBe(false);

    owners.set(conversationA, latestOwner);

    expect(
      releaseConversationMutationOwner(owners, conversationA, olderOwner),
    ).toBe(false);
    expect(owners.get(conversationA)).toBe(latestOwner);
    expect(
      releaseConversationMutationOwner(owners, conversationA, latestOwner),
    ).toBe(true);
    expect(owners.has(conversationA)).toBe(false);
  });
});

function run(id: string, conversationId: string): AgentRun {
  return {
    id,
    requestId: id.replace(/^2/u, "3"),
    conversationId,
    inputMessageId: null,
    assistantMessageId: null,
    status: "running",
    conversationTurn: "1",
    attemptIndex: 1,
    predecessorRunId: null,
    retryOfRunId: null,
    regenerateOfRunId: null,
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
    failure: null,
    createdAt: "2026-08-24T08:00:00.000Z",
    startedAt: "2026-08-24T08:00:01.000Z",
    finishedAt: null,
    cancelRequestedAt: null,
  };
}

function message(input: {
  id: string;
  runId: string | null;
  role: ChatMessage["role"];
  content: string;
  createdAt: string;
}): ChatMessage {
  return {
    ...input,
    citations: [],
    artifacts: [],
    attachments: [],
    feedback: null,
  };
}

function event(
  id: string,
  runId: string,
  payload: RunEvent["payload"],
): RunEvent {
  return {
    id,
    runId,
    createdAt: `2026-08-24T08:00:${id.padStart(2, "0")}.000Z`,
    payload,
  };
}

function conversationSummary(
  input: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id: conversationA,
    title: "德国买家",
    updatedAt: "2026-08-24T08:01:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: runA,
    activeRun: null,
    waitingRunCount: 0,
    attention: null,
    ...input,
  };
}

describe("bootstrap conversation detail compatibility", () => {
  it("详情刷新只在目标会话仍为当前可见会话时允许提交", () => {
    expect(
      visibleConversationDetailRefreshIsCurrent({
        requestedConversationId: conversationA,
        activeConversationId: conversationA,
        visibilityState: "visible",
      }),
    ).toBe(true);
    expect(
      visibleConversationDetailRefreshIsCurrent({
        requestedConversationId: conversationA,
        activeConversationId: conversationB,
        visibilityState: "visible",
      }),
    ).toBe(false);
    expect(
      visibleConversationDetailRefreshIsCurrent({
        requestedConversationId: conversationA,
        activeConversationId: conversationA,
        visibilityState: "hidden",
      }),
    ).toBe(false);
  });

  it("识别未知 selected Run 和 selected 不变但 active Run 未知的摘要", () => {
    const loadedState = {
      ...createConversationViewState(),
      runs: [run(runA, conversationA)],
      isLoaded: true,
    };

    expect(
      conversationSummaryRequiresDetailRefresh(
        conversationSummary({ selectedRunId: runB }),
        loadedState,
      ),
    ).toBe(true);
    expect(
      conversationSummaryRequiresDetailRefresh(
        conversationSummary({
          activeRun: {
            id: runB,
            status: "running",
            startedAt: "2026-08-24T08:01:00.000Z",
          },
        }),
        loadedState,
      ),
    ).toBe(true);
  });

  it("严格核对 active Run、startedAt 和 waiting 数量", () => {
    const runningRun = run(runA, conversationA);
    const loadedState = {
      ...createConversationViewState(),
      runs: [runningRun],
      isLoaded: true,
    };
    const matchingSummary = conversationSummary({
      activeRun: {
        id: runA,
        status: "running",
        startedAt: runningRun.startedAt,
      },
    });

    expect(
      conversationSummaryRequiresDetailRefresh(matchingSummary, loadedState),
    ).toBe(false);
    expect(
      conversationSummaryRequiresDetailRefresh(
        conversationSummary({ activeRun: null }),
        loadedState,
      ),
    ).toBe(true);
    expect(
      conversationSummaryRequiresDetailRefresh(
        conversationSummary({
          activeRun: {
            id: runA,
            status: "queued",
            startedAt: runningRun.startedAt,
          },
        }),
        loadedState,
      ),
    ).toBe(true);
    expect(
      conversationSummaryRequiresDetailRefresh(
        conversationSummary({
          activeRun: {
            id: runA,
            status: "running",
            startedAt: "2026-08-24T08:00:02.000Z",
          },
        }),
        loadedState,
      ),
    ).toBe(true);
    expect(
      conversationSummaryRequiresDetailRefresh(
        conversationSummary({
          activeRun: matchingSummary.activeRun,
          waitingRunCount: 1,
        }),
        loadedState,
      ),
    ).toBe(true);
  });

  it("识别完成的 A 被 waiting successor B 接替", () => {
    const successor: AgentRun = {
      ...run(runB, conversationA),
      status: "waiting",
      predecessorRunId: runA,
      startedAt: null,
    };
    const completedA: AgentRun = {
      ...run(runA, conversationA),
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    const loadedState = {
      ...createConversationViewState(),
      runs: [completedA, successor],
      isLoaded: true,
    };

    expect(
      conversationSummaryRequiresDetailRefresh(
        conversationSummary({
          selectedRunId: runB,
          activeRun: { id: runB, status: "running", startedAt: null },
          waitingRunCount: 0,
        }),
        loadedState,
      ),
    ).toBe(true);
  });

  it("等待不兼容详情加载完成，并将未成功加载的会话交给 merge 保留", async () => {
    const staleState = {
      ...createConversationViewState(),
      runs: [run(runA, conversationA)],
      isLoaded: true,
    };
    const incoming = conversationSummary({ selectedRunId: runB });
    const refreshedDetail: ConversationResponse = {
      conversation: incoming,
      messages: [],
      runs: [run(runB, conversationA)],
    };
    const loadCalls: string[] = [];
    let resolveLoad: ((result: ConversationLoadResult) => void) | undefined;
    const refresh = refreshIncompatibleBootstrapConversationDetails({
      conversations: [incoming],
      states: { [conversationA]: staleState },
      loadConversation: (conversationId) => {
        loadCalls.push(conversationId);
        return new Promise((resolve) => {
          resolveLoad = resolve;
        });
      },
    });
    let refreshSettled = false;
    void refresh.then(() => {
      refreshSettled = true;
    });

    expect(loadCalls).toEqual([conversationA]);
    await Promise.resolve();
    expect(refreshSettled).toBe(false);
    resolveLoad?.({ status: "loaded", detail: refreshedDetail });
    await expect(refresh).resolves.toEqual(new Set());

    for (const status of [
      "failed",
      "superseded",
      "revision_changed",
    ] as const) {
      await expect(
        refreshIncompatibleBootstrapConversationDetails({
          conversations: [incoming],
          states: { [conversationA]: staleState },
          loadConversation: async () => ({ status }),
        }),
      ).resolves.toEqual(new Set([conversationA]));
    }
  });
});

describe("conversationStateReducer", () => {
  it("resets every loaded conversation after an account-wide data mutation", () => {
    const firstConversationId = "10000000-0000-4000-8000-000000000001";
    const secondConversationId = "10000000-0000-4000-8000-000000000002";
    let states = conversationStateReducer({}, {
      type: "load_started",
      conversationId: firstConversationId,
    });
    states = conversationStateReducer(states, {
      type: "load_started",
      conversationId: secondConversationId,
    });

    expect(Object.keys(states)).toEqual([
      firstConversationId,
      secondConversationId,
    ]);
    expect(conversationStateReducer(states, { type: "reset_all" })).toEqual(
      {},
    );
  });

  it("首次加载因 revision 变化失效时结束 loading 并进入现有重试入口", () => {
    let states = conversationStateReducer({}, {
      type: "load_started",
      conversationId: conversationA,
    });

    states = conversationStateReducer(states, {
      type: "load_invalidated",
      conversationId: conversationA,
    });
    const state = states[conversationA];

    expect(state).toMatchObject({
      isLoaded: false,
      isLoading: false,
      error: conversationLoadInvalidatedMessage,
      loadError: conversationLoadInvalidatedMessage,
    });
    expect(
      shouldRetryConversationLoad({
        activeConversationId: conversationA,
        requestedConversationId: conversationA,
        state,
        hasInFlightRequest: false,
      }),
    ).toBe(true);
  });

  it("已加载会话的 refresh 因 revision 变化失效时保留内容且不制造错误", () => {
    const loadedMessage = message({
      id: "50000000-0000-4000-8000-000000000001",
      runId: runA,
      role: "assistant",
      content: "德国买家研究结果",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const loadedRun = run(runA, conversationA);
    let states = conversationStateReducer(
      {
        [conversationA]: {
          ...createConversationViewState(),
          messages: [loadedMessage],
          runs: [loadedRun],
          isLoaded: true,
        },
      },
      {
        type: "load_started",
        conversationId: conversationA,
      },
    );
    const messagesDuringRefresh = states[conversationA].messages;
    const runsDuringRefresh = states[conversationA].runs;

    states = conversationStateReducer(states, {
      type: "load_invalidated",
      conversationId: conversationA,
    });
    const state = states[conversationA];

    expect(state).toMatchObject({
      isLoaded: true,
      isLoading: false,
      error: null,
      loadError: null,
    });
    expect(state.messages).toBe(messagesDuringRefresh);
    expect(state.runs).toBe(runsDuringRefresh);
    expect(state.messages).toEqual([loadedMessage]);
    expect(state.runs).toEqual([loadedRun]);
  });

  it("marks stale-parent reload failure as retryable through the existing load path", () => {
    const states = conversationStateReducer(
      {
        [conversationA]: {
          ...createConversationViewState(),
          isLoaded: true,
          isStarting: true,
        },
      },
      {
        type: "conversation_reload_required",
        conversationId: conversationA,
        message: "刷新失败，请重试",
      },
    );
    const state = states[conversationA];

    expect(state).toMatchObject({
      isLoaded: false,
      isLoading: false,
      isStarting: false,
      error: "刷新失败，请重试",
      loadError: "刷新失败，请重试",
    });
    expect(
      shouldRetryConversationLoad({
        activeConversationId: conversationA,
        requestedConversationId: conversationA,
        state,
        hasInFlightRequest: false,
      }),
    ).toBe(true);
  });

  it("会话详情加载失败后可重新加载并恢复正常状态", () => {
    const detail: ConversationResponse = {
      conversation: {
        id: conversationA,
        title: "德国买家",
        updatedAt: "2026-08-24T08:01:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        selectedRunId: null,
        activeRun: null,
        waitingRunCount: 0,
        attention: null,
      },
      messages: [],
      runs: [],
    };

    let states = conversationStateReducer({}, {
      type: "load_started",
      conversationId: conversationA,
    });
    expect(states[conversationA]).toMatchObject({
      isLoaded: false,
      isLoading: true,
      error: null,
      loadError: null,
    });

    states = conversationStateReducer(states, {
      type: "load_failed",
      conversationId: conversationA,
      message: "网络连接已中断",
    });
    expect(states[conversationA]).toMatchObject({
      isLoaded: false,
      isLoading: false,
      error: "网络连接已中断",
      loadError: "网络连接已中断",
    });

    states = conversationStateReducer(states, {
      type: "load_started",
      conversationId: conversationA,
    });
    expect(states[conversationA]).toMatchObject({
      isLoaded: false,
      isLoading: true,
      error: null,
      loadError: null,
    });

    states = conversationStateReducer(states, {
      type: "load_succeeded",
      conversationId: conversationA,
      detail,
      feedbackDataRevision: 1,
    });
    expect(states[conversationA]).toMatchObject({
      isLoaded: true,
      isLoading: false,
      error: null,
      loadError: null,
    });
  });

  it("按 conversationId 隔离并行运行的消息和 delta", () => {
    let states: ConversationStateMap = {
      [conversationA]: {
        ...createConversationViewState(),
        runs: [run(runA, conversationA)],
      },
      [conversationB]: {
        ...createConversationViewState(),
        runs: [run(runB, conversationB)],
      },
    };

    states = conversationStateReducer(states, {
      type: "run_events_received",
      conversationId: conversationA,
      observations: [
        {
          event: event("1", runA, { type: "delta", text: "A 的结果" }),
          feedbackDataRevision: 1,
        },
      ],
    });
    states = conversationStateReducer(states, {
      type: "run_events_received",
      conversationId: conversationB,
      observations: [
        {
          event: event("2", runB, { type: "delta", text: "B 的结果" }),
          feedbackDataRevision: 2,
        },
      ],
    });

    expect(textForRun(eventsForRun(states[conversationA], runA))).toBe("A 的结果");
    expect(textForRun(eventsForRun(states[conversationB], runB))).toBe("B 的结果");
  });

  it("直接使用启动响应里的持久化 userMessage 和 run", () => {
    const response: ChatStartResponse = {
      conversation: {
        id: conversationA,
        title: "德国买家",
        updatedAt: "2026-08-24T08:00:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        selectedRunId: runA,
        activeRun: { id: runA, status: "queued", startedAt: null },
        waitingRunCount: 0,
        attention: null,
      },
      userMessage: {
        id: "40000000-0000-4000-8000-000000000001",
        runId: runA,
        role: "user",
        content: "寻找德国买家",
        citations: [],
        artifacts: [],
        attachments: [],
        feedback: null,
        createdAt: "2026-08-24T08:00:00.000Z",
      },
      run: {
        ...run(runA, conversationA),
        inputMessageId: "40000000-0000-4000-8000-000000000001",
        assistantMessageId: "40000000-0000-4000-8000-000000000002",
        status: "queued",
        startedAt: null,
      },
      credits: { available: 9_500, reserved: 500 },
    };

    const states = conversationStateReducer({}, {
      type: "run_started",
      conversationId: conversationA,
      response,
    });

    expect(states[conversationA].messages).toEqual([response.userMessage]);
    expect(states[conversationA].runs).toEqual([response.run]);
  });

  it("拒绝同一 run 非严格递增的事件序号", () => {
    const first = conversationStateReducer({}, {
      type: "run_events_received",
      conversationId: conversationA,
      observations: [
        {
          event: event("2", runA, { type: "delta", text: "first" }),
          feedbackDataRevision: 1,
        },
      ],
    });
    expect(() =>
      conversationStateReducer(first, {
        type: "run_events_received",
        conversationId: conversationA,
        observations: [
          {
            event: event("2", runA, { type: "delta", text: "duplicate" }),
            feedbackDataRevision: 2,
          },
        ],
      }),
    ).toThrow("事件序号必须严格递增");
  });

  it("一次批量提交多个同 Run 事件并拒绝空批次或混入其他 Run", () => {
    const states = conversationStateReducer({}, {
      type: "run_events_received",
      conversationId: conversationA,
      observations: [
        {
          event: event("1", runA, { type: "delta", text: "批量" }),
          feedbackDataRevision: 1,
        },
        {
          event: event("3", runA, { type: "delta", text: "提交" }),
          feedbackDataRevision: 1,
        },
      ],
    });

    expect(textForRun(eventsForRun(states[conversationA], runA))).toBe(
      "批量提交",
    );
    expect(() =>
      conversationStateReducer(states, {
        type: "run_events_received",
        conversationId: conversationA,
        observations: [],
      }),
    ).toThrow("运行事件批次不能为空");
    expect(() =>
      conversationStateReducer({}, {
        type: "run_events_received",
        conversationId: conversationA,
        observations: [
          {
            event: event("1", runA, { type: "delta", text: "A" }),
            feedbackDataRevision: 1,
          },
          {
            event: event("2", runB, { type: "delta", text: "B" }),
            feedbackDataRevision: 1,
          },
        ],
      }),
    ).toThrow("混入了另一个 Run");
  });

  it("为 assistant 消息依次设置 up、down 和 null 反馈", () => {
    const assistantMessage = message({
      id: "50000000-0000-4000-8000-000000000001",
      runId: runA,
      role: "assistant",
      content: "研究结果",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    let states: ConversationStateMap = {
      [conversationA]: {
        ...createConversationViewState(),
        messages: [assistantMessage],
      },
    };

    states = conversationStateReducer(states, {
      type: "message_feedback_updated",
      conversationId: conversationA,
      messageId: assistantMessage.id,
      feedback: "up",
      feedbackDataRevision: 1,
    });
    expect(states[conversationA].messages[0].feedback).toBe("up");
    expect(states[conversationA].messageFeedbackOverrides).toEqual({
      [assistantMessage.id]: { feedback: "up", revision: 1 },
    });

    states = conversationStateReducer(states, {
      type: "message_feedback_updated",
      conversationId: conversationA,
      messageId: assistantMessage.id,
      feedback: "down",
      feedbackDataRevision: 2,
    });
    expect(states[conversationA].messages[0].feedback).toBe("down");
    expect(states[conversationA].messageFeedbackOverrides).toEqual({
      [assistantMessage.id]: { feedback: "down", revision: 2 },
    });

    states = conversationStateReducer(states, {
      type: "message_feedback_updated",
      conversationId: conversationA,
      messageId: assistantMessage.id,
      feedback: null,
      feedbackDataRevision: 3,
    });
    expect(states[conversationA].messages[0].feedback).toBeNull();
    expect(states[conversationA].messageFeedbackOverrides).toEqual({
      [assistantMessage.id]: { feedback: null, revision: 3 },
    });
  });

  it("拒绝为用户消息设置反馈", () => {
    const userMessage = message({
      id: "40000000-0000-4000-8000-000000000001",
      runId: runA,
      role: "user",
      content: "寻找德国买家",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const states: ConversationStateMap = {
      [conversationA]: {
        ...createConversationViewState(),
        messages: [userMessage],
      },
    };

    expect(() =>
      conversationStateReducer(states, {
        type: "message_feedback_updated",
        conversationId: conversationA,
        messageId: userMessage.id,
        feedback: "up",
        feedbackDataRevision: 1,
      }),
    ).toThrow(`用户消息 ${userMessage.id} 不能设置反馈`);
  });

  it("迟到的 done 事件不会用 null 覆盖本地 up 反馈", () => {
    const assistantMessage = message({
      id: "50000000-0000-4000-8000-000000000002",
      runId: runA,
      role: "assistant",
      content: "研究结果",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    let states: ConversationStateMap = {
      [conversationA]: {
        ...createConversationViewState(),
        messages: [assistantMessage],
      },
    };

    states = conversationStateReducer(states, {
      type: "message_feedback_updated",
      conversationId: conversationA,
      messageId: assistantMessage.id,
      feedback: "up",
      feedbackDataRevision: 2,
    });
    states = conversationStateReducer(states, {
      type: "run_events_received",
      conversationId: conversationA,
      observations: [
        {
          event: event("1", runA, {
            type: "done",
            message: assistantMessage,
            credits: { available: 9_500, reserved: 0 },
          }),
          feedbackDataRevision: 1,
        },
      ],
    });

    expect(states[conversationA].messages).toEqual([
      { ...assistantMessage, feedback: "up" },
    ]);
    expect(states[conversationA].messageFeedbackOverrides).toEqual({
      [assistantMessage.id]: { feedback: "up", revision: 2 },
    });
    expect(states[conversationA].messageFeedbackRevisions).toEqual({
      [assistantMessage.id]: 2,
    });
  });

  it("新权威 load 清除反馈栅栏后，晚到的旧 load 仍不能回滚反馈", () => {
    const assistantMessage = message({
      id: "50000000-0000-4000-8000-000000000003",
      runId: runA,
      role: "assistant",
      content: "研究结果",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const detail = (
      feedback: ChatMessage["feedback"],
    ): ConversationResponse => ({
      conversation: {
        id: conversationA,
        title: "德国买家",
        updatedAt: "2026-08-24T08:01:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        selectedRunId: null,
        activeRun: null,
        waitingRunCount: 0,
        attention: null,
      },
      messages: [{ ...assistantMessage, feedback }],
      runs: [],
    });
    let states: ConversationStateMap = {
      [conversationA]: {
        ...createConversationViewState(),
        messages: [assistantMessage],
      },
    };

    states = conversationStateReducer(states, {
      type: "message_feedback_updated",
      conversationId: conversationA,
      messageId: assistantMessage.id,
      feedback: "up",
      feedbackDataRevision: 2,
    });
    states = conversationStateReducer(states, {
      type: "load_succeeded",
      conversationId: conversationA,
      detail: detail(null),
      feedbackDataRevision: 1,
    });

    expect(states[conversationA].messages[0].feedback).toBe("up");
    expect(states[conversationA].messageFeedbackOverrides).toEqual({
      [assistantMessage.id]: { feedback: "up", revision: 2 },
    });

    states = conversationStateReducer(states, {
      type: "load_succeeded",
      conversationId: conversationA,
      detail: detail("down"),
      feedbackDataRevision: 3,
    });

    expect(states[conversationA].messages[0].feedback).toBe("down");
    expect(states[conversationA].messageFeedbackOverrides).toEqual({});
    expect(states[conversationA].messageFeedbackRevisions).toEqual({
      [assistantMessage.id]: 3,
    });

    states = conversationStateReducer(states, {
      type: "load_succeeded",
      conversationId: conversationA,
      detail: detail(null),
      feedbackDataRevision: 1,
    });

    expect(states[conversationA].messages[0].feedback).toBe("down");
    expect(states[conversationA].messageFeedbackOverrides).toEqual({});
    expect(states[conversationA].messageFeedbackRevisions).toEqual({
      [assistantMessage.id]: 3,
    });
  });

  it("拒绝用非递增 revision 提交本地反馈", () => {
    const assistantMessage = message({
      id: "50000000-0000-4000-8000-000000000004",
      runId: runA,
      role: "assistant",
      content: "研究结果",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const states = conversationStateReducer(
      {
        [conversationA]: {
          ...createConversationViewState(),
          messages: [assistantMessage],
        },
      },
      {
        type: "message_feedback_updated",
        conversationId: conversationA,
        messageId: assistantMessage.id,
        feedback: "up",
        feedbackDataRevision: 2,
      },
    );

    expect(() =>
      conversationStateReducer(states, {
        type: "message_feedback_updated",
        conversationId: conversationA,
        messageId: assistantMessage.id,
        feedback: "down",
        feedbackDataRevision: 2,
      }),
    ).toThrow("反馈 revision 必须递增");
  });
});

describe("shouldRetryConversationLoad", () => {
  const failedState = {
    ...createConversationViewState(),
    error: "网络连接已中断",
    loadError: "网络连接已中断",
  };

  it("仅允许当前失败会话在没有进行中请求时重试", () => {
    expect(
      shouldRetryConversationLoad({
        activeConversationId: conversationA,
        requestedConversationId: conversationA,
        state: failedState,
        hasInFlightRequest: false,
      }),
    ).toBe(true);
  });

  it.each([
    {
      name: "目标不是当前会话",
      activeConversationId: conversationB,
      state: failedState,
      hasInFlightRequest: false,
    },
    {
      name: "没有当前会话",
      activeConversationId: null,
      state: failedState,
      hasInFlightRequest: false,
    },
    {
      name: "已有相同请求执行中",
      activeConversationId: conversationA,
      state: failedState,
      hasInFlightRequest: true,
    },
    {
      name: "会话仍在加载",
      activeConversationId: conversationA,
      state: { ...failedState, isLoading: true },
      hasInFlightRequest: false,
    },
    {
      name: "会话已经加载成功",
      activeConversationId: conversationA,
      state: { ...failedState, isLoaded: true },
      hasInFlightRequest: false,
    },
    {
      name: "会话没有加载错误",
      activeConversationId: conversationA,
      state: { ...failedState, error: null, loadError: null },
      hasInFlightRequest: false,
    },
    {
      name: "会话状态尚未创建",
      activeConversationId: conversationA,
      state: undefined,
      hasInFlightRequest: false,
    },
  ])("拒绝$name", ({ activeConversationId, state, hasInFlightRequest }) => {
    expect(
      shouldRetryConversationLoad({
        activeConversationId,
        requestedConversationId: conversationA,
        state,
        hasInFlightRequest,
      }),
    ).toBe(false);
  });
});

describe("projectConversationTimeline", () => {
  it("未完整加载的非空会话不会用 partial state 投影 selected path", () => {
    const partialState = {
      ...createConversationViewState(),
      isLoading: true,
    };

    expect(projectLoadedConversationTimeline(partialState, runA)).toEqual([]);
  });

  it("回答版本默认选择最新 attempt，并严格拒绝其他 Turn 的 Run", () => {
    const attempts = [
      { run: run(runA, conversationA), assistantMessage: null },
      {
        run: {
          ...run(runB, conversationA),
          attemptIndex: 2,
          retryOfRunId: runA,
        },
        assistantMessage: null,
      },
    ];

    expect(() => selectedConversationAttemptIndex(attempts, null)).toThrow(
      "缺少明确选中的 Run",
    );
    expect(selectedConversationAttemptIndex(attempts, runA)).toBe(0);
    expect(() =>
      selectedConversationAttemptIndex(
        attempts,
        "20000000-0000-4000-8000-000000000099",
      ),
    ).toThrow("不属于当前 Turn");
  });

  it("按 Turn 投影输入、attempt 和各自的 assistant 消息", () => {
    const firstInput = message({
      id: "40000000-0000-4000-8000-000000000001",
      runId: runA,
      role: "user",
      content: "第一轮研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const firstAssistant = message({
      id: "50000000-0000-4000-8000-000000000001",
      runId: runA,
      role: "assistant",
      content: "第一轮研究结果",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const secondInput = message({
      id: "40000000-0000-4000-8000-000000000002",
      runId: runB,
      role: "user",
      content: "第二轮研究请求",
      createdAt: "2026-08-24T08:02:00.000Z",
    });
    const secondAssistant = message({
      id: "50000000-0000-4000-8000-000000000002",
      runId: runB,
      role: "assistant",
      content: "第二轮研究结果",
      createdAt: "2026-08-24T08:03:00.000Z",
    });
    const firstRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: firstInput.id,
      assistantMessageId: firstAssistant.id,
      status: "completed",
      finishedAt: firstAssistant.createdAt,
    };
    const secondRun: AgentRun = {
      ...run(runB, conversationA),
      inputMessageId: secondInput.id,
      assistantMessageId: secondAssistant.id,
      status: "completed",
      conversationTurn: "2",
      predecessorRunId: firstRun.id,
      createdAt: secondInput.createdAt,
      startedAt: "2026-08-24T08:02:01.000Z",
      finishedAt: secondAssistant.createdAt,
    };

    expect(
      projectConversationTimeline({
        messages: [secondAssistant, firstInput, secondInput, firstAssistant],
        runs: [secondRun, firstRun],
      }, secondRun.id),
    ).toEqual([
      {
        kind: "turn",
        conversationTurn: "1",
        inputMessage: firstInput,
        attempts: [{ run: firstRun, assistantMessage: firstAssistant }],
        selectedAttemptIndex: 0,
        branches: [
          {
            inputMessageId: firstInput.id,
            latestAttemptRunId: firstRun.id,
          },
        ],
        selectedBranchIndex: 0,
      },
      {
        kind: "turn",
        conversationTurn: "2",
        inputMessage: secondInput,
        attempts: [{ run: secondRun, assistantMessage: secondAssistant }],
        selectedAttemptIndex: 0,
        branches: [
          {
            inputMessageId: secondInput.id,
            latestAttemptRunId: secondRun.id,
          },
        ],
        selectedBranchIndex: 0,
      },
    ]);
  });

  it("retry 即使晚于下一 Turn 创建，也仍留在原 Turn 的 attempts 中", () => {
    const retryRunId = "20000000-0000-4000-8000-000000000003";
    const secondTurnRunId = "20000000-0000-4000-8000-000000000004";
    const firstInput = message({
      id: "40000000-0000-4000-8000-000000000003",
      runId: runA,
      role: "user",
      content: "第一轮研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const retryAssistant = message({
      id: "50000000-0000-4000-8000-000000000004",
      runId: retryRunId,
      role: "assistant",
      content: "重试后的结果",
      createdAt: "2026-08-24T08:03:00.000Z",
    });
    const secondInput = message({
      id: "40000000-0000-4000-8000-000000000004",
      runId: secondTurnRunId,
      role: "user",
      content: "第二轮排队请求",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const failedRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: firstInput.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000003",
      status: "failed",
      failure: { code: "PROVIDER_ERROR", message: "供应商暂时失败。" },
      finishedAt: "2026-08-24T08:00:30.000Z",
    };
    const waitingRun: AgentRun = {
      ...run(secondTurnRunId, conversationA),
      inputMessageId: secondInput.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000005",
      status: "waiting",
      conversationTurn: "2",
      predecessorRunId: retryRunId,
      createdAt: secondInput.createdAt,
      startedAt: null,
    };
    const retryRun: AgentRun = {
      ...run(retryRunId, conversationA),
      inputMessageId: firstInput.id,
      assistantMessageId: retryAssistant.id,
      status: "completed",
      attemptIndex: 2,
      retryOfRunId: failedRun.id,
      createdAt: "2026-08-24T08:02:00.000Z",
      startedAt: "2026-08-24T08:02:01.000Z",
      finishedAt: retryAssistant.createdAt,
    };

    expect(
      projectConversationTimeline({
        messages: [firstInput, secondInput, retryAssistant],
        runs: [failedRun, waitingRun, retryRun],
      }, waitingRun.id),
    ).toEqual([
      {
        kind: "turn",
        conversationTurn: "1",
        inputMessage: firstInput,
        attempts: [
          { run: failedRun, assistantMessage: null },
          { run: retryRun, assistantMessage: retryAssistant },
        ],
        selectedAttemptIndex: 1,
        branches: [
          {
            inputMessageId: firstInput.id,
            latestAttemptRunId: retryRun.id,
          },
        ],
        selectedBranchIndex: 0,
      },
      {
        kind: "turn",
        conversationTurn: "2",
        inputMessage: secondInput,
        attempts: [{ run: waitingRun, assistantMessage: null }],
        selectedAttemptIndex: 0,
        branches: [
          {
            inputMessageId: secondInput.id,
            latestAttemptRunId: waitingRun.id,
          },
        ],
        selectedBranchIndex: 0,
      },
    ]);
  });

  it("把 runId 为 null 的消息作为 standalone item 稳定合并", () => {
    const standaloneBefore = message({
      id: "60000000-0000-4000-8000-000000000001",
      runId: null,
      role: "assistant",
      content: "旧系统消息",
      createdAt: "2026-08-24T07:59:00.000Z",
    });
    const input = message({
      id: "40000000-0000-4000-8000-000000000005",
      runId: runA,
      role: "user",
      content: "研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const standaloneAfter = message({
      id: "60000000-0000-4000-8000-000000000002",
      runId: null,
      role: "assistant",
      content: "后续系统消息",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const runningRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: input.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000006",
    };

    expect(
      projectConversationTimeline({
        messages: [standaloneAfter, input, standaloneBefore],
        runs: [runningRun],
      }, runningRun.id),
    ).toEqual([
      { kind: "standalone_message", message: standaloneBefore },
      {
        kind: "turn",
        conversationTurn: "1",
        inputMessage: input,
        attempts: [{ run: runningRun, assistantMessage: null }],
        selectedAttemptIndex: 0,
        branches: [
          {
            inputMessageId: input.id,
            latestAttemptRunId: runningRun.id,
          },
        ],
        selectedBranchIndex: 0,
      },
      { kind: "standalone_message", message: standaloneAfter },
    ]);
  });

  it("拒绝缺失 Turn 输入消息的响应", () => {
    const missingInputId = "40000000-0000-4000-8000-000000000006";
    const runningRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: missingInputId,
      assistantMessageId: "50000000-0000-4000-8000-000000000007",
    };

    expect(() =>
      projectConversationTimeline({ messages: [], runs: [runningRun] }, runA),
    ).toThrow(`缺少输入消息 ${missingInputId}`);
  });

  it("拒绝消息引用不存在的 Run", () => {
    const missingRunId = "20000000-0000-4000-8000-000000000099";
    const orphanMessage = message({
      id: "50000000-0000-4000-8000-000000000008",
      runId: missingRunId,
      role: "assistant",
      content: "孤立结果",
      createdAt: "2026-08-24T08:00:00.000Z",
    });

    expect(() =>
      projectConversationTimeline({ messages: [orphanMessage], runs: [] }, null),
    ).toThrow(`引用了不存在的 Run ${missingRunId}`);
  });

  it("拒绝 assistant 消息 ID 与 runId 的关联不一致", () => {
    const input = message({
      id: "40000000-0000-4000-8000-000000000009",
      runId: runA,
      role: "user",
      content: "研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const mismatchedAssistant = message({
      id: "50000000-0000-4000-8000-000000000009",
      runId: runB,
      role: "assistant",
      content: "错误关联的结果",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const completedRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: input.id,
      assistantMessageId: mismatchedAssistant.id,
      status: "completed",
      finishedAt: mismatchedAssistant.createdAt,
    };

    expect(() =>
      projectConversationTimeline({
        messages: [input, mismatchedAssistant],
        runs: [completedRun],
      }, completedRun.id),
    ).toThrow(`Run ${runA} 的 assistant 消息`);
  });

  it("把 completed regenerate 保留在原 Turn 的 attempts 中", () => {
    const input = message({
      id: "40000000-0000-4000-8000-000000000090",
      runId: runA,
      role: "user",
      content: "研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const firstAssistant = message({
      id: "50000000-0000-4000-8000-000000000090",
      runId: runA,
      role: "assistant",
      content: "首个回答",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const regeneratedAssistant = message({
      id: "50000000-0000-4000-8000-000000000091",
      runId: runB,
      role: "assistant",
      content: "重新生成的回答",
      createdAt: "2026-08-24T08:02:00.000Z",
    });
    const firstRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: input.id,
      assistantMessageId: firstAssistant.id,
      status: "completed",
      finishedAt: firstAssistant.createdAt,
    };
    const regeneratedRun: AgentRun = {
      ...run(runB, conversationA),
      inputMessageId: input.id,
      assistantMessageId: regeneratedAssistant.id,
      status: "completed",
      attemptIndex: 2,
      regenerateOfRunId: firstRun.id,
      createdAt: "2026-08-24T08:01:30.000Z",
      startedAt: "2026-08-24T08:01:31.000Z",
      finishedAt: regeneratedAssistant.createdAt,
    };

    expect(
      projectConversationTimeline({
        messages: [input, firstAssistant, regeneratedAssistant],
        runs: [firstRun, regeneratedRun],
      }, regeneratedRun.id),
    ).toEqual([
      {
        kind: "turn",
        conversationTurn: "1",
        inputMessage: input,
        attempts: [
          { run: firstRun, assistantMessage: firstAssistant },
          { run: regeneratedRun, assistantMessage: regeneratedAssistant },
        ],
        selectedAttemptIndex: 1,
        branches: [
          {
            inputMessageId: input.id,
            latestAttemptRunId: regeneratedRun.id,
          },
        ],
        selectedBranchIndex: 0,
      },
    ]);
  });

  it("拒绝 retryOfRunId 与 regenerateOfRunId 都不符合 attempt 链", () => {
    const input = message({
      id: "40000000-0000-4000-8000-000000000010",
      runId: runA,
      role: "user",
      content: "研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const firstRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: input.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000010",
    };
    const malformedRetry: AgentRun = {
      ...run(runB, conversationA),
      inputMessageId: input.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000011",
      attemptIndex: 2,
    };

    expect(() =>
      projectConversationTimeline({
        messages: [input],
        runs: [firstRun, malformedRetry],
      }, malformedRetry.id),
    ).toThrow("attempt 来源不符合链");
  });

  it("拒绝一个 attempt 同时声明 retry 和 regenerate 来源", () => {
    const firstAssistantId = "50000000-0000-4000-8000-000000000092";
    const input = message({
      id: "40000000-0000-4000-8000-000000000092",
      runId: runA,
      role: "user",
      content: "研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const firstRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: input.id,
      assistantMessageId: firstAssistantId,
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    const firstAssistant = message({
      id: firstAssistantId,
      runId: firstRun.id,
      role: "assistant",
      content: "首个回答",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const malformedAttempt: AgentRun = {
      ...run(runB, conversationA),
      inputMessageId: input.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000093",
      attemptIndex: 2,
      retryOfRunId: firstRun.id,
      regenerateOfRunId: firstRun.id,
    };

    expect(() =>
      projectConversationTimeline({
        messages: [input, firstAssistant],
        runs: [firstRun, malformedAttempt],
      }, malformedAttempt.id),
    ).toThrow("attempt 来源不符合链");
  });

  it("拒绝不连续的 attemptIndex", () => {
    const input = message({
      id: "40000000-0000-4000-8000-000000000011",
      runId: runA,
      role: "user",
      content: "研究请求",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const firstRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: input.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000012",
    };
    const malformedRetry: AgentRun = {
      ...run(runB, conversationA),
      inputMessageId: input.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000013",
      attemptIndex: 3,
      retryOfRunId: firstRun.id,
    };

    expect(() =>
      projectConversationTimeline({
        messages: [input],
        runs: [firstRun, malformedRetry],
      }, malformedRetry.id),
    ).toThrow("attemptIndex 不连续");
  });

  it("拒绝 predecessorRunId 与前一 Turn 链不一致", () => {
    const firstInput = message({
      id: "40000000-0000-4000-8000-000000000012",
      runId: runA,
      role: "user",
      content: "第一轮",
      createdAt: "2026-08-24T08:00:00.000Z",
    });
    const secondInput = message({
      id: "40000000-0000-4000-8000-000000000013",
      runId: runB,
      role: "user",
      content: "第二轮",
      createdAt: "2026-08-24T08:01:00.000Z",
    });
    const firstRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: firstInput.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000014",
    };
    const malformedSecondRun: AgentRun = {
      ...run(runB, conversationA),
      inputMessageId: secondInput.id,
      assistantMessageId: "50000000-0000-4000-8000-000000000015",
      conversationTurn: "2",
      createdAt: secondInput.createdAt,
    };

    expect(() =>
      projectConversationTimeline({
        messages: [firstInput, secondInput],
        runs: [firstRun, malformedSecondRun],
      }, malformedSecondRun.id),
    ).toThrow("conversationTurn 必须为 1");
  });
});

describe("conversation attention visibility", () => {
  const attentionConversation: ConversationSummary = {
    id: conversationA,
    title: "后台运行",
    updatedAt: "2026-08-24T08:00:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: runA,
    activeRun: null,
    waitingRunCount: 0,
    attention: {
      terminalEventId: "42",
      runId: runA,
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    },
  };

  it("only marks a terminal result read in the active visible conversation", () => {
    expect(
      shouldMarkConversationRead({
        activeConversationId: conversationA,
        conversationId: conversationA,
        visibilityState: "visible",
      }),
    ).toBe(true);
    expect(
      shouldMarkConversationRead({
        activeConversationId: conversationA,
        conversationId: conversationB,
        visibilityState: "visible",
      }),
    ).toBe(false);
    expect(
      shouldMarkConversationRead({
        activeConversationId: conversationA,
        conversationId: conversationA,
        visibilityState: "hidden",
      }),
    ).toBe(false);
    expect(
      shouldMarkConversationRead({
        activeConversationId: null,
        conversationId: conversationA,
        visibilityState: "visible",
      }),
    ).toBe(false);
  });

  it("does not resurrect attention from a refresh older than an acknowledged read", () => {
    expect(
      conversationSummaryAtReadWatermark(attentionConversation, "42"),
    ).toEqual({ ...attentionConversation, attention: null });
    expect(
      conversationSummaryAtReadWatermark(attentionConversation, "43"),
    ).toEqual({ ...attentionConversation, attention: null });
  });

  it("preserves a newer terminal result beyond the acknowledged read", () => {
    expect(
      conversationSummaryAtReadWatermark(attentionConversation, "41"),
    ).toBe(attentionConversation);
    expect(
      conversationSummaryAtReadWatermark(attentionConversation, null),
    ).toBe(attentionConversation);
  });

  it("only treats a terminal result as visible after its answer or terminal event is local", () => {
    const emptyState = createConversationViewState();
    expect(
      conversationStateShowsTerminalResult(emptyState, runA, "42"),
    ).toBe(false);

    expect(
      conversationStateShowsTerminalResult(
        {
          ...emptyState,
          eventsByRunId: {
            [runA]: [
              event("42", runA, {
                type: "done",
                message: {
                  id: "40000000-0000-4000-8000-000000000042",
                  runId: runA,
                  role: "assistant",
                  content: "后台结果",
                  citations: [],
                  artifacts: [],
                  attachments: [],
                  feedback: null,
                  createdAt: "2026-08-24T08:01:00.000Z",
                },
                credits: {
                  available: 100,
                  reserved: 0,
                },
              }),
            ],
          },
        },
        runA,
        "42",
      ),
    ).toBe(true);

    expect(
      conversationStateShowsTerminalResult(
        {
          ...emptyState,
          messages: [
            {
              id: "40000000-0000-4000-8000-000000000043",
              runId: runA,
              role: "assistant",
              content: "已经渲染的回答",
              citations: [],
              artifacts: [],
              attachments: [],
              feedback: null,
              createdAt: "2026-08-24T08:01:00.000Z",
            },
          ],
        },
        runA,
        "42",
      ),
    ).toBe(true);

    expect(
      conversationStateShowsTerminalResult(
        {
          ...emptyState,
          runs: [
            {
              ...run(runA, conversationA),
              status: "failed",
              failure: { code: "FAILED", message: "后台运行失败" },
              finishedAt: "2026-08-24T08:01:00.000Z",
            },
          ],
        },
        runA,
        "42",
      ),
    ).toBe(true);
  });

  it("only commits credits from a newer terminal event", () => {
    expect(shouldCommitTerminalCredits("0", "42")).toBe(true);
    expect(shouldCommitTerminalCredits("42", "43")).toBe(true);
    expect(shouldCommitTerminalCredits("42", "42")).toBe(false);
    expect(shouldCommitTerminalCredits("43", "42")).toBe(false);
  });

  it("does not let terminal refresh 42 commit after refresh 43 starts", () => {
    let fence: string | null = null;
    fence = advanceConversationRefreshFence(fence, "42");
    expect(conversationRefreshIsCurrent(fence, "42")).toBe(true);

    fence = advanceConversationRefreshFence(fence, "43");
    expect(conversationRefreshIsCurrent(fence, "43")).toBe(true);
    expect(conversationRefreshIsCurrent(fence, "42")).toBe(false);

    fence = advanceConversationRefreshFence(fence, "42");
    expect(fence).toBe("43");
    expect(conversationRefreshIsCurrent(fence, "42")).toBe(false);
  });
});

describe("buildActivityItems", () => {
  it("按固定 key 聚合 reasoning、web search 和本地工具生命周期", () => {
    const events: RunEvent[] = [
      event("1", runA, {
        type: "reasoning",
        itemId: "reason-1",
        summaryIndex: 0,
        providerSequence: 10,
        text: "先确认",
      }),
      event("2", runA, {
        type: "reasoning",
        itemId: "reason-1",
        summaryIndex: 0,
        providerSequence: 11,
        text: "目标市场。",
      }),
      event("3", runA, {
        type: "web_search",
        callId: "search-1",
        phase: "in_progress",
        outputIndex: 0,
        providerSequence: 12,
        action: null,
      }),
      event("4", runA, {
        type: "web_search",
        callId: "search-1",
        phase: "completed",
        outputIndex: 0,
        providerSequence: 13,
        action: {
          type: "search",
          query: "German valve distributors",
          queries: ["German valve distributors"],
          sources: [
            { type: "url", url: "https://example.com/distributors" },
          ],
        },
      }),
      event("5", runA, {
        type: "tool_started",
        callId: "tool-1",
        toolName: "save_research_results",
        title: "保存客户清单",
        input: "5 家公司",
      }),
      event("6", runA, {
        type: "tool_completed",
        callId: "tool-1",
        toolName: "save_research_results",
        title: "客户清单已保存",
        output: "快照 snapshot-1",
      }),
      event("7", runA, { type: "delta", text: "最终回答" }),
    ];

    const items = buildActivityItems(events);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "reasoning",
      text: "先确认目标市场。",
    });
    expect(items[1]).toMatchObject({
      kind: "web_search",
      phase: "completed",
      action: {
        type: "search",
        queries: ["German valve distributors"],
      },
    });
    expect(items[2]).toMatchObject({
      kind: "tool",
      title: "客户清单已保存",
      input: "5 家公司",
      output: "快照 snapshot-1",
      completedAt: "2026-08-24T08:00:06.000Z",
    });
  });

  it.each([
    {
      code: "PROVIDER_ERROR",
      expectedOutcome: "failed",
    },
    {
      code: "RUN_CANCELLED",
      expectedOutcome: "interrupted",
    },
    {
      code: "RUN_REQUIRES_RECONCILIATION",
      expectedOutcome: "reconciliation_required",
    },
  ] as const)(
    "用 $code 终态关闭仍在运行的搜索和本地工具",
    ({ code, expectedOutcome }) => {
      const items = buildActivityItems([
        event("1", runA, {
          type: "web_search",
          callId: "search-open",
          phase: "searching",
          outputIndex: 0,
          providerSequence: 1,
          action: null,
        }),
        event("2", runA, {
          type: "tool_started",
          callId: "tool-open",
          toolName: "save_research_results",
          title: "保存客户清单",
          input: "5 家公司",
        }),
        event("3", runA, {
          type: "error",
          error: {
            code,
            message: "运行终止",
            runId: runA,
          },
        }),
      ]);

      expect(items[0]).toMatchObject({
        kind: "web_search",
        incompleteOutcome: expectedOutcome,
      });
      expect(items[1]).toMatchObject({
        kind: "tool",
        completedAt: null,
        incompleteOutcome: expectedOutcome,
      });
    },
  );

  it("用 done 终态把未闭合步骤标为已中断", () => {
    const items = buildActivityItems([
      event("1", runA, {
        type: "web_search",
        callId: "search-open",
        phase: "in_progress",
        outputIndex: 0,
        providerSequence: 1,
        action: null,
      }),
      event("2", runA, {
        type: "tool_started",
        callId: "tool-open",
        toolName: "create_csv_file",
        title: "生成通用 CSV 文件",
        input: "表格内容",
      }),
      event("3", runA, {
        type: "done",
        message: message({
          id: "40000000-0000-4000-8000-000000000099",
          runId: runA,
          role: "assistant",
          content: "研究完成",
          createdAt: "2026-08-24T08:00:03.000Z",
        }),
        credits: { available: 90, reserved: 0 },
      }),
    ]);

    expect(items[0]).toMatchObject({
      kind: "web_search",
      incompleteOutcome: "interrupted",
    });
    expect(items[1]).toMatchObject({
      kind: "tool",
      completedAt: null,
      incompleteOutcome: "interrupted",
    });
  });

  it("不覆盖终态之前已经闭合的搜索和本地工具", () => {
    const items = buildActivityItems([
      event("1", runA, {
        type: "web_search",
        callId: "search-closed",
        phase: "completed",
        outputIndex: 0,
        providerSequence: 1,
        action: {
          type: "search",
          query: "German valve distributors",
          queries: ["German valve distributors"],
          sources: [],
        },
      }),
      event("2", runA, {
        type: "tool_started",
        callId: "tool-closed",
        toolName: "save_research_results",
        title: "保存客户清单",
        input: "5 家公司",
      }),
      event("3", runA, {
        type: "tool_completed",
        callId: "tool-closed",
        toolName: "save_research_results",
        title: "客户清单已保存",
        output: "快照 snapshot-1",
      }),
      event("4", runA, {
        type: "error",
        error: {
          code: "PROVIDER_ERROR",
          message: "后续回答失败",
          runId: runA,
        },
      }),
    ]);

    expect(items[0]).toMatchObject({
      kind: "web_search",
      phase: "completed",
      incompleteOutcome: null,
    });
    expect(items[1]).toMatchObject({
      kind: "tool",
      completedAt: "2026-08-24T08:00:03.000Z",
      incompleteOutcome: null,
    });
  });
});

describe("shouldSubscribeToRun", () => {
  it("订阅尚未加载详情的 active run", () => {
    expect(shouldSubscribeToRun(undefined, [], "not_loaded")).toBe(true);
    expect(runEventSubscriptionMode(undefined, [], "not_loaded")).toBe(
      "follow",
    );
  });

  it("waiting Run 尚未获得执行权时不订阅 SSE", () => {
    const waitingRun: AgentRun = {
      ...run(runA, conversationA),
      status: "waiting",
      startedAt: null,
    };

    expect(runEventSubscriptionMode(waitingRun, [], "not_loaded")).toBe(
      "none",
    );
    expect(shouldSubscribeToRun(waitingRun, [], "not_loaded")).toBe(false);
  });

  it.each(["queued", "running"] as const)(
    "%s Run 使用 follow 模式持续订阅",
    (status) => {
      const activeRun: AgentRun = {
        ...run(runA, conversationA),
        status,
        startedAt:
          status === "queued" ? null : "2026-08-24T08:00:01.000Z",
      };

      expect(runEventSubscriptionMode(activeRun, [], "not_loaded")).toBe(
        "follow",
      );
      expect(shouldSubscribeToRun(activeRun, [], "not_loaded")).toBe(true);
    },
  );

  it.each([
    "completed",
    "failed",
    "cancelled",
    "reconciliation_required",
  ] as const)("%s Run 首次加载时仅回放一次", (status) => {
    const terminalRun: AgentRun = {
      ...run(runA, conversationA),
      status,
      finishedAt: "2026-08-24T08:01:00.000Z",
    };

    expect(runEventSubscriptionMode(terminalRun, [], "not_loaded")).toBe(
      "replay_once",
    );
    expect(shouldSubscribeToRun(terminalRun, [], "not_loaded")).toBe(true);
  });

  it.each(["replaying", "loaded", "failed"] as const)(
    "%s 状态不建立重复订阅",
    (replayState) => {
      const runningRun = run(runA, conversationA);

      expect(runEventSubscriptionMode(runningRun, [], replayState)).toBe(
        "none",
      );
      expect(shouldSubscribeToRun(runningRun, [], replayState)).toBe(false);
    },
  );

  it("已完成的历史 Run 首次打开时执行一次持久活动回放", () => {
    const completedRun: AgentRun = {
      ...run(runA, conversationA),
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    expect(
      shouldSubscribeToRun(completedRun, [], "not_loaded"),
    ).toBe(true);
    expect(
      runEventSubscriptionMode(completedRun, [], "not_loaded"),
    ).toBe("replay_once");
  });

  it("历史 Run 回放完成后不重复订阅", () => {
    const completedRun: AgentRun = {
      ...run(runA, conversationA),
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    expect(
      shouldSubscribeToRun(completedRun, [], "loaded"),
    ).toBe(false);
    expect(runEventSubscriptionMode(completedRun, [], "loaded")).toBe("none");
  });

  it("回放进行中时不建立重复订阅", () => {
    expect(
      shouldSubscribeToRun(run(runA, conversationA), [], "replaying"),
    ).toBe(false);
  });

  it("按取消 error 立即识别为已停止，而不是失败", () => {
    const running = run(runA, conversationA);
    expect(
      effectiveRunStatus(running, [
        event("1", runA, {
          type: "error",
          error: {
            code: "RUN_CANCELLED",
            message: "运行已停止。",
            runId: runA,
          },
        }),
      ]),
    ).toBe("cancelled");
  });
});

describe("loaded conversation run subscriptions", () => {
  it("加载会话时跟随活动 Run，并自动回放当前选中的终态 Run", () => {
    const completedRun: AgentRun = {
      ...run(runA, conversationA),
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    const failedRun: AgentRun = {
      ...run(runB, conversationA),
      status: "failed",
      failure: { code: "PROVIDER_ERROR", message: "研究失败。" },
      finishedAt: "2026-08-24T08:02:00.000Z",
    };
    const cancelledRun: AgentRun = {
      ...run("20000000-0000-4000-8000-000000000003", conversationA),
      status: "cancelled",
      failure: { code: "RUN_CANCELLED", message: "运行已停止。" },
      finishedAt: "2026-08-24T08:03:00.000Z",
    };
    const existingEvent = event("1", runA, {
      type: "status",
      phase: "thinking",
      message: "分析中",
    });
    const state = {
      ...createConversationViewState(),
      eventsByRunId: { [runA]: [existingEvent] },
    };
    const runningRun: AgentRun = {
      ...run("20000000-0000-4000-8000-000000000004", conversationA),
      status: "running",
      startedAt: "2026-08-24T08:04:00.000Z",
    };

    const requests = loadedRunSubscriptionRequests(
      state,
      [completedRun, failedRun, cancelledRun, runningRun],
      completedRun.id,
      new Map(),
    );

    expect(requests).toEqual([
      {
        run: completedRun,
        existingEvents: [existingEvent],
        intent: "activity",
      },
      { run: runningRun, existingEvents: [], intent: "active" },
    ]);
  });

  it("不会为已完成回放的当前 Run 重复建立订阅", () => {
    const completedRun: AgentRun = {
      ...run(runA, conversationA),
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    };

    expect(
      loadedRunSubscriptionRequests(
        undefined,
        [completedRun],
        completedRun.id,
        new Map([[completedRun.id, "loaded"]]),
      ),
    ).toEqual([]);
  });

  it("不会预载未选中的历史终态 Run", () => {
    const selectedRun: AgentRun = {
      ...run(runA, conversationA),
      status: "completed",
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    const historicalRun: AgentRun = {
      ...run(runB, conversationA),
      status: "failed",
      failure: { code: "PROVIDER_ERROR", message: "研究失败。" },
      finishedAt: "2026-08-24T08:00:30.000Z",
    };

    expect(
      loadedRunSubscriptionRequests(
        undefined,
        [historicalRun, selectedRun],
        selectedRun.id,
        new Map(),
      ),
    ).toEqual([
      { run: selectedRun, existingEvents: [], intent: "activity" },
    ]);
  });
});

describe("run selection", () => {
  const firstRun = run(runA, conversationA);
  const secondRun = run(runB, conversationA);
  const state = {
    ...createConversationViewState(),
    runs: [firstRun, secondRun],
  };

  it("显式选择历史 Run 时不会回退到当前或最新 Run", () => {
    expect(activityRunForSelection(state, firstRun.id, secondRun)).toBe(firstRun);
    expect(
      activityRunForSelection(
        state,
        "20000000-0000-4000-8000-000000000099",
        secondRun,
      ),
    ).toBeNull();
    expect(activityRunForSelection(state, null, secondRun)).toBe(secondRun);
  });

  it("每条消息只绑定自身的 runId", () => {
    const firstMessage = {
      id: "40000000-0000-4000-8000-000000000001",
      runId: firstRun.id,
      role: "user" as const,
      content: "第一条研究请求",
      citations: [],
      artifacts: [],
      attachments: [],
      feedback: null,
      createdAt: "2026-08-24T08:00:00.000Z",
    };
    const secondMessage = {
      ...firstMessage,
      id: "40000000-0000-4000-8000-000000000002",
      runId: secondRun.id,
      role: "assistant" as const,
      content: "第二次运行结果",
    };

    expect(runForMessage(state, firstMessage)).toBe(firstRun);
    expect(runForMessage(state, secondMessage)).toBe(secondRun);
  });
});

describe("terminalRunsWithoutAssistantMessages", () => {
  it("waiting Run 不会被误当作失败终态卡", () => {
    const waitingRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: "40000000-0000-4000-8000-000000000020",
      assistantMessageId: "50000000-0000-4000-8000-000000000020",
      status: "waiting",
      startedAt: null,
    };
    const state = {
      ...createConversationViewState(),
      runs: [waitingRun],
    };

    expect(terminalRunsWithoutAssistantMessages(state)).toEqual([]);
  });

  it("把无 assistant 消息的失败 Run 放在对应 user 消息后", () => {
    const userMessageId = "40000000-0000-4000-8000-000000000001";
    const failedRun: AgentRun = {
      ...run(runA, conversationA),
      inputMessageId: userMessageId,
      assistantMessageId: "40000000-0000-4000-8000-000000000002",
      status: "failed",
      failure: { code: "INTERNAL_ERROR", message: "研究失败。" },
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    const state = {
      ...createConversationViewState(),
      messages: [
        {
          id: userMessageId,
          runId: runA,
          role: "user" as const,
          content: "查找德国买家",
          citations: [],
          artifacts: [],
          attachments: [],
          feedback: null,
          createdAt: "2026-08-24T08:00:00.000Z",
        },
      ],
      runs: [failedRun],
    };

    expect(terminalRunsWithoutAssistantMessages(state)).toEqual([
      { run: failedRun, afterUserMessageId: userMessageId },
    ]);
  });

  it("已有 assistant 消息时不额外渲染终态卡", () => {
    const assistantMessageId = "40000000-0000-4000-8000-000000000002";
    const failedRun: AgentRun = {
      ...run(runA, conversationA),
      assistantMessageId,
      status: "failed",
      failure: { code: "INTERNAL_ERROR", message: "研究失败。" },
      finishedAt: "2026-08-24T08:01:00.000Z",
    };
    const state = {
      ...createConversationViewState(),
      messages: [
        {
          id: assistantMessageId,
          runId: runA,
          role: "assistant" as const,
          content: "部分回答",
          citations: [],
          artifacts: [],
          attachments: [],
          feedback: null,
          createdAt: "2026-08-24T08:00:30.000Z",
        },
      ],
      runs: [failedRun],
    };

    expect(terminalRunsWithoutAssistantMessages(state)).toEqual([]);
  });
});

describe("waiting and retry eligibility", () => {
  it("detects waiting and active runs as outstanding from local state", () => {
    const waiting = { ...run(runA, conversationA), status: "waiting" as const };
    const running = { ...run(runB, conversationA), status: "running" as const };
    const completed = {
      ...run("20000000-0000-4000-8000-000000000099", conversationA),
      status: "completed" as const,
    };

    expect(
      conversationStateHasOutstandingRuns(
        { ...createConversationViewState(), runs: [waiting] },
      ),
    ).toBe(true);
    expect(
      conversationStateHasOutstandingRuns(
        { ...createConversationViewState(), runs: [running] },
      ),
    ).toBe(true);
    expect(
      conversationStateHasOutstandingRuns(
        { ...createConversationViewState(), runs: [completed] },
      ),
    ).toBe(false);
    expect(conversationStateHasOutstandingRuns(undefined)).toBe(false);
  });

  const inputA = "40000000-0000-4000-8000-000000000031";
  const inputB = "40000000-0000-4000-8000-000000000032";
  const inputC = "40000000-0000-4000-8000-000000000033";
  const failedA: AgentRun = {
    ...run(runA, conversationA),
    inputMessageId: inputA,
    assistantMessageId: "50000000-0000-4000-8000-000000000031",
    status: "failed",
    failure: { code: "INTERNAL_ERROR", message: "A failed" },
    finishedAt: "2026-08-24T08:01:00.000Z",
  };
  const waitingB: AgentRun = {
    ...run(runB, conversationA),
    inputMessageId: inputB,
    assistantMessageId: "50000000-0000-4000-8000-000000000032",
    status: "waiting",
    conversationTurn: "2",
    predecessorRunId: failedA.id,
    startedAt: null,
  };
  const waitingC: AgentRun = {
    ...run("20000000-0000-4000-8000-000000000003", conversationA),
    inputMessageId: inputC,
    assistantMessageId: "50000000-0000-4000-8000-000000000033",
    status: "waiting",
    conversationTurn: "3",
    predecessorRunId: waitingB.id,
    startedAt: null,
  };

  it("沿 predecessor 链把后续 waiting Turn 标记为暂停", () => {
    const state = {
      ...createConversationViewState(),
      runs: [failedA, waitingB, waitingC],
    };

    expect(waitingRunIsBlocked(state, waitingB)).toBe(true);
    expect(waitingRunIsBlocked(state, waitingC)).toBe(true);
  });

  it("前序仍在执行时保持等待而不是误报暂停", () => {
    const runningA = {
      ...failedA,
      status: "running" as const,
      failure: null,
      finishedAt: null,
    };
    const state = {
      ...createConversationViewState(),
      runs: [runningA, waitingB, waitingC],
    };

    expect(waitingRunIsBlocked(state, waitingB)).toBe(false);
    expect(waitingRunIsBlocked(state, waitingC)).toBe(false);
  });

  it("只允许最新 failed/cancelled attempt 且没有已开始 successor 时重试", () => {
    const stateWithWaitingSuccessor = {
      ...createConversationViewState(),
      runs: [failedA, waitingB],
    };
    expect(canRetryRun(stateWithWaitingSuccessor, failedA)).toBe(true);

    const cancelledSuccessor = {
      ...waitingB,
      status: "cancelled" as const,
      failure: { code: "RUN_CANCELLED", message: "cancelled" },
      finishedAt: "2026-08-24T08:02:00.000Z",
    };
    expect(
      canRetryRun(
        {
          ...createConversationViewState(),
          runs: [failedA, cancelledSuccessor],
        },
        failedA,
      ),
    ).toBe(false);

    const retryA: AgentRun = {
      ...failedA,
      id: "20000000-0000-4000-8000-000000000004",
      requestId: "30000000-0000-4000-8000-000000000004",
      attemptIndex: 2,
      retryOfRunId: failedA.id,
      status: "queued",
      failure: null,
      finishedAt: null,
    };
    expect(
      canRetryRun(
        {
          ...createConversationViewState(),
          runs: [failedA, retryA],
        },
        failedA,
      ),
    ).toBe(false);
  });
});
