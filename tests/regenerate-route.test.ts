import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RegenerateRunResponse } from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  sourceRun: "33333333-3333-4333-8333-333333333333",
  regenerateRun: "44444444-4444-4444-8444-444444444444",
  request: "55555555-5555-4555-8555-555555555555",
  inputMessage: "66666666-6666-4666-8666-666666666666",
  assistantMessage: "77777777-7777-4777-8777-777777777777",
};

const mocks = vi.hoisted(() => ({
  getCurrentUserId: vi.fn(),
  getEnv: vi.fn(),
  regenerateAgentRun: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/env", () => ({
  getEnv: mocks.getEnv,
}));

vi.mock("@/lib/runs", () => ({
  regenerateAgentRun: mocks.regenerateAgentRun,
}));

import { POST } from "@/app/api/runs/[runId]/regenerate/route";

const now = "2026-08-26T08:00:00.000Z";
const responseBody: RegenerateRunResponse = {
  conversation: {
    id: ids.conversation,
    title: "German pump buyers",
    updatedAt: now,
    pinnedAt: null,
    archivedAt: null,
    selectedRunId: ids.regenerateRun,
    activeRun: {
      id: ids.regenerateRun,
      status: "queued",
      startedAt: null,
    },
    waitingRunCount: 0,
    attention: null,
  },
  run: {
    id: ids.regenerateRun,
    requestId: ids.request,
    conversationId: ids.conversation,
    inputMessageId: ids.inputMessage,
    assistantMessageId: ids.assistantMessage,
    status: "queued",
    conversationTurn: "1",
    attemptIndex: 2,
    predecessorRunId: null,
    retryOfRunId: null,
    regenerateOfRunId: ids.sourceRun,
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
  return new Request(
    `http://localhost/api/runs/${ids.sourceRun}/regenerate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.getEnv.mockReturnValue({ RUN_RESERVATION_CREDITS: 100 });
  mocks.regenerateAgentRun.mockResolvedValue(responseBody);
});

describe("POST /api/runs/[runId]/regenerate", () => {
  it("returns the fixed regenerate response with 202", async () => {
    const response = await POST(request({ requestId: ids.request }), {
      params: Promise.resolve({ runId: ids.sourceRun }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(responseBody);
    expect(mocks.regenerateAgentRun).toHaveBeenCalledWith({
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
    expect(mocks.regenerateAgentRun).not.toHaveBeenCalled();
  });

  it("returns the fixed context-unavailable error", async () => {
    mocks.regenerateAgentRun.mockRejectedValue(
      new AppError(
        "RUN_CONTEXT_UNAVAILABLE",
        "Run regeneration context is unavailable",
        409,
      ),
    );
    const response = await POST(request({ requestId: ids.request }), {
      params: Promise.resolve({ runId: ids.sourceRun }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RUN_CONTEXT_UNAVAILABLE",
        message: "Run regeneration context is unavailable",
      },
    });
  });
});
