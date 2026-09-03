import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapturedRunExecutionConfig, ChatStartResponse } from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import {
  TEST_CAPTURED_RUN_EXECUTION_CONFIG,
  TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
} from "@/tests/fixtures/run-config";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  request: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
  userMessage: "55555555-5555-4555-8555-555555555555",
  assistantMessage: "66666666-6666-4666-8666-666666666666",
};

const mocks = vi.hoisted(() => ({
  enqueueChatRun: vi.fn(),
  getCurrentUserId: vi.fn(),
  getEnv: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/env", () => ({
  getEnv: mocks.getEnv,
}));

vi.mock("@/lib/runs", () => ({
  enqueueChatRun: mocks.enqueueChatRun,
}));

vi.mock("@/lib/chat/runtime", () => {
  throw new Error("POST /api/chat must not load or execute the agent runtime");
});

import { POST } from "@/app/api/chat/route";

const startedAt = "2026-08-24T08:00:00.000Z";
const executionConfig = {
  ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
  billing: {
    ...TEST_CAPTURED_RUN_EXECUTION_CONFIG.billing,
    reservationCredits: 500,
  },
} satisfies CapturedRunExecutionConfig;
const responseBody: ChatStartResponse = {
  conversation: {
    id: ids.conversation,
    title: "泵类买家研究",
    updatedAt: startedAt,
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: ids.run,
    activeRun: {
      id: ids.run,
      status: "queued",
      startedAt: null,
    },
    waitingRunCount: 0,
    attention: null,
  },
  userMessage: {
    id: ids.userMessage,
    runId: ids.run,
    role: "user",
    content: "寻找德国工业泵买家",
    citations: [],
    artifacts: [],
    attachments: [],
    feedback: null,
    createdAt: startedAt,
  },
  run: {
    id: ids.run,
    requestId: ids.request,
    conversationId: ids.conversation,
    inputMessageId: ids.userMessage,
    assistantMessageId: ids.assistantMessage,
    status: "queued",
    conversationTurn: "1",
    attemptIndex: 1,
    predecessorRunId: null,
    retryOfRunId: null,
    regenerateOfRunId: null,
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
    failure: null,
    createdAt: startedAt,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
  },
  credits: { available: 9_500, reserved: 500 },
};

function request(body: unknown = {
  kind: "append",
  conversationId: ids.conversation,
  parentRunId: ids.run,
  message: "寻找德国工业泵买家",
  attachmentIds: [],
  requestId: ids.request,
  executionProfileId: "standard_research",
}): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.getCurrentUserId.mockReset().mockReturnValue(ids.user);
  mocks.getEnv.mockReset().mockReturnValue({
    RUN_RESERVATION_CREDITS: 500,
    OPENAI_PROVIDER: "openai",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_MODEL: "gpt-5.2",
    OPENAI_REASONING_MODE_ENABLED: false,
    CREDITS_PER_1K_INPUT_TOKENS: 1,
    CREDITS_PER_1K_OUTPUT_TOKENS: 5,
    CREDITS_PER_WEB_SEARCH: 10,
    INPUT_ATTACHMENT_MAX_PER_MESSAGE: 5,
    INPUT_ATTACHMENT_MAX_TOTAL_BYTES: 20 * 1024 * 1024,
  });
  mocks.enqueueChatRun.mockReset().mockResolvedValue(responseBody);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/chat", () => {
  it("atomically enqueues a durable run and immediately returns 202 JSON", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(mocks.enqueueChatRun).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueChatRun).toHaveBeenCalledWith({
      userId: ids.user,
      request: {
        kind: "append",
        conversationId: ids.conversation,
        parentRunId: ids.run,
        message: "寻找德国工业泵买家",
        attachmentIds: [],
        requestId: ids.request,
        executionProfileId: "standard_research",
      },
      executionConfig,
      maxAttachmentCount: 5,
      maxAttachmentTotalBytes: 20 * 1024 * 1024,
    });
  });

  it("returns the fixed JSON error when enqueueing fails", async () => {
    mocks.enqueueChatRun.mockRejectedValue(
      new AppError("INSUFFICIENT_CREDITS", "积分不足。", 402),
    );

    const response = await POST(request());

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INSUFFICIENT_CREDITS", message: "积分不足。" },
    });
  });

  it("rejects an invalid request before creating a run", async () => {
    const response = await POST(
      request({
        kind: "append",
        conversationId: ids.conversation,
        parentRunId: ids.run,
        message: "   ",
        attachmentIds: [],
        requestId: ids.request,
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.enqueueChatRun).not.toHaveBeenCalled();
  });
});
