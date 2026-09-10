import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentInputItem } from "@openai/agents";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  attachArtifactsToMessage,
  createCsvArtifact,
  createPdfArtifact,
  getArtifact,
  listMessageArtifacts,
} from "@/lib/artifacts";
import {
  beginRunReservation,
  getCreditBalance,
  markRunReconciliationRequired,
  settleRun,
} from "@/lib/credits";
import type { CapturedRunExecutionConfig } from "@/lib/contracts";
import {
  AgentSessionStore,
  createConversation,
  getUserAccount,
  insertMessage,
  listMessages,
  softDeleteConversation,
  updateConversationTitle,
  updateMessage,
} from "@/lib/db";
import {
  getResearchSnapshot,
  listResearchSnapshots,
  saveResearchSnapshot,
} from "@/lib/research";
import {
  cancelAgentRun,
  getAgentRun,
  listConversationRuns,
  readRunEventBatch,
} from "@/lib/runs";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;

function capturedConfig(reservationCredits: number): CapturedRunExecutionConfig {
  return {
    ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
    billing: {
      policyVersion: 1,
      reservationCredits,
      creditsPer1kInputTokens: 1,
      creditsPer1kOutputTokens: 5,
      creditsPerWebSearch: 10,
    },
  };
}

describe.runIf(databaseUrl !== undefined)("PostgreSQL data layer", () => {
  const userId = randomUUID();
  const requestId = randomUUID();
  const secondRequestId = randomUUID();
  const thirdRequestId = randomUUID();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  let database: Pool;
  let artifactDirectory: string;

  beforeAll(async () => {
    database = new Pool({ connectionString: databaseUrl });
    artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "custent-artifacts-"));
    await database.query(
      `
        INSERT INTO users (id, name, available_credits)
        VALUES ($1, 'Integration user', 1000)
      `,
      [userId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM artifacts WHERE user_id = $1", [userId]);
    await database.query("DELETE FROM research_snapshots WHERE user_id = $1", [userId]);
    await database.query("DELETE FROM credit_ledger WHERE user_id = $1", [userId]);
    await database.query("DELETE FROM conversations WHERE user_id = $1", [userId]);
    await database.query("DELETE FROM runs WHERE user_id = $1", [userId]);
    await database.query("DELETE FROM users WHERE id = $1", [userId]);
    await database.end();
    await rm(artifactDirectory, { recursive: true, force: true });
  });

  async function assignRunLease(runId: string) {
    const leaseOwner = randomUUID();
    const result = await database.query<{ lease_token: string }>(
      `
        UPDATE runs
        SET
          status = 'running',
          started_at = now(),
          lease_owner = $2,
          lease_token = lease_token + 1,
          lease_expires_at = now() + interval '5 minutes',
          heartbeat_at = now(),
          updated_at = now()
        WHERE id = $1 AND status = 'queued'
        RETURNING lease_token::text
      `,
      [runId, leaseOwner],
    );
    if (result.rowCount !== 1) {
      throw new Error(`Could not assign a test lease to run ${runId}`);
    }
    return { leaseOwner, leaseToken: result.rows[0].lease_token };
  }

  it("persists chat/session state, settles and freezes credits, and stores artifacts", async () => {
    await expect(getUserAccount(userId, database)).resolves.toEqual({
      user: { id: userId, name: "Integration user" },
      credits: { available: 1_000, reserved: 0 },
    });

    const conversation = await createConversation(userId, "Initial title", database);
    const renamed = await updateConversationTitle(
      conversation.id,
      userId,
      "German pump buyers",
      database,
    );
    expect(renamed.title).toBe("German pump buyers");

    await insertMessage(
      {
        id: userMessageId,
        userId,
        conversationId: conversation.id,
        role: "user",
        content: "Find German industrial pump buyers",
        citations: [],
      },
      database,
    );
    await insertMessage(
      {
        id: assistantMessageId,
        userId,
        conversationId: conversation.id,
        role: "assistant",
        content: "Research in progress",
        citations: [],
      },
      database,
    );

    const session = new AgentSessionStore(conversation.id, database);
    const sessionItems: AgentInputItem[] = [
      { role: "user", content: "Find German industrial pump buyers" },
      {
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "I will research public sources." },
        ],
      },
    ];
    await session.addItems(sessionItems);
    expect(await session.getItems(1)).toEqual([sessionItems[1]]);
    expect(await session.popItem()).toEqual(sessionItems[1]);
    expect(await session.getItems()).toEqual([sessionItems[0]]);
    await session.clearSession();
    expect(await session.getItems()).toEqual([]);

    const reservation = await beginRunReservation(
      {
        userId,
        conversationId: conversation.id,
        requestId,
        reservationCredits: 100,
        executionConfig: capturedConfig(100),
        parentRunId: null,
      },
      database,
    );
    expect(reservation.credits).toEqual({ available: 900, reserved: 100 });
    const lease = await assignRunLease(reservation.run.id);
    const snapshot = await saveResearchSnapshot(
      {
        userId,
        conversationId: conversation.id,
        runId: reservation.run.id,
        ...lease,
        research: {
          title: "German industrial pump buyers",
          querySummary: "Public-source search for German importers.",
          limitations: "No private contact data was used.",
          companies: [
            {
              name: "Example GmbH",
              websiteUrl: "https://example.com",
              country: "Germany",
              companyType: "importer",
              relevanceSummary: "Its catalog lists industrial pumps.",
              evidence: [
                {
                  claim: "The catalog lists industrial pumps.",
                  sourceUrl: "https://example.com/catalog",
                  sourceTitle: "Catalog",
                  supports: "business_fit",
                },
              ],
              contacts: [],
            },
          ],
        },
      },
      database,
    );
    expect(await getResearchSnapshot(userId, snapshot.id, database)).toEqual(snapshot);

    const csv = await createCsvArtifact(
      {
        userId,
        conversationId: conversation.id,
        messageId: null,
        runId: reservation.run.id,
        ...lease,
        snapshot,
        storageDirectory: artifactDirectory,
      },
      database,
    );
    const pdf = await createPdfArtifact(
      {
        userId,
        conversationId: conversation.id,
        messageId: null,
        runId: reservation.run.id,
        ...lease,
        snapshot,
        storageDirectory: artifactDirectory,
      },
      database,
    );
    const settlement = await settleRun(
      {
        userId,
        runId: reservation.run.id,
        usage: { inputTokens: 1_000, outputTokens: 200, webSearches: 1 },
      },
      database,
    );
    expect(settlement.run.chargedCredits).toBe(12);
    expect(settlement.credits).toEqual({ available: 988, reserved: 0 });

    const overrunConversation = await createConversation(
      userId,
      "Credit overrun",
      database,
    );
    const overrun = await beginRunReservation(
      {
        userId,
        conversationId: overrunConversation.id,
        requestId: secondRequestId,
        reservationCredits: 20,
        executionConfig: capturedConfig(20),
        parentRunId: null,
      },
      database,
    );
    await assignRunLease(overrun.run.id);
    await expect(
      settleRun(
        {
          userId,
          runId: overrun.run.id,
          usage: { inputTokens: 0, outputTokens: 0, webSearches: 3 },
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_REQUIRES_RECONCILIATION" });
    expect(await getCreditBalance(userId, database)).toEqual({
      available: 968,
      reserved: 20,
    });

    const exceptionalConversation = await createConversation(
      userId,
      "Unknown provider usage",
      database,
    );
    const exceptional = await beginRunReservation(
      {
        userId,
        conversationId: exceptionalConversation.id,
        requestId: thirdRequestId,
        reservationCredits: 30,
        executionConfig: capturedConfig(30),
        parentRunId: null,
      },
      database,
    );
    const frozen = await markRunReconciliationRequired(
      {
        userId,
        runId: exceptional.run.id,
        reason: "Provider usage was not returned",
      },
      database,
    );
    expect(frozen.credits).toEqual({ available: 938, reserved: 50 });

    const attached = await attachArtifactsToMessage(
      { userId, runId: reservation.run.id, messageId: assistantMessageId },
      database,
    );
    expect(attached.map((artifact) => artifact.id).sort()).toEqual(
      [csv.id, pdf.id].sort(),
    );
    expect(await listMessageArtifacts(userId, assistantMessageId, database)).toHaveLength(
      2,
    );

    const csvRecord = await getArtifact(userId, csv.id, database);
    expect(csvRecord?.mimeType).toBe("text/csv");
    expect((await readFile(csvRecord!.storagePath)).byteLength).toBe(
      csvRecord!.sizeBytes,
    );

    const updatedAssistant = await updateMessage(
      assistantMessageId,
      conversation.id,
      "Research complete",
      [
        {
          url: "https://example.com/catalog",
          title: "Catalog",
          startIndex: 0,
          endIndex: 8,
        },
      ],
      database,
    );
    expect(updatedAssistant.artifacts).toHaveLength(2);
    expect(await listMessages(userId, conversation.id, database)).toHaveLength(2);

    const demoGrant = await database.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM credit_ledger
        WHERE idempotency_key = 'demo-initial-grant-v1' AND entry_type = 'grant'
      `,
    );
    expect(demoGrant.rows[0].count).toBe(1);

    await database.query(
      `
        INSERT INTO run_events (run_id, event_type, payload)
        VALUES ($1, 'status', $2::jsonb)
      `,
      [
        reservation.run.id,
        JSON.stringify({
          type: "status",
          phase: "thinking",
          message: "Historical event before soft deletion",
        }),
      ],
    );
    const visibleEvents = await readRunEventBatch(
      {
        userId,
        runId: reservation.run.id,
        afterEventId: "0",
      },
      database,
    );
    expect(visibleEvents?.events).toHaveLength(1);

    await softDeleteConversation(userId, conversation.id, database);

    await expect(
      getAgentRun(userId, reservation.run.id, database),
    ).resolves.toBeNull();
    await expect(
      readRunEventBatch(
        {
          userId,
          runId: reservation.run.id,
          afterEventId: "0",
        },
        database,
      ),
    ).resolves.toBeNull();
    await expect(
      cancelAgentRun(userId, reservation.run.id, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      listConversationRuns(userId, conversation.id, database),
    ).resolves.toEqual([]);
    await expect(getArtifact(userId, csv.id, database)).resolves.toBeNull();
    await expect(
      listMessageArtifacts(userId, assistantMessageId, database),
    ).resolves.toEqual([]);
    await expect(
      getResearchSnapshot(userId, snapshot.id, database),
    ).resolves.toBeNull();
    await expect(
      listResearchSnapshots(userId, conversation.id, database),
    ).resolves.toEqual([]);
  }, 30_000);
});
