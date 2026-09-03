import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRun } from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { TEST_CAPTURED_RUN_EXECUTION_SUMMARY } from "@/tests/fixtures/run-config";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  run: "22222222-2222-4222-8222-222222222222",
  artifact: "33333333-3333-4333-8333-333333333333",
};

const stoppingRun: AgentRun = {
  id: ids.run,
  requestId: "55555555-5555-4555-8555-555555555555",
  conversationId: "66666666-6666-4666-8666-666666666666",
  inputMessageId: "77777777-7777-4777-8777-777777777777",
  assistantMessageId: "88888888-8888-4888-8888-888888888888",
  status: "running",
  conversationTurn: "1",
  attemptIndex: 1,
  predecessorRunId: null,
  retryOfRunId: null,
  regenerateOfRunId: null,
  executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
  failure: null,
  createdAt: "2026-08-27T08:00:00.000Z",
  startedAt: "2026-08-27T08:00:01.000Z",
  finishedAt: null,
  cancelRequestedAt: "2026-08-27T08:00:30.000Z",
};

const mocks = vi.hoisted(() => ({
  cancelAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
  getArtifact: vi.fn(),
  getCurrentUserId: vi.fn(),
  getEnv: vi.fn(),
  isTerminalRunStatus: vi.fn(),
  readFile: vi.fn(),
  readRunEventBatch: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

vi.mock("@/lib/env", () => ({
  getEnv: mocks.getEnv,
}));

vi.mock("@/lib/artifacts", () => ({
  getArtifact: mocks.getArtifact,
}));

vi.mock("@/lib/runs", () => ({
  cancelAgentRun: mocks.cancelAgentRun,
  getAgentRun: mocks.getAgentRun,
  isTerminalRunStatus: mocks.isTerminalRunStatus,
  readRunEventBatch: mocks.readRunEventBatch,
}));

import { GET as downloadArtifact } from "@/app/api/artifacts/[artifactId]/download/route";
import { POST as cancelRun } from "@/app/api/runs/[runId]/cancel/route";
import { GET as getRunEvents } from "@/app/api/runs/[runId]/events/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUserId.mockReturnValue(ids.user);
  mocks.getEnv.mockReturnValue({ RUN_EVENT_POLL_MS: 10 });
});

describe("soft-deleted resource route reachability", () => {
  it("returns 404 before opening an event stream for an old run ID", async () => {
    mocks.getAgentRun.mockResolvedValue(null);

    const response = await getRunEvents(
      new Request(`http://localhost/api/runs/${ids.run}/events`),
      { params: Promise.resolve({ runId: ids.run }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(mocks.getAgentRun).toHaveBeenCalledWith(ids.user, ids.run);
    expect(mocks.readRunEventBatch).not.toHaveBeenCalled();
  });

  it("returns 404 without reading storage for an old artifact ID", async () => {
    mocks.getArtifact.mockResolvedValue(null);

    const response = await downloadArtifact(
      new Request(
        `http://localhost/api/artifacts/${ids.artifact}/download`,
      ),
      { params: Promise.resolve({ artifactId: ids.artifact }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(mocks.getArtifact).toHaveBeenCalledWith(ids.user, ids.artifact);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it("returns 404 when cancelling an old run ID", async () => {
    mocks.cancelAgentRun.mockRejectedValue(
      new AppError("NOT_FOUND", "Run was not found", 404),
    );

    const response = await cancelRun(
      new Request(`http://localhost/api/runs/${ids.run}/cancel`, {
        method: "POST",
      }),
      { params: Promise.resolve({ runId: ids.run }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND" },
    });
    expect(mocks.cancelAgentRun).toHaveBeenCalledWith(ids.user, ids.run);
  });

  it("returns the persisted cancellation timestamp for a running run", async () => {
    mocks.cancelAgentRun.mockResolvedValue(stoppingRun);

    const response = await cancelRun(
      new Request(`http://localhost/api/runs/${ids.run}/cancel`, {
        method: "POST",
      }),
      { params: Promise.resolve({ runId: ids.run }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: stoppingRun });
  });
});
