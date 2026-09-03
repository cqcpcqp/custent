import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ActiveRunSummary,
  CapturedRunExecutionConfig,
  ConversationAttention,
  ConversationSummary,
} from "@/lib/contracts";
import {
  getConversation,
  listConversations,
  listTrackedConversations,
  patchConversation,
} from "@/lib/db/conversations";
import { withTransaction } from "@/lib/db/pool";
import { markRunRunning } from "@/lib/credits";
import { enqueueChatRun } from "@/lib/runs";
import { insertCapturedRunExecutionConfig } from "@/lib/run-config";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;

function capturedConfig(reservationCredits: number): CapturedRunExecutionConfig {
  return {
    ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
    billing: {
      ...TEST_CAPTURED_RUN_EXECUTION_CONFIG.billing,
      reservationCredits,
    },
  };
}

type LegacyTrackedRow = {
  id: string;
  title: string;
  updated_at: Date;
  pinned_at: Date | null;
  archived_at: Date | null;
  selected_run_id: string | null;
  active_run_id: string | null;
  active_run_status: ActiveRunSummary["status"] | null;
  active_run_started_at: Date | null;
  waiting_run_count: number;
  attention_terminal_event_id: string | null;
  attention_run_id: string | null;
  attention_run_status: ConversationAttention["status"] | null;
  attention_finished_at: Date | null;
};

type TerminalStatus = ConversationAttention["status"];

function mapLegacyTrackedRow(row: LegacyTrackedRow): ConversationSummary {
  const activeRun = row.active_run_id === null
    ? null
    : {
        id: row.active_run_id,
        status: row.active_run_status as ActiveRunSummary["status"],
        startedAt: row.active_run_started_at?.toISOString() ?? null,
      };
  const attention = row.attention_terminal_event_id === null
    ? null
    : {
        terminalEventId: row.attention_terminal_event_id,
        runId: row.attention_run_id as string,
        status: row.attention_run_status as ConversationAttention["status"],
        finishedAt: (row.attention_finished_at as Date).toISOString(),
      };

  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    selectedRunId: row.selected_run_id,
    activeRun,
    waitingRunCount: row.waiting_run_count,
    attention,
  };
}

async function listTrackedWithLegacyLaterals(
  userId: string,
  database: Pool,
): Promise<ConversationSummary[]> {
  const result = await database.query<LegacyTrackedRow>(
    `
      SELECT
        conversation.id,
        conversation.title,
        conversation.updated_at,
        conversation.pinned_at,
        conversation.archived_at,
        conversation.selected_run_id,
        active_run.id AS active_run_id,
        active_run.status AS active_run_status,
        active_run.started_at AS active_run_started_at,
        waiting_runs.waiting_run_count,
        attention.event_id AS attention_terminal_event_id,
        attention.run_id AS attention_run_id,
        attention.status AS attention_run_status,
        attention.finished_at AS attention_finished_at
      FROM conversations conversation
      LEFT JOIN LATERAL (
        SELECT run.id, run.status, run.started_at
        FROM runs run
        WHERE
          run.conversation_id = conversation.id
          AND run.status IN ('queued', 'running')
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT 1
      ) active_run ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS waiting_run_count
        FROM runs run
        WHERE
          run.conversation_id = conversation.id
          AND run.status = 'waiting'
      ) waiting_runs ON true
      LEFT JOIN LATERAL (
        SELECT
          event.id AS event_id,
          run.id AS run_id,
          run.status,
          run.finished_at
        FROM runs run
        JOIN run_events event ON event.run_id = run.id
        WHERE
          run.conversation_id = conversation.id
          AND run.status IN (
            'completed',
            'failed',
            'cancelled',
            'reconciliation_required'
          )
          AND event.event_type IN ('done', 'error')
          AND event.id > conversation.read_through_terminal_event_id
        ORDER BY event.id DESC
        LIMIT 1
      ) attention ON true
      WHERE
        conversation.user_id = $1
        AND conversation.deleted_at IS NULL
        AND conversation.archived_at IS NULL
        AND (
          active_run.id IS NOT NULL
          OR waiting_runs.waiting_run_count > 0
          OR attention.event_id IS NOT NULL
        )
      ORDER BY
        conversation.pinned_at DESC NULLS LAST,
        conversation.updated_at DESC,
        conversation.id DESC
    `,
    [userId],
  );

  return result.rows.map(mapLegacyTrackedRow);
}

describe.runIf(databaseUrl !== undefined)(
  "tracked conversation candidate discovery",
  () => {
    const ownerId = randomUUID();
    const otherUserId = randomUUID();
    const userIds = [ownerId, otherUserId];
    let database: Pool;

    async function enqueue(
      userId: string,
      message: string,
      conversationId: string | null = null,
      parentRunId: string | null = null,
    ) {
      return enqueueChatRun(
        {
          userId,
          request: {
            kind: "append",
            conversationId,
            parentRunId,
            message,
            attachmentIds: [],
            requestId: randomUUID(),
            executionProfileId: "standard_research",
          },
          executionConfig: capturedConfig(20),
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        database,
      );
    }

    async function insertTerminalAttention(
      conversationId: string,
      status: TerminalStatus,
    ): Promise<{ eventId: string; runId: string }> {
      const runId = randomUUID();
      return withTransaction(async (client) => {
        await client.query(
          `
            INSERT INTO runs (
              id,
              request_id,
              user_id,
              conversation_id,
              status,
              reservation_credits,
              charged_credits,
              input_tokens,
              output_tokens,
              web_searches,
              failure_code,
              failure_message,
              reconciliation_reason,
              completed_at,
              finished_at,
              conversation_turn,
              attempt_index
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              20,
              CASE WHEN $5::text = 'completed' THEN 0 ELSE NULL END,
              CASE WHEN $5::text = 'completed' THEN 0 ELSE NULL END,
              CASE WHEN $5::text = 'completed' THEN 0 ELSE NULL END,
              CASE WHEN $5::text = 'completed' THEN 0 ELSE NULL END,
              CASE WHEN $5::text = 'completed' THEN NULL ELSE 'TEST_TERMINAL' END,
              CASE WHEN $5::text = 'completed' THEN NULL ELSE 'Test terminal Run' END,
              CASE
                WHEN $5::text = 'reconciliation_required'
                THEN 'Test reconciliation'
                ELSE NULL
              END,
              CASE WHEN $5::text = 'completed' THEN clock_timestamp() ELSE NULL END,
              clock_timestamp(),
              1,
              1
            )
          `,
          [runId, randomUUID(), ownerId, conversationId, status],
        );
        await insertCapturedRunExecutionConfig(
          runId,
          capturedConfig(20),
          client,
        );
        await client.query(
          `
            UPDATE conversations
            SET selected_run_id = $2
            WHERE id = $1 AND user_id = $3
          `,
          [conversationId, runId, ownerId],
        );
        const eventType = status === "completed" ? "done" : "error";
        const event = await client.query<{ id: string }>(
          `
            INSERT INTO run_events (run_id, event_type, payload)
            VALUES ($1, $2, $3::jsonb)
            RETURNING id::text
          `,
          [runId, eventType, JSON.stringify({ type: eventType })],
        );
        return { eventId: event.rows[0].id, runId };
      }, database);
    }

    beforeAll(async () => {
      database = new Pool({ connectionString: databaseUrl });
      await database.query(
        `
          INSERT INTO users (id, name, available_credits)
          VALUES
            ($1, 'Tracked candidate owner', 1000),
            ($2, 'Tracked candidate other user', 1000)
        `,
        userIds,
      );
    });

    afterAll(async () => {
      await database.query(
        "DELETE FROM credit_ledger WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query(
        "DELETE FROM conversations WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query("DELETE FROM runs WHERE user_id = ANY($1::uuid[])", [
        userIds,
      ]);
      await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
        userIds,
      ]);
      await database.end();
    });

    it("returns exactly the legacy active, waiting, and unread-terminal result set", async () => {
      const queuedWithWaiting = await enqueue(ownerId, "Queued with waiting");
      const queuedSuccessor = await enqueue(
        ownerId,
        "Waiting successor",
        queuedWithWaiting.conversation.id,
        queuedWithWaiting.run.id,
      );
      const secondQueuedSuccessor = await enqueue(
        ownerId,
        "Second waiting successor",
        queuedWithWaiting.conversation.id,
        queuedSuccessor.run.id,
      );

      const running = await enqueue(ownerId, "Running candidate");
      await markRunRunning(ownerId, running.run.id, database);
      await patchConversation(
        ownerId,
        running.conversation.id,
        { action: "set_pinned", pinned: true },
        database,
      );

      const waitingOnly = await enqueue(ownerId, "Waiting-only root");
      const waitingOnlySuccessor = await enqueue(
        ownerId,
        "Waiting-only successor",
        waitingOnly.conversation.id,
        waitingOnly.run.id,
      );
      await database.query(
        `
          UPDATE runs
          SET
            status = 'cancelled',
            failure_code = 'TEST_CANCELLED',
            failure_message = 'Cancelled without a terminal event',
            finished_at = clock_timestamp(),
            updated_at = clock_timestamp()
          WHERE id = $1
        `,
        [waitingOnly.run.id],
      );

      const terminalFixtures = await Promise.all(
        ([
          "completed",
          "failed",
          "cancelled",
          "reconciliation_required",
        ] as const).map(async (status) => {
          const conversation = await database.query<{ id: string }>(
            `
              INSERT INTO conversations (user_id, title)
              VALUES ($1, $2)
              RETURNING id
            `,
            [ownerId, `Unread ${status}`],
          );
          const attention = await insertTerminalAttention(
            conversation.rows[0].id,
            status,
          );
          return { conversationId: conversation.rows[0].id, status, ...attention };
        }),
      );

      const readConversation = await database.query<{ id: string }>(
        `
          INSERT INTO conversations (user_id, title)
          VALUES ($1, 'Read terminal')
          RETURNING id
        `,
        [ownerId],
      );
      const readAttention = await insertTerminalAttention(
        readConversation.rows[0].id,
        "completed",
      );
      await patchConversation(
        ownerId,
        readConversation.rows[0].id,
        { action: "mark_read", throughEventId: readAttention.eventId },
        database,
      );

      const idle = await database.query<{ id: string }>(
        `
          INSERT INTO conversations (user_id, title)
          VALUES ($1, 'Idle history')
          RETURNING id
        `,
        [ownerId],
      );
      const archived = await enqueue(ownerId, "Archived queued candidate");
      await database.query(
        "UPDATE conversations SET archived_at = clock_timestamp() WHERE id = $1",
        [archived.conversation.id],
      );
      const deleted = await enqueue(ownerId, "Deleted queued candidate");
      await database.query(
        "UPDATE conversations SET deleted_at = clock_timestamp() WHERE id = $1",
        [deleted.conversation.id],
      );
      const otherOwner = await enqueue(otherUserId, "Other owner queued");

      const legacy = await listTrackedWithLegacyLaterals(ownerId, database);
      const candidates = await listTrackedConversations(ownerId, database);

      expect(candidates).toEqual(legacy);
      const activeList = await listConversations(ownerId, database);
      const activeById = new Map(
        activeList.map((conversation) => [conversation.id, conversation]),
      );
      for (const candidate of candidates) {
        await expect(
          getConversation(ownerId, candidate.id, database),
        ).resolves.toEqual(candidate);
        expect(activeById.get(candidate.id)).toEqual(candidate);
      }
      expect(new Set(candidates.map((conversation) => conversation.id))).toEqual(
        new Set([
          queuedWithWaiting.conversation.id,
          running.conversation.id,
          waitingOnly.conversation.id,
          ...terminalFixtures.map((fixture) => fixture.conversationId),
        ]),
      );
      expect(candidates.map((conversation) => conversation.id)).not.toContain(
        idle.rows[0].id,
      );
      expect(candidates.map((conversation) => conversation.id)).not.toContain(
        archived.conversation.id,
      );
      expect(candidates.map((conversation) => conversation.id)).not.toContain(
        deleted.conversation.id,
      );
      expect(candidates.map((conversation) => conversation.id)).not.toContain(
        otherOwner.conversation.id,
      );

      expect(
        candidates.find(
          (conversation) =>
            conversation.id === queuedWithWaiting.conversation.id,
        ),
      ).toMatchObject({
        selectedRunId: secondQueuedSuccessor.run.id,
        activeRun: {
          id: queuedWithWaiting.run.id,
          status: "queued",
          startedAt: null,
        },
        waitingRunCount: 2,
        attention: null,
      });
      expect(
        candidates.find(
          (conversation) => conversation.id === running.conversation.id,
        ),
      ).toMatchObject({
        activeRun: {
          id: running.run.id,
          status: "running",
          startedAt: expect.any(String),
        },
        waitingRunCount: 0,
      });
      expect(
        candidates.find(
          (conversation) => conversation.id === waitingOnly.conversation.id,
        ),
      ).toMatchObject({
        selectedRunId: waitingOnlySuccessor.run.id,
        activeRun: null,
        waitingRunCount: 1,
        attention: null,
      });
      for (const fixture of terminalFixtures) {
        expect(
          candidates.find(
            (conversation) => conversation.id === fixture.conversationId,
          )?.attention,
        ).toMatchObject({
          terminalEventId: fixture.eventId,
          runId: fixture.runId,
          status: fixture.status,
        });
      }
    });
  },
);
