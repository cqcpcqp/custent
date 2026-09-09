import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  beginRunReservation,
  getCreditBalance,
  markRunReconciliationRequired,
} from "@/lib/credits";
import type { CapturedRunExecutionConfig } from "@/lib/contracts";
import { createConversation } from "@/lib/db";
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

describe.runIf(databaseUrl !== undefined)("conversation run reservation", () => {
  const userIds: string[] = [];
  let database: Pool;

  beforeAll(() => {
    database = new Pool({ connectionString: databaseUrl });
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
    await database.query("DELETE FROM runs WHERE user_id = ANY($1::uuid[])", [userIds]);
    await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    await database.end();
  });

  async function createFixture() {
    const userId = randomUUID();
    userIds.push(userId);
    await database.query(
      "INSERT INTO users (id, name, available_credits) VALUES ($1, $2, 1000)",
      [userId, "Run reservation integration user"],
    );
    const conversation = await createConversation(
      userId,
      "Concurrent buyer research",
      database,
    );
    return { userId, conversationId: conversation.id };
  }

  it("rejects a low-level child reservation while its parent is active", async () => {
    const { userId, conversationId } = await createFixture();
    const first = await beginRunReservation(
      {
        userId,
        conversationId,
        requestId: randomUUID(),
        reservationCredits: 10,
        executionConfig: capturedConfig(10),
        parentRunId: null,
      },
      database,
    );

    await expect(
      beginRunReservation(
        {
          userId,
          conversationId,
          requestId: randomUUID(),
          reservationCredits: 10,
          executionConfig: capturedConfig(10),
          parentRunId: first.run.id,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_IN_PROGRESS", status: 409 });

    await markRunReconciliationRequired(
      {
        userId,
        runId: first.run.id,
        reason: "Release the active slot for the integration test",
      },
      database,
    );

    await expect(
      beginRunReservation(
        {
          userId,
          conversationId,
          requestId: randomUUID(),
          reservationCredits: 10,
          executionConfig: capturedConfig(10),
          parentRunId: first.run.id,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_CONTEXT_UNAVAILABLE", status: 409 });
  });

  it("allows exactly one reservation when two requests race for one conversation", async () => {
    const { userId, conversationId } = await createFixture();
    const attempts = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((requestId) =>
        beginRunReservation(
          {
            userId,
            conversationId,
            requestId,
            reservationCredits: 10,
            executionConfig: capturedConfig(10),
            parentRunId: null,
          },
          database,
        ),
      ),
    );

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof beginRunReservation>>> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: "STALE_PARENT",
      status: 409,
    });

    const activeRuns = await database.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM runs
        WHERE conversation_id = $1 AND status IN ('queued', 'running')
      `,
      [conversationId],
    );
    expect(activeRuns.rows[0].count).toBe(1);
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 990,
      reserved: 10,
    });
  });
});
