import { describe, expect, it, vi } from "vitest";

import { ApiClientError } from "@/components/api-client";
import { isTransientApiError } from "@/components/run-event-retry";
import {
  mergeTerminalConversationSummary,
  refreshTerminalSources,
  type TerminalRefreshSource,
} from "@/components/terminal-refresh";
import {
  BootstrapResponseSchema,
  type BootstrapResponse,
  type ConversationResponse,
} from "@/lib/contracts";
import { TEST_EXECUTION_PROFILE_CATALOG } from "@/tests/fixtures/run-config";

const conversationId = "10000000-0000-4000-8000-000000000001";
const runId = "20000000-0000-4000-8000-000000000001";
const successorRunId = "20000000-0000-4000-8000-000000000002";

const detail: ConversationResponse = {
  conversation: {
    id: conversationId,
    title: "后台运行",
    updatedAt: "2026-08-26T08:00:00.000Z",
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: runId,
    activeRun: null,
    waitingRunCount: 0,
    attention: {
      terminalEventId: "42",
      runId,
      status: "completed",
      finishedAt: "2026-08-26T08:00:00.000Z",
    },
  },
  messages: [],
  runs: [],
};

const bootstrap: BootstrapResponse = {
  user: {
    id: "30000000-0000-4000-8000-000000000001",
    name: "测试用户",
  },
  credits: { available: 88, reserved: 0 },
  conversations: [detail.conversation],
  nextCursor: null,
  trackedConversations: [],
  inputAttachmentLimits: {
    maxFileBytes: 10 * 1024 * 1024,
    maxFilesPerMessage: 5,
    maxTotalBytesPerMessage: 20 * 1024 * 1024,
  },
  executionProfiles: TEST_EXECUTION_PROFILE_CATALOG,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type RetryOverrides = {
  loadConversation?: (signal: AbortSignal) => Promise<ConversationResponse>;
  loadBootstrap?: (signal: AbortSignal) => Promise<BootstrapResponse>;
  isCurrent?: () => boolean;
  shouldRefreshBootstrap?: () => boolean;
  afterConversationCommit?: (detail: ConversationResponse) => void;
  afterBootstrapCommit?: (bootstrap: BootstrapResponse) => void;
  afterWait?: (
    source: TerminalRefreshSource,
    consecutiveFailures: number,
    signal: AbortSignal,
  ) => Promise<void>;
};

function retryHarness(overrides: RetryOverrides = {}) {
  const controller = new AbortController();
  const committed: TerminalRefreshSource[] = [];
  const permanentFailures: Array<{
    source: TerminalRefreshSource;
    error: unknown;
  }> = [];
  const waits: Array<[TerminalRefreshSource, number]> = [];
  return {
    controller,
    committed,
    permanentFailures,
    waits,
    options: {
      signal: controller.signal,
      isCurrent: overrides.isCurrent ?? (() => true),
      shouldRefreshBootstrap:
        overrides.shouldRefreshBootstrap ?? (() => true),
      loadConversation:
        overrides.loadConversation ?? (async () => detail),
      loadBootstrap: overrides.loadBootstrap ?? (async () => bootstrap),
      commitConversation: (nextDetail: ConversationResponse) => {
        committed.push("conversation");
        overrides.afterConversationCommit?.(nextDetail);
      },
      commitBootstrap: (nextBootstrap: BootstrapResponse) => {
        committed.push("bootstrap");
        overrides.afterBootstrapCommit?.(nextBootstrap);
      },
      isRetryable: isTransientApiError,
      waitBeforeRetry: async (
        source: TerminalRefreshSource,
        consecutiveFailures: number,
        signal: AbortSignal,
      ) => {
        waits.push([source, consecutiveFailures]);
        await overrides.afterWait?.(
          source,
          consecutiveFailures,
          signal,
        );
      },
      onPermanentFailure: (
        source: TerminalRefreshSource,
        error: unknown,
      ) => {
        permanentFailures.push({ source, error });
      },
    },
  };
}

function contractError(): Error {
  const result = BootstrapResponseSchema.safeParse({});
  if (result.success) {
    throw new Error("无效 Bootstrap fixture 意外通过了契约校验");
  }
  return result.error;
}

describe("terminal source refresh", () => {
  it("bootstrap 成功时不会等待 conversation 的瞬态失败重试", async () => {
    const allowConversationRetryToFinish = deferred();
    const bootstrapCommitted = deferred();
    const conversationRetryStarted = deferred();
    let conversationCalls = 0;
    const harness = retryHarness({
      loadConversation: async () => {
        conversationCalls += 1;
        if (conversationCalls === 1) {
          throw new TypeError("temporary network failure");
        }
        conversationRetryStarted.resolve();
        await allowConversationRetryToFinish.promise;
        return detail;
      },
      afterBootstrapCommit: () => bootstrapCommitted.resolve(),
    });

    const refreshing = refreshTerminalSources(harness.options);
    await Promise.all([
      bootstrapCommitted.promise,
      conversationRetryStarted.promise,
    ]);

    expect(conversationCalls).toBe(2);
    expect(harness.committed).toEqual(["bootstrap"]);
    expect(harness.waits).toEqual([["conversation", 1]]);

    allowConversationRetryToFinish.resolve();
    await refreshing;

    expect(harness.committed).toEqual(["bootstrap", "conversation"]);
    expect(harness.permanentFailures).toEqual([]);
  });

  it("conversation 成功时不会等待 bootstrap 的瞬态失败重试", async () => {
    const allowBootstrapRetryToFinish = deferred();
    const conversationCommitted = deferred();
    const bootstrapRetryStarted = deferred();
    let bootstrapCalls = 0;
    const harness = retryHarness({
      loadBootstrap: async () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) {
          throw new ApiClientError("INTERNAL", "temporary failure", 503);
        }
        bootstrapRetryStarted.resolve();
        await allowBootstrapRetryToFinish.promise;
        return bootstrap;
      },
      afterConversationCommit: () => conversationCommitted.resolve(),
    });

    const refreshing = refreshTerminalSources(harness.options);
    await Promise.all([
      conversationCommitted.promise,
      bootstrapRetryStarted.promise,
    ]);

    expect(bootstrapCalls).toBe(2);
    expect(harness.committed).toEqual(["conversation"]);
    expect(harness.waits).toEqual([["bootstrap", 1]]);

    allowBootstrapRetryToFinish.resolve();
    await refreshing;

    expect(harness.committed).toEqual(["conversation", "bootstrap"]);
    expect(harness.permanentFailures).toEqual([]);
  });

  it("signal 在瞬态失败完成前 abort 后既不提交也不重试", async () => {
    let conversationCalls = 0;
    const harness = retryHarness({
      shouldRefreshBootstrap: () => false,
      loadConversation: async () => {
        conversationCalls += 1;
        harness.controller.abort();
        throw new TypeError("request aborted");
      },
    });

    await refreshTerminalSources(harness.options);

    expect(conversationCalls).toBe(1);
    expect(harness.committed).toEqual([]);
    expect(harness.waits).toEqual([]);
    expect(harness.permanentFailures).toEqual([]);
  });

  it("terminal fence 在瞬态失败完成前变旧后既不提交也不重试", async () => {
    let current = true;
    let conversationCalls = 0;
    const harness = retryHarness({
      isCurrent: () => current,
      shouldRefreshBootstrap: () => false,
      loadConversation: async () => {
        conversationCalls += 1;
        current = false;
        throw new TypeError("stale request failed");
      },
    });

    await refreshTerminalSources(harness.options);

    expect(conversationCalls).toBe(1);
    expect(harness.committed).toEqual([]);
    expect(harness.waits).toEqual([]);
    expect(harness.permanentFailures).toEqual([]);
  });

  it("terminal fence 在成功响应返回前变旧后不提交", async () => {
    let current = true;
    const harness = retryHarness({
      isCurrent: () => current,
      shouldRefreshBootstrap: () => false,
      loadConversation: async () => {
        current = false;
        return detail;
      },
    });

    await refreshTerminalSources(harness.options);

    expect(harness.committed).toEqual([]);
    expect(harness.waits).toEqual([]);
  });

  it("响应契约错误是永久错误且不会重试", async () => {
    const error = contractError();
    const loadConversation = vi.fn(async (): Promise<ConversationResponse> => {
      throw error;
    });
    const harness = retryHarness({
      shouldRefreshBootstrap: () => false,
      loadConversation,
    });

    await refreshTerminalSources(harness.options);

    expect(loadConversation).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([]);
    expect(harness.committed).toEqual([]);
    expect(harness.permanentFailures).toEqual([
      { source: "conversation", error },
    ]);
  });

  it("4xx API 错误是永久错误且不会阻塞另一来源提交", async () => {
    const error = new ApiClientError("NOT_FOUND", "missing", 404);
    const loadBootstrap = vi.fn(async (): Promise<BootstrapResponse> => {
      throw error;
    });
    const harness = retryHarness({ loadBootstrap });

    await refreshTerminalSources(harness.options);

    expect(loadBootstrap).toHaveBeenCalledTimes(1);
    expect(harness.waits).toEqual([]);
    expect(harness.committed).toEqual(["conversation"]);
    expect(harness.permanentFailures).toEqual([
      { source: "bootstrap", error },
    ]);
  });

  it("新的 terminal credits 已提交时跳过旧 bootstrap 请求", async () => {
    const loadBootstrap = vi.fn(async () => bootstrap);
    const harness = retryHarness({
      loadBootstrap,
      shouldRefreshBootstrap: () => false,
    });

    await refreshTerminalSources(harness.options);

    expect(loadBootstrap).not.toHaveBeenCalled();
    expect(harness.committed).toEqual(["conversation"]);
  });

  it("bootstrap 请求期间出现新的积分写入时丢弃迟到响应", async () => {
    const bootstrapStarted = deferred();
    const allowBootstrapResponse = deferred();
    let shouldRefreshBootstrap = true;
    const harness = retryHarness({
      shouldRefreshBootstrap: () => shouldRefreshBootstrap,
      loadBootstrap: async () => {
        bootstrapStarted.resolve();
        await allowBootstrapResponse.promise;
        return bootstrap;
      },
    });

    const refreshing = refreshTerminalSources(harness.options);
    await bootstrapStarted.promise;
    shouldRefreshBootstrap = false;
    allowBootstrapResponse.resolve();
    await refreshing;

    expect(harness.committed).toEqual(["conversation"]);
  });

  it("旧 terminal 的晚到 conversation 快照不能清掉已提交的 successor activeRun", () => {
    const successorActiveRun = {
      id: successorRunId,
      status: "queued" as const,
      startedAt: null,
    };
    const current = {
      ...detail.conversation,
      activeRun: successorActiveRun,
    };
    const incoming = {
      ...detail.conversation,
      title: "服务端新标题",
      updatedAt: "2026-08-26T08:02:00.000Z",
      waitingRunCount: 2,
      attention: null,
    };

    const updated = mergeTerminalConversationSummary(
      current,
      incoming,
      runId,
    );

    expect(updated).toEqual({ ...incoming, activeRun: successorActiveRun });
    expect(updated.activeRun).toBe(successorActiveRun);

    const staleTerminalSnapshot = {
      ...incoming,
      activeRun: {
        id: runId,
        status: "running" as const,
        startedAt: "2026-08-26T07:59:00.000Z",
      },
    };
    expect(
      mergeTerminalConversationSummary(
        current,
        staleTerminalSnapshot,
        runId,
      ).activeRun,
    ).toBe(successorActiveRun);
  });

  it("当前 activeRun 仍是旧 terminal Run 时允许服务端清空或替换", () => {
    const current = {
      ...detail.conversation,
      activeRun: {
        id: runId,
        status: "running" as const,
        startedAt: "2026-08-26T07:59:00.000Z",
      },
    };
    const cleared = mergeTerminalConversationSummary(
      current,
      detail.conversation,
      runId,
    );
    const incomingSuccessor = {
      ...detail.conversation,
      activeRun: {
        id: successorRunId,
        status: "queued" as const,
        startedAt: null,
      },
    };

    expect(cleared).toBe(detail.conversation);
    expect(
      mergeTerminalConversationSummary(current, incomingSuccessor, runId),
    ).toBe(incomingSuccessor);
  });

  it("服务端已从 successor A 推进到 successor B 时采用 B", () => {
    const currentSuccessor = {
      ...detail.conversation,
      activeRun: {
        id: successorRunId,
        status: "running" as const,
        startedAt: "2026-08-26T08:01:00.000Z",
      },
    };
    const incomingSuccessor = {
      ...detail.conversation,
      activeRun: {
        id: "20000000-0000-4000-8000-000000000003",
        status: "queued" as const,
        startedAt: null,
      },
    };

    expect(
      mergeTerminalConversationSummary(
        currentSuccessor,
        incomingSuccessor,
        runId,
      ),
    ).toBe(incomingSuccessor);
  });
});
