import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

import { getAgentRun } from "./repository";

const cancelRequestedAt = new Date("2026-08-27T08:00:30.000Z");

function stoppingRunRow() {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    request_id: "30000000-0000-4000-8000-000000000001",
    user_id: "10000000-0000-4000-8000-000000000001",
    conversation_id: "40000000-0000-4000-8000-000000000001",
    input_message_id: "50000000-0000-4000-8000-000000000001",
    assistant_message_id: "60000000-0000-4000-8000-000000000001",
    status: "running" as const,
    conversation_turn: "1",
    attempt_index: 1,
    predecessor_run_id: null,
    retry_of_run_id: null,
    regenerate_of_run_id: null,
    failure_code: null,
    failure_message: null,
    reservation_credits: 100,
    created_at: new Date("2026-08-27T08:00:00.000Z"),
    started_at: new Date("2026-08-27T08:00:01.000Z"),
    finished_at: null,
    model_started_at: new Date("2026-08-27T08:00:02.000Z"),
    cancel_requested_at: cancelRequestedAt,
    lease_owner: "worker-1",
    lease_token: "7",
    lease_expires_at: new Date("2026-08-27T08:01:00.000Z"),
    request_fingerprint: null,
    execution_config: TEST_CAPTURED_RUN_EXECUTION_CONFIG,
  };
}

describe("AgentRun cancellation-state mapping", () => {
  it("selects and serializes the persisted cancellation request timestamp", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [stoppingRunRow()],
    });
    const database = { query } as unknown as Pool;

    await expect(
      getAgentRun(
        "10000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000001",
        database,
      ),
    ).resolves.toMatchObject({
      status: "running",
      cancelRequestedAt: cancelRequestedAt.toISOString(),
    });

    expect(query).toHaveBeenCalledOnce();
    const [statement] = query.mock.calls[0] as [string, unknown[]];
    expect(statement).toContain("run.cancel_requested_at");
  });
});
