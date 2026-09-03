import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { beginRunReservation, markRunRunning } from "@/lib/credits";
import type { CapturedRunExecutionConfig } from "@/lib/contracts";
import { withTransaction } from "@/lib/db/pool";
import {
  createConversation,
  getConversation,
  insertMessage,
  listConversationPage,
  listConversations,
  listMessages,
  patchConversation,
  softDeleteConversation,
} from "@/lib/db";
import { cancelAgentRun, enqueueChatRun } from "@/lib/runs";
import { writeRunSessionSnapshot } from "@/lib/runs/session-snapshots";
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

describe.runIf(databaseUrl !== undefined)("conversation lifecycle data layer", () => {
  const ownerId = randomUUID();
  const otherUserId = randomUUID();
  const userIds = [ownerId, otherUserId];
  let database: Pool;

  async function insertTerminalAttentionFixture(input: {
    userId: string;
    conversationId: string;
    status: "completed" | "failed";
    conversationTurn?: number;
    predecessorRunId?: string | null;
  }): Promise<{
    runId: string;
    eventId: string;
    status: "completed" | "failed";
    finishedAt: string;
  }> {
    const runId = randomUUID();
    const run = await withTransaction(async (client) => {
      const inserted = await client.query<{ finished_at: Date }>(`
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
          completed_at,
          finished_at,
          conversation_turn,
          attempt_index,
          predecessor_run_id
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
          CASE WHEN $5::text = 'failed' THEN 'TEST_FAILURE' ELSE NULL END,
          CASE WHEN $5::text = 'failed' THEN 'Test terminal failure' ELSE NULL END,
          CASE WHEN $5::text = 'completed' THEN clock_timestamp() ELSE NULL END,
          clock_timestamp(),
          $6,
          1,
          $7
        )
        RETURNING finished_at
      `, [
        runId,
        randomUUID(),
        input.userId,
        input.conversationId,
        input.status,
        input.conversationTurn ?? 1,
        input.predecessorRunId ?? null,
      ]);
      await insertCapturedRunExecutionConfig(
        runId,
        capturedConfig(20),
        client,
      );
      await client.query(
        "UPDATE conversations SET selected_run_id = $2 WHERE id = $1 AND user_id = $3",
        [input.conversationId, runId, input.userId],
      );
      return inserted;
    }, database);
    if (run.rowCount !== 1) {
      throw new Error("Could not insert terminal attention Run fixture");
    }

    const eventType = input.status === "completed" ? "done" : "error";
    const eventPayload =
      input.status === "completed"
        ? {
            type: "done" as const,
            message: {
              id: randomUUID(),
              runId,
              role: "assistant" as const,
              content: "Terminal attention fixture",
              citations: [],
              artifacts: [],
              attachments: [],
              feedback: null,
              createdAt: run.rows[0].finished_at.toISOString(),
            },
            credits: { available: 1000, reserved: 0 },
          }
        : {
            type: "error" as const,
            error: {
              code: "TEST_FAILURE",
              message: "Test terminal failure",
              runId,
            },
          };
    const event = await database.query<{ id: string }>(
      `
        INSERT INTO run_events (run_id, event_type, payload)
        VALUES ($1, $2, $3::jsonb)
        RETURNING id::text
      `,
      [runId, eventType, JSON.stringify(eventPayload)],
    );
    if (event.rowCount !== 1) {
      throw new Error("Could not insert terminal attention event fixture");
    }

    return {
      runId,
      eventId: event.rows[0].id,
      status: input.status,
      finishedAt: run.rows[0].finished_at.toISOString(),
    };
  }

  async function insertNonTerminalEventFixture(input: {
    userId: string;
    conversationId: string;
  }): Promise<{ runId: string; eventId: string }> {
    const runId = randomUUID();
    await withTransaction(async (client) => {
      await client.query(`
        INSERT INTO runs (
          id,
          request_id,
          user_id,
          conversation_id,
          status,
          reservation_credits,
          conversation_turn,
          attempt_index
        )
        VALUES ($1, $2, $3, $4, 'queued', 20, 1, 1)
      `, [runId, randomUUID(), input.userId, input.conversationId]);
      await insertCapturedRunExecutionConfig(
        runId,
        capturedConfig(20),
        client,
      );
      await client.query(
        "UPDATE conversations SET selected_run_id = $2 WHERE id = $1 AND user_id = $3",
        [input.conversationId, runId, input.userId],
      );
    }, database);
    const event = await database.query<{ id: string }>(
      `
        INSERT INTO run_events (run_id, event_type, payload)
        VALUES ($1, 'done', $2::jsonb)
        RETURNING id::text
      `,
      [
        runId,
        JSON.stringify({
          type: "done",
          message: {
            id: randomUUID(),
            runId,
            role: "assistant",
            content: "Non-terminal Run fixture",
            citations: [],
            artifacts: [],
            attachments: [],
            feedback: null,
            createdAt: new Date().toISOString(),
          },
          credits: { available: 1000, reserved: 0 },
        }),
      ],
    );
    if (event.rowCount !== 1) {
      throw new Error("Could not insert non-terminal event fixture");
    }
    return { runId, eventId: event.rows[0].id };
  }

  async function insertCompletedSearchTurn(input: {
    conversationId: string;
    conversationTurn: number;
    predecessorRunId: string | null;
    userContent: string;
    assistantContent: string;
  }): Promise<{
    runId: string;
    userMessageId: string;
    assistantMessageId: string;
  }> {
    const userMessage = await insertMessage(
      {
        userId: ownerId,
        conversationId: input.conversationId,
        role: "user",
        content: input.userContent,
        citations: [],
      },
      database,
    );
    const assistantMessage = await insertMessage(
      {
        userId: ownerId,
        conversationId: input.conversationId,
        role: "assistant",
        content: input.assistantContent,
        citations: [],
      },
      database,
    );
    const runId = randomUUID();

    await withTransaction(async (client) => {
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
            input_message_id,
            assistant_message_id,
            completed_at,
            finished_at,
            conversation_turn,
            attempt_index,
            predecessor_run_id
          )
          VALUES (
            $1, $2, $3, $4, 'completed', 20, 1, 1, 1, 0,
            $5, $6, clock_timestamp(), clock_timestamp(), $7, 1, $8
          )
        `,
        [
          runId,
          randomUUID(),
          ownerId,
          input.conversationId,
          userMessage.id,
          assistantMessage.id,
          input.conversationTurn,
          input.predecessorRunId,
        ],
      );
      await insertCapturedRunExecutionConfig(
        runId,
        capturedConfig(20),
        client,
      );
      await client.query(
        "UPDATE messages SET run_id = $1 WHERE id = ANY($2::uuid[])",
        [runId, [userMessage.id, assistantMessage.id]],
      );
      await client.query(
        "UPDATE conversations SET selected_run_id = $2 WHERE id = $1 AND user_id = $3",
        [input.conversationId, runId, ownerId],
      );
    }, database);

    return {
      runId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
    };
  }

  beforeAll(async () => {
    database = new Pool({ connectionString: databaseUrl });
    await database.query(
      `
        INSERT INTO users (id, name, available_credits)
        VALUES
          ($1, 'Lifecycle owner', 1000),
          ($2, 'Lifecycle other user', 1000)
      `,
      [ownerId, otherUserId],
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

  it("isolates users, searches titles and message content, and keyset-paginates the exact order", async () => {
    const unpinnedOld = await createConversation(
      ownerId,
      "Unpinned old",
      database,
    );
    const unpinnedNew = await createConversation(
      ownerId,
      "Titanium valve title match",
      database,
    );
    const pinnedOld = await createConversation(
      ownerId,
      "Pinned old",
      database,
    );
    const pinnedNew = await createConversation(
      ownerId,
      "Pinned new",
      database,
    );
    const otherConversation = await createConversation(
      otherUserId,
      "Other user's titanium valve search",
      database,
    );

    await database.query(
      `
        UPDATE conversations
        SET
          updated_at = CASE id
            WHEN $1::uuid THEN '2026-08-25T01:00:00.000001Z'::timestamptz
            WHEN $2::uuid THEN '2026-08-25T01:00:00.000002Z'::timestamptz
            WHEN $3::uuid THEN '2026-08-25T01:00:00.000003Z'::timestamptz
            WHEN $4::uuid THEN '2026-08-25T01:00:00.000004Z'::timestamptz
          END,
          pinned_at = CASE id
            WHEN $3::uuid THEN '2026-08-25T01:00:00.000005Z'::timestamptz
            WHEN $4::uuid THEN '2026-08-25T01:00:00.000006Z'::timestamptz
            ELSE NULL
          END
        WHERE id = ANY($5::uuid[])
      `,
      [
        unpinnedOld.id,
        unpinnedNew.id,
        pinnedOld.id,
        pinnedNew.id,
        [unpinnedOld.id, unpinnedNew.id, pinnedOld.id, pinnedNew.id],
      ],
    );

    await insertMessage(
      {
        userId: ownerId,
        conversationId: unpinnedOld.id,
        role: "user",
        content: "Please identify titanium valve purchasing managers",
        citations: [],
      },
      database,
    );
    await insertMessage(
      {
        userId: otherUserId,
        conversationId: otherConversation.id,
        role: "user",
        content: "titanium valve purchasing managers",
        citations: [],
      },
      database,
    );
    await database.query(
      `
        UPDATE conversations
        SET updated_at = CASE id
          WHEN $1::uuid THEN '2026-08-25T01:00:00.000001Z'::timestamptz
          WHEN $2::uuid THEN '2026-08-25T01:00:00.000002Z'::timestamptz
        END
        WHERE id = ANY($3::uuid[])
      `,
      [unpinnedOld.id, unpinnedNew.id, [unpinnedOld.id, unpinnedNew.id]],
    );

    const firstPage = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "",
        cursor: null,
        limit: 2,
      },
      database,
    );
    expect(firstPage.items.map((item) => item.id)).toEqual([
      pinnedNew.id,
      pinnedOld.id,
    ]);
    expect(firstPage.items.every((item) => item.searchMatch === null)).toBe(
      true,
    );
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "",
        cursor: firstPage.nextCursor,
        limit: 2,
      },
      database,
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([
      unpinnedNew.id,
      unpinnedOld.id,
    ]);
    expect(secondPage.nextCursor).toBeNull();

    const oneAtATime: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listConversationPage(
        {
          userId: ownerId,
          view: "active",
          query: "",
          cursor,
          limit: 1,
        },
        database,
      );
      oneAtATime.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(oneAtATime).toEqual([
      pinnedNew.id,
      pinnedOld.id,
      unpinnedNew.id,
      unpinnedOld.id,
    ]);

    const allActive = await listConversations(ownerId, database);
    expect(allActive.map((item) => item.id)).not.toContain(otherConversation.id);

    const firstSearchPage = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "TITANIUM VALVE",
        cursor: null,
        limit: 1,
      },
      database,
    );
    expect(firstSearchPage.items.map((item) => item.id)).toEqual([
      unpinnedNew.id,
    ]);
    expect(firstSearchPage.items[0]?.searchMatch).toEqual({
      kind: "title",
      excerpt: {
        before: "",
        match: "Titanium valve",
        after: " title match",
        beforeTruncated: false,
        afterTruncated: false,
      },
    });
    expect(firstSearchPage.nextCursor).not.toBeNull();

    const secondSearchPage = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "TITANIUM VALVE",
        cursor: firstSearchPage.nextCursor,
        limit: 1,
      },
      database,
    );
    expect(secondSearchPage.items.map((item) => item.id)).toEqual([
      unpinnedOld.id,
    ]);
    expect(secondSearchPage.items[0]?.searchMatch).toMatchObject({
      kind: "message",
      role: "user",
      excerpt: {
        before: "Please identify ",
        match: "titanium valve",
        after: " purchasing managers",
        beforeTruncated: false,
        afterTruncated: false,
      },
    });
    expect(secondSearchPage.nextCursor).toBeNull();

    await expect(
      patchConversation(
        ownerId,
        otherConversation.id,
        { action: "rename", title: "Not allowed" },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      softDeleteConversation(ownerId, otherConversation.id, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("returns exact excerpts only from the currently selected branch", async () => {
    const conversation = await createConversation(
      ownerId,
      "Branch title priority needle",
      database,
    );
    const root = await insertCompletedSearchTurn({
      conversationId: conversation.id,
      conversationTurn: 1,
      predecessorRunId: null,
      userContent: "shared ancestor marker",
      assistantContent: "root answer also contains needle",
    });
    const selectedBranch = await insertCompletedSearchTurn({
      conversationId: conversation.id,
      conversationTurn: 2,
      predecessorRunId: root.runId,
      userContent: "selected branch question",
      assistantContent: "Markdown **selected-visible-marker** verified",
    });
    const hiddenBranch = await insertCompletedSearchTurn({
      conversationId: conversation.id,
      conversationTurn: 2,
      predecessorRunId: root.runId,
      userContent: "hidden branch question",
      assistantContent: "hidden-sibling-marker should not leak",
    });
    await patchConversation(
      ownerId,
      conversation.id,
      { action: "select_run", runId: selectedBranch.runId },
      database,
    );

    const titleAndBody = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "needle",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(titleAndBody.items).toHaveLength(1);
    expect(titleAndBody.items[0]?.searchMatch).toEqual({
      kind: "title",
      excerpt: {
        before: "Branch title priority ",
        match: "needle",
        after: "",
        beforeTruncated: false,
        afterTruncated: false,
      },
    });

    const selectedSearch = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "selected-visible-marker",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(selectedSearch.items).toHaveLength(1);
    expect(selectedSearch.items[0]?.searchMatch).toEqual({
      kind: "message",
      messageId: selectedBranch.assistantMessageId,
      role: "assistant",
      createdAt: expect.any(String),
      excerpt: {
        before: "Markdown **",
        match: "selected-visible-marker",
        after: "** verified",
        beforeTruncated: false,
        afterTruncated: false,
      },
    });

    const hiddenWhileSelected = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "hidden-sibling-marker",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(hiddenWhileSelected.items).toHaveLength(0);

    const sharedAncestor = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "shared ancestor marker",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(sharedAncestor.items[0]?.searchMatch).toMatchObject({
      kind: "message",
      messageId: root.userMessageId,
      role: "user",
    });

    await patchConversation(
      ownerId,
      conversation.id,
      { action: "select_run", runId: hiddenBranch.runId },
      database,
    );
    const hiddenAfterSelection = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "hidden-sibling-marker",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(hiddenAfterSelection.items[0]?.searchMatch).toMatchObject({
      kind: "message",
      messageId: hiddenBranch.assistantMessageId,
      role: "assistant",
    });
    const oldBranchAfterSelection = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "selected-visible-marker",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(oldBranchAfterSelection.items).toHaveLength(0);
  });

  it("bounds long raw message excerpts without rendering Markdown", async () => {
    const conversation = await createConversation(
      ownerId,
      "Long excerpt fixture",
      database,
    );
    const before = "a".repeat(90);
    const after = "b".repeat(90);
    const message = await insertMessage(
      {
        userId: ownerId,
        conversationId: conversation.id,
        role: "assistant",
        content: `${before}<mark>literal-target</mark>${after}`,
        citations: [],
      },
      database,
    );

    const search = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "literal-target",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.searchMatch).toEqual({
      kind: "message",
      messageId: message.id,
      role: "assistant",
      createdAt: message.createdAt,
      excerpt: {
        before: `${"a".repeat(74)}<mark>`,
        match: "literal-target",
        after: `</mark>${"b".repeat(73)}`,
        beforeTruncated: true,
        afterTruncated: true,
      },
    });
  });

  it("archives and restores without changing the pin timestamp", async () => {
    const conversation = await createConversation(
      ownerId,
      "Archive and restore",
      database,
    );
    const pinned = await patchConversation(
      ownerId,
      conversation.id,
      { action: "set_pinned", pinned: true },
      database,
    );
    expect(pinned.pinnedAt).not.toBeNull();

    const archived = await patchConversation(
      ownerId,
      conversation.id,
      { action: "set_archived", archived: true },
      database,
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.pinnedAt).toBe(pinned.pinnedAt);

    const [activePage, archivedPage] = await Promise.all([
      listConversationPage(
        {
          userId: ownerId,
          view: "active",
          query: "Archive and restore",
          cursor: null,
          limit: 30,
        },
        database,
      ),
      listConversationPage(
        {
          userId: ownerId,
          view: "archived",
          query: "Archive and restore",
          cursor: null,
          limit: 30,
        },
        database,
      ),
    ]);
    expect(activePage.items).toHaveLength(0);
    expect(archivedPage.items.map((item) => item.id)).toEqual([
      conversation.id,
    ]);

    const restored = await patchConversation(
      ownerId,
      conversation.id,
      { action: "set_archived", archived: false },
      database,
    );
    expect(restored.archivedAt).toBeNull();
    expect(restored.pinnedAt).toBe(pinned.pinnedAt);
  });

  it("rejects branch selection, archive, and deletion while a run is queued or running", async () => {
    const conversation = await createConversation(
      ownerId,
      "Active run conflict",
      database,
    );
    const priorBranch = await insertTerminalAttentionFixture({
      userId: ownerId,
      conversationId: conversation.id,
      status: "completed",
    });
    await writeRunSessionSnapshot(priorBranch.runId, "post", [], database);
    const reservation = await beginRunReservation(
      {
        userId: ownerId,
        conversationId: conversation.id,
        requestId: randomUUID(),
        reservationCredits: 20,
        executionConfig: capturedConfig(20),
        parentRunId: priorBranch.runId,
      },
      database,
    );

    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "select_run", runId: priorBranch.runId },
        database,
      ),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });

    await markRunRunning(ownerId, reservation.run.id, database);
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "select_run", runId: priorBranch.runId },
        database,
      ),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });
    await expect(
      getConversation(ownerId, conversation.id, database),
    ).resolves.toMatchObject({ selectedRunId: reservation.run.id });
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "set_archived", archived: true },
        database,
      ),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });
    await expect(
      softDeleteConversation(ownerId, conversation.id, database),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });

    await cancelAgentRun(ownerId, reservation.run.id, database);
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "select_run", runId: priorBranch.runId },
        database,
      ),
    ).resolves.toMatchObject({ selectedRunId: priorBranch.runId });
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "set_archived", archived: true },
        database,
      ),
    ).resolves.toMatchObject({ id: conversation.id });
  });

  it("rejects branch selection, archive, and deletion while only a waiting run remains", async () => {
    const conversation = await createConversation(
      ownerId,
      "Waiting run conflict",
      database,
    );
    const predecessor = await beginRunReservation(
      {
        userId: ownerId,
        conversationId: conversation.id,
        requestId: randomUUID(),
        reservationCredits: 20,
        executionConfig: capturedConfig(20),
        parentRunId: null,
      },
      database,
    );
    const waiting = await enqueueChatRun(
      {
        userId: ownerId,
        request: {
          kind: "append",
          conversationId: conversation.id,
          parentRunId: predecessor.run.id,
          message: "Wait for the preceding research",
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

    expect(waiting.run).toMatchObject({
      status: "waiting",
      predecessorRunId: predecessor.run.id,
    });
    expect(waiting.conversation.waitingRunCount).toBe(1);
    await cancelAgentRun(ownerId, predecessor.run.id, database);
    const [detailWithPausedQueue, activeSummaries, activePage] =
      await Promise.all([
        getConversation(ownerId, conversation.id, database),
        listConversations(ownerId, database),
        listConversationPage(
          {
            userId: ownerId,
            view: "active",
            query: "Waiting run conflict",
            cursor: null,
            limit: 30,
          },
          database,
        ),
      ]);
    expect(detailWithPausedQueue).toMatchObject({
      activeRun: null,
      waitingRunCount: 1,
    });
    expect(
      activeSummaries.find((item) => item.id === conversation.id),
    ).toMatchObject({ activeRun: null, waitingRunCount: 1 });
    expect(activePage.items).toHaveLength(1);
    expect(activePage.items[0]).toMatchObject({
      activeRun: null,
      waitingRunCount: 1,
    });

    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "set_archived", archived: true },
        database,
      ),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "select_run", runId: predecessor.run.id },
        database,
      ),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });
    await expect(
      getConversation(ownerId, conversation.id, database),
    ).resolves.toMatchObject({ selectedRunId: waiting.run.id });
    await expect(
      softDeleteConversation(ownerId, conversation.id, database),
    ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });

    await cancelAgentRun(ownerId, waiting.run.id, database);
    await expect(
      getConversation(ownerId, conversation.id, database),
    ).resolves.toMatchObject({ waitingRunCount: 0 });
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "select_run", runId: predecessor.run.id },
        database,
      ),
    ).resolves.toMatchObject({ selectedRunId: predecessor.run.id });
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "set_archived", archived: true },
        database,
      ),
    ).resolves.toMatchObject({ id: conversation.id });
  });

  it("tracks terminal attention with a monotonic read watermark", async () => {
    const conversation = await createConversation(
      ownerId,
      "Terminal attention watermark",
      database,
    );
    const first = await insertTerminalAttentionFixture({
      userId: ownerId,
      conversationId: conversation.id,
      status: "completed",
    });

    await expect(
      getConversation(ownerId, conversation.id, database),
    ).resolves.toMatchObject({
      attention: {
        terminalEventId: first.eventId,
        runId: first.runId,
        status: first.status,
        finishedAt: first.finishedAt,
      },
    });

    const second = await insertTerminalAttentionFixture({
      userId: ownerId,
      conversationId: conversation.id,
      status: "failed",
      conversationTurn: 2,
      predecessorRunId: first.runId,
    });
    const latestAttention = {
      terminalEventId: second.eventId,
      runId: second.runId,
      status: second.status,
      finishedAt: second.finishedAt,
    };

    const markedThroughOlderEvent = await patchConversation(
      ownerId,
      conversation.id,
      { action: "mark_read", throughEventId: first.eventId },
      database,
    );
    expect(markedThroughOlderEvent.attention).toEqual(latestAttention);

    const markedThroughLatestEvent = await patchConversation(
      ownerId,
      conversation.id,
      { action: "mark_read", throughEventId: second.eventId },
      database,
    );
    expect(markedThroughLatestEvent.attention).toBeNull();

    const markedThroughOlderEventAgain = await patchConversation(
      ownerId,
      conversation.id,
      { action: "mark_read", throughEventId: first.eventId },
      database,
    );
    expect(markedThroughOlderEventAgain.attention).toBeNull();
    await expect(
      getConversation(ownerId, conversation.id, database),
    ).resolves.toMatchObject({ attention: null });
  });

  it("rejects invalid conversation attention watermarks", async () => {
    const target = await createConversation(
      ownerId,
      "Attention watermark target",
      database,
    );
    const sameOwnerSource = await createConversation(
      ownerId,
      "Cross-conversation attention source",
      database,
    );
    const otherOwnerSource = await createConversation(
      otherUserId,
      "Cross-user attention source",
      database,
    );
    const nonTerminalSource = await createConversation(
      ownerId,
      "Non-terminal attention source",
      database,
    );
    const sameOwnerTerminal = await insertTerminalAttentionFixture({
      userId: ownerId,
      conversationId: sameOwnerSource.id,
      status: "completed",
    });
    const otherOwnerTerminal = await insertTerminalAttentionFixture({
      userId: otherUserId,
      conversationId: otherOwnerSource.id,
      status: "failed",
    });
    const nonTerminal = await insertNonTerminalEventFixture({
      userId: ownerId,
      conversationId: nonTerminalSource.id,
    });

    await expect(
      patchConversation(
        ownerId,
        target.id,
        { action: "mark_read", throughEventId: sameOwnerTerminal.eventId },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      patchConversation(
        ownerId,
        target.id,
        { action: "mark_read", throughEventId: otherOwnerTerminal.eventId },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      patchConversation(
        ownerId,
        nonTerminalSource.id,
        { action: "mark_read", throughEventId: nonTerminal.eventId },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      patchConversation(
        ownerId,
        otherOwnerSource.id,
        { action: "mark_read", throughEventId: otherOwnerTerminal.eventId },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("returns identical attention in detail, active, archived, search, and page queries", async () => {
    const searchPhrase = `attention-consistency-${randomUUID()}`;
    const conversation = await createConversation(
      ownerId,
      searchPhrase,
      database,
    );
    const terminal = await insertTerminalAttentionFixture({
      userId: ownerId,
      conversationId: conversation.id,
      status: "failed",
    });
    const expectedAttention = {
      terminalEventId: terminal.eventId,
      runId: terminal.runId,
      status: terminal.status,
      finishedAt: terminal.finishedAt,
    };

    const detail = await getConversation(ownerId, conversation.id, database);
    const active = await listConversations(ownerId, database);
    const activePage = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "",
        cursor: null,
        limit: 50,
      },
      database,
    );
    const activeSearch = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: searchPhrase.toUpperCase(),
        cursor: null,
        limit: 30,
      },
      database,
    );

    expect(detail?.attention).toEqual(expectedAttention);
    expect(active.find((item) => item.id === conversation.id)?.attention).toEqual(
      expectedAttention,
    );
    expect(
      activePage.items.find((item) => item.id === conversation.id)?.attention,
    ).toEqual(expectedAttention);
    expect(activeSearch.items).toHaveLength(1);
    expect(activeSearch.items[0].attention).toEqual(expectedAttention);

    const archived = await patchConversation(
      ownerId,
      conversation.id,
      { action: "set_archived", archived: true },
      database,
    );
    const archivedPage = await listConversationPage(
      {
        userId: ownerId,
        view: "archived",
        query: "",
        cursor: null,
        limit: 50,
      },
      database,
    );
    const archivedSearch = await listConversationPage(
      {
        userId: ownerId,
        view: "archived",
        query: searchPhrase,
        cursor: null,
        limit: 30,
      },
      database,
    );
    const archivedDetail = await getConversation(
      ownerId,
      conversation.id,
      database,
    );

    expect(archived.attention).toEqual(expectedAttention);
    expect(
      archivedPage.items.find((item) => item.id === conversation.id)?.attention,
    ).toEqual(expectedAttention);
    expect(archivedSearch.items).toHaveLength(1);
    expect(archivedSearch.items[0].attention).toEqual(expectedAttention);
    expect(archivedDetail?.attention).toEqual(expectedAttention);
  });

  it("soft-deletes once and excludes the row from every conversation ownership path", async () => {
    const conversation = await createConversation(
      ownerId,
      "Soft delete titanium valve",
      database,
    );
    await insertMessage(
      {
        userId: ownerId,
        conversationId: conversation.id,
        role: "user",
        content: "unique soft delete search phrase",
        citations: [],
      },
      database,
    );

    const deletion = await softDeleteConversation(
      ownerId,
      conversation.id,
      database,
    );
    expect(deletion.conversationId).toBe(conversation.id);
    expect(new Date(deletion.deletedAt).toISOString()).toBe(deletion.deletedAt);
    await expect(
      getConversation(ownerId, conversation.id, database),
    ).resolves.toBeNull();

    const search = await listConversationPage(
      {
        userId: ownerId,
        view: "active",
        query: "unique soft delete search phrase",
        cursor: null,
        limit: 30,
      },
      database,
    );
    expect(search.items).toHaveLength(0);

    await expect(
      listMessages(ownerId, conversation.id, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      insertMessage(
        {
          userId: ownerId,
          conversationId: conversation.id,
          role: "user",
          content: "must not be inserted",
          citations: [],
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "append",
            conversationId: conversation.id,
            parentRunId: conversation.selectedRunId,
            message: "must not enqueue",
            attachmentIds: [],
            requestId: randomUUID(),
            executionProfileId: "standard_research",
          },
          executionConfig: capturedConfig(20),
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      patchConversation(
        ownerId,
        conversation.id,
        { action: "set_pinned", pinned: true },
        database,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      softDeleteConversation(ownerId, conversation.id, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});
