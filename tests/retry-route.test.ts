import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RetryRunResponse } from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  sourceRun: "33333333-3333-4333-8333-333333333333",
  retryRun: "44444444-4444-4444-8444-444444444444",
  request: "55555555-5555-4555-8555-555555555555",
  inputMessage: "66666666-6666-4666-8666-666666666666",
  assistantMessage: "77777777-7777-4777-8777-777777777777",
};

const mocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  getEnv: vi.fn(),
  retryAgentRun: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/env", () => ({
  getEnv: mocks.getEnv,
}));

vi.mock("@/lib/runs", () => ({
  retryAgentRun: mocks.retryAgentRun,
}));

import { POST } from "@/app/api/runs/[runId]/retry/route";

const now = "2026-08-25T08:00:00.000Z";
const responseBody: RetryRunResponse = {
  conversation: {
    id: ids.conversation,
    title: "German pump buyers",
    updatedAt: now,
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: ids.retryRun,
    activeRun: {
      id: ids.retryRun,
      status: "queued",
      startedAt: null,
    },
    waitingRunCount: 0,
    attention: null,
  },
  run: {
    id: ids.retryRun,
    requestId: ids.request,
    conversationId: ids.conversation,
    inputMessageId: ids.inputMessage,
    assistantMessageId: ids.assistantMessage,
    status: "queued",
    conversationTurn: "1",
    attemptIndex: 2,
    predecessorRunId: null,
    retryOfRunId: ids.sourceRun,
    regenerateOfRunId: null,
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
    failure: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
  },
  credits: { available: 900, reserved: 100 },
};

function request(body: unknown): Request {
  return new Request(`http://localhost/api/runs/${ids.sourceRun}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.getEnv.mockReturnValue({ RUN_RESERVATION_CREDITS: 100 });
  mocks.retryAgentRun.mockResolvedValue(responseBody);
});

describe("POST /api/runs/[runId]/retry", () => {
  it("returns the fixed retry response with 202", async () => {
    const response = await POST(
      request({ requestId: ids.request }),
      { params: Promise.resolve({ runId: ids.sourceRun }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(mocks.retryAgentRun).toHaveBeenCalledWith({
      userId: ids.user,
      sourceRunId: ids.sourceRun,
      requestId: ids.request,
    });
  });

  it("rejects extra request fields before calling the repository", async () => {
    const response = await POST(
      request({ requestId: ids.request, sourceRunId: ids.sourceRun }),
      { params: Promise.resolve({ runId: ids.sourceRun }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
    expect(mocks.retryAgentRun).not.toHaveBeenCalled();
  });

  it("returns the fixed reconciliation error", async () => {
    mocks.retryAgentRun.mockRejectedValue(
      new AppError(
        "RUN_REQUIRES_RECONCILIATION",
        "Run requires credit reconciliation and cannot be retried",
        409,
      ),
    );
    const response = await POST(
      request({ requestId: ids.request }),
      { params: Promise.resolve({ runId: ids.sourceRun }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RUN_REQUIRES_RECONCILIATION",
        message: "Run requires credit reconciliation and cannot be retried",
      },
    });
  });
});
