import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { listTrackedConversations } from "@/lib/db/conversations";

describe("tracked conversation discovery", () => {
  it("returns every active conversation that needs background observation", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "German pump buyers",
          updated_at: new Date("2026-08-25T08:00:00.000Z"),
          pinned_at: null,
          archived_at: null,
          selected_run_id: "22222222-2222-4222-8222-222222222222",
          active_run_id: "22222222-2222-4222-8222-222222222222",
          active_run_status: "running",
          active_run_started_at: new Date("2026-08-25T08:00:01.000Z"),
          waiting_run_count: 2,
          attention_terminal_event_id: "42",
          attention_run_id: "33333333-3333-4333-8333-333333333333",
          attention_run_status: "completed",
          attention_finished_at: new Date("2026-08-25T08:02:00.000Z"),
        },
      ],
    });
    const database = { query } as unknown as Pool;
    const userId = "44444444-4444-4444-8444-444444444444";

    await expect(
      listTrackedConversations(userId, database),
    ).resolves.toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "German pump buyers",
        updatedAt: "2026-08-25T08:00:00.000Z",
        pinnedAt: null,
        archivedAt: null,
        selectedRunId: "22222222-2222-4222-8222-222222222222",
        activeRun: {
          id: "22222222-2222-4222-8222-222222222222",
          status: "running",
          startedAt: "2026-08-25T08:00:01.000Z",
        },
        waitingRunCount: 2,
        attention: {
          terminalEventId: "42",
          runId: "33333333-3333-4333-8333-333333333333",
          status: "completed",
          finishedAt: "2026-08-25T08:02:00.000Z",
        },
      },
    ]);

    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(parameters).toEqual([userId]);
    expect(sql).toContain("WITH pending_run_state AS MATERIALIZED");
    expect(sql).toContain("unread_attention AS MATERIALIZED");
    expect(sql).toContain("candidate_conversations AS");
    expect(sql).toContain("run.status IN ('waiting', 'queued', 'running')");
    expect(sql).toContain("run.user_id = $1");
    expect(sql).toContain("conversation.deleted_at IS NULL");
    expect(sql).toContain("conversation.archived_at IS NULL");
    expect(sql).toContain(
      "event.id > owned_conversation.read_through_terminal_event_id",
    );
    expect(sql).not.toContain("JOIN LATERAL");
  });
});
