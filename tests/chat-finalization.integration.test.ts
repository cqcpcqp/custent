import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createCsvArtifact,
  createGenericCsvArtifact,
  createGenericPdfArtifact,
  createPdfArtifact,
  getArtifact,
} from "@/lib/artifacts";
import {
  beginRunReservation,
  type CreditRates,
} from "@/lib/credits";
import type { CapturedRunExecutionConfig } from "@/lib/contracts";
import {
  createConversation,
  finalizeSuccessfulChatRun,
  insertMessage,
} from "@/lib/db";
import { saveResearchSnapshot } from "@/lib/research";
import { cancelAgentRun } from "@/lib/runs";
import { writeRunSessionSnapshot } from "@/lib/runs/session-snapshots";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;
const rates: CreditRates = {
  creditsPer1kInputTokens: 1,
  creditsPer1kOutputTokens: 5,
  creditsPerWebSearch: 10,
};

function capturedConfig(
  reservationCredits: number,
  capturedRates: CreditRates = rates,
): CapturedRunExecutionConfig {
  return {
    ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
    billing: {
      policyVersion: 1,
      reservationCredits,
      ...capturedRates,
    },
  };
}

describe.runIf(databaseUrl !== undefined)("atomic chat run finalization", () => {
  const userId = randomUUID();
  let database: Pool;
  let artifactDirectory: string;

  beforeAll(async () => {
    database = new Pool({ connectionString: databaseUrl });
    artifactDirectory = await mkdtemp(path.join(os.tmpdir(), "custent-finalize-"));
    await database.query(
      "INSERT INTO users (id, name, available_credits) VALUES ($1, $2, 500)",
      [userId, "Finalization integration user"],
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

  async function prepareRun() {
    const conversation = await createConversation(userId, "Buyer research", database);
    await insertMessage(
      {
        userId,
        conversationId: conversation.id,
        role: "user",
        content: "Find pump buyers",
        citations: [],
      },
      database,
    );
    const reservation = await beginRunReservation(
      {
        userId,
        conversationId: conversation.id,
        requestId: randomUUID(),
        reservationCredits: 100,
        executionConfig: capturedConfig(100),
        parentRunId: null,
      },
      database,
    );
    const lease = await assignRunLease(reservation.run.id);
    const snapshot = await saveResearchSnapshot(
      {
        userId,
        conversationId: conversation.id,
        runId: reservation.run.id,
        ...lease,
        research: {
          title: "German pump buyers",
          querySummary: "Public-source buyer search.",
          limitations: "Public evidence only.",
          companies: [
            {
              name: "Example GmbH",
              websiteUrl: "https://example.com",
              country: "Germany",
              companyType: "importer",
              relevanceSummary: "Its catalog lists industrial pumps.",
              contacts: [],
              evidence: [
                {
                  claim: "The catalog lists industrial pumps.",
                  sourceUrl: "https://example.com/catalog",
                  sourceTitle: "Catalog",
                  supports: "business_fit",
                },
              ],
            },
          ],
        },
      },
      database,
    );
    return { conversation, reservation, snapshot, lease };
  }

  async function waitForDatabaseLock(applicationName: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await database.query<{ blocked: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock'
          ) AS blocked
        `,
        [applicationName],
      );
      if (result.rows[0].blocked) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${applicationName} to block on a lock`);
  }

  it("commits message, artifact attachment, and credit settlement together", async () => {
    const { conversation, reservation, snapshot, lease } = await prepareRun();
    const assistantMessageId = randomUUID();
    const citations = [
      {
        url: "https://example.com/catalog",
        title: "Catalog",
        startIndex: 0,
        endIndex: 8,
      },
    ];
    await createCsvArtifact(
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
    await createPdfArtifact(
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

    const input = {
      userId,
      conversationId: conversation.id,
      runId: reservation.run.id,
      assistantMessageId,
      content: "Research complete",
      citations,
      usage: { inputTokens: 1_000, outputTokens: 200, webSearches: 1 },
    };
    const finalized = await finalizeSuccessfulChatRun(input, database);

    expect(finalized.message.id).toBe(assistantMessageId);
    expect(finalized.message.artifacts).toEqual(finalized.artifacts);
    expect(finalized.artifacts).toHaveLength(2);
    expect(finalized.credits).toEqual({ available: 488, reserved: 0 });

    const persisted = await database.query<{
      run_id: string;
      attached_count: number;
      settlement_count: number;
    }>(
      `
        SELECT
          message.run_id,
          (
            SELECT COUNT(*)::integer
            FROM artifacts artifact
            WHERE artifact.run_id = $1 AND artifact.message_id = message.id
          ) AS attached_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger ledger
            WHERE ledger.run_id = $1 AND ledger.entry_type = 'settle'
          ) AS settlement_count
        FROM messages message
        WHERE message.id = $2
      `,
      [reservation.run.id, assistantMessageId],
    );
    expect(persisted.rows[0]).toEqual({
      run_id: reservation.run.id,
      attached_count: 2,
      settlement_count: 1,
    });

    const retried = await finalizeSuccessfulChatRun(input, database);
    expect(retried).toEqual(finalized);
    const retriedAfterRateChange = await finalizeSuccessfulChatRun(
      input,
      database,
    );
    expect(retriedAfterRateChange).toEqual(finalized);
    await expect(
      finalizeSuccessfulChatRun(
        { ...input, content: "Different final content" },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    await expect(
      finalizeSuccessfulChatRun(
        {
          ...input,
          usage: { ...input.usage, outputTokens: input.usage.outputTokens + 1 },
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    await expect(
      finalizeSuccessfulChatRun(
        { ...input, assistantMessageId: randomUUID() },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    const ledgerAfterRetry = await database.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM credit_ledger
        WHERE run_id = $1 AND entry_type = 'settle'
      `,
      [reservation.run.id],
    );
    expect(ledgerAfterRetry.rows[0].count).toBe(1);

    const filesBeforeLateWrite = await readdir(path.join(artifactDirectory, userId));
    await expect(
      createCsvArtifact(
        {
          userId,
          conversationId: conversation.id,
          messageId: null,
          runId: reservation.run.id,
          ...lease,
          snapshot,
          storageDirectory: artifactDirectory,
          name: "late.csv",
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS" });
    expect(await readdir(path.join(artifactDirectory, userId))).toEqual(
      filesBeforeLateWrite,
    );
  });

  it("rejects settlement after cancellation has been requested", async () => {
    const { conversation, reservation } = await prepareRun();
    await database.query(
      `
        UPDATE runs
        SET model_started_at = now(), updated_at = now()
        WHERE id = $1
      `,
      [reservation.run.id],
    );
    const cancellation = await cancelAgentRun(
      userId,
      reservation.run.id,
      database,
    );
    expect(cancellation.status).toBe("running");

    await expect(
      finalizeSuccessfulChatRun(
        {
          userId,
          conversationId: conversation.id,
          runId: reservation.run.id,
          assistantMessageId: randomUUID(),
          content: "This answer must not settle after cancellation.",
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 },
        },
        database,
      ),
    ).rejects.toMatchObject({
      code: "RUN_IN_PROGRESS",
      message: "Run cancellation is pending",
    });

    const persisted = await database.query<{
      status: string;
      cancel_requested_at: Date | null;
      settlement_count: number;
    }>(
      `
        SELECT
          run.status,
          run.cancel_requested_at,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger ledger
            WHERE ledger.run_id = run.id AND ledger.entry_type = 'settle'
          ) AS settlement_count
        FROM runs run
        WHERE run.id = $1
      `,
      [reservation.run.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      status: "running",
      settlement_count: 0,
    });
    expect(persisted.rows[0].cancel_requested_at).toBeInstanceOf(Date);
  });

  it("rolls settlement and final message back when artifact binding conflicts", async () => {
    const { conversation, reservation, snapshot, lease } = await prepareRun();
    const otherMessageId = randomUUID();
    const finalMessageId = randomUUID();
    await insertMessage(
      {
        id: otherMessageId,
        userId,
        conversationId: conversation.id,
        role: "assistant",
        content: "Unrelated assistant message",
        citations: [],
      },
      database,
    );
    await createCsvArtifact(
      {
        userId,
        conversationId: conversation.id,
        messageId: otherMessageId,
        runId: reservation.run.id,
        ...lease,
        snapshot,
        storageDirectory: artifactDirectory,
      },
      database,
    );

    await expect(
      finalizeSuccessfulChatRun(
        {
          userId,
          conversationId: conversation.id,
          runId: reservation.run.id,
          assistantMessageId: finalMessageId,
          content: "Should roll back",
          citations: [],
          usage: { inputTokens: 1, outputTokens: 0, webSearches: 0 },
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const state = await database.query<{
      status: string;
      charged_credits: number | null;
      final_message_count: number;
      settlement_count: number;
    }>(
      `
        SELECT
          run.status,
          run.charged_credits,
          (
            SELECT COUNT(*)::integer FROM messages WHERE id = $2
          ) AS final_message_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger
            WHERE run_id = run.id AND entry_type = 'settle'
          ) AS settlement_count
        FROM runs run
        WHERE run.id = $1
      `,
      [reservation.run.id, finalMessageId],
    );
    expect(state.rows[0]).toEqual({
      status: "running",
      charged_credits: null,
      final_message_count: 0,
      settlement_count: 0,
    });
  });

  it("finalizes generic CSV and PDF artifacts without a snapshot link", async () => {
    const { conversation, reservation, lease } = await prepareRun();
    const csv = await createGenericCsvArtifact(
      {
        userId,
        conversationId: conversation.id,
        messageId: null,
        runId: reservation.run.id,
        ...lease,
        storageDirectory: artifactDirectory,
        request: {
          fileName: "current-table",
          columns: ["company", "priority"],
          rows: [
            ["Acme", "=1+1"],
            ["Example GmbH", "High"],
          ],
        },
      },
      database,
    );
    const pdf = await createGenericPdfArtifact(
      {
        userId,
        conversationId: conversation.id,
        messageId: null,
        runId: reservation.run.id,
        ...lease,
        storageDirectory: artifactDirectory,
        request: {
          fileName: "current-summary.pdf",
          title: "Current conversation summary",
          sections: [
            {
              heading: "Decision",
              body: "Contact Example GmbH first.",
            },
          ],
        },
      },
      database,
    );
    const assistantMessageId = randomUUID();
    const finalized = await finalizeSuccessfulChatRun(
      {
        userId,
        conversationId: conversation.id,
        runId: reservation.run.id,
        assistantMessageId,
        content: "Generated files from the current conversation.",
        citations: [],
        usage: { inputTokens: 1, outputTokens: 1, webSearches: 0 },
      },
      database,
    );

    expect(finalized.artifacts.map((item) => item.id).sort()).toEqual(
      [csv.id, pdf.id].sort(),
    );
    const [csvRecord, pdfRecord] = await Promise.all([
      getArtifact(userId, csv.id, database),
      getArtifact(userId, pdf.id, database),
    ]);
    expect(csvRecord).toMatchObject({
      messageId: assistantMessageId,
      researchSnapshotId: null,
      name: "current-table.csv",
      mimeType: "text/csv",
    });
    expect(pdfRecord).toMatchObject({
      messageId: assistantMessageId,
      researchSnapshotId: null,
      name: "current-summary.pdf",
      mimeType: "application/pdf",
    });
    expect((await readFile(csvRecord!.storagePath, "utf8"))).toContain(
      '"\'=1+1"',
    );
  });

  it("commits reconciliation freeze without finalizing the message or artifacts", async () => {
    const { conversation, reservation, snapshot, lease } = await prepareRun();
    const assistantMessageId = randomUUID();
    await createCsvArtifact(
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

    await expect(
      finalizeSuccessfulChatRun(
        {
          userId,
          conversationId: conversation.id,
          runId: reservation.run.id,
          assistantMessageId,
          content: "Must not be persisted",
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0, webSearches: 11 },
        },
        database,
      ),
    ).rejects.toMatchObject({
      code: "RUN_REQUIRES_RECONCILIATION",
      status: 409,
    });

    const state = await database.query<{
      status: string;
      final_message_count: number;
      freeze_count: number;
      unattached_artifact_count: number;
    }>(
      `
        SELECT
          run.status,
          (
            SELECT COUNT(*)::integer FROM messages WHERE id = $2
          ) AS final_message_count,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger
            WHERE run_id = run.id AND entry_type = 'freeze'
          ) AS freeze_count,
          (
            SELECT COUNT(*)::integer
            FROM artifacts
            WHERE run_id = run.id AND message_id IS NULL
          ) AS unattached_artifact_count
        FROM runs run
        WHERE run.id = $1
      `,
      [reservation.run.id, assistantMessageId],
    );
    expect(state.rows[0]).toEqual({
      status: "reconciliation_required",
      final_message_count: 0,
      freeze_count: 1,
      unattached_artifact_count: 1,
    });
  });

  it("exports an earlier snapshot from a later run in the same conversation", async () => {
    const { conversation, reservation, snapshot } = await prepareRun();
    await finalizeSuccessfulChatRun(
      {
        userId,
        conversationId: conversation.id,
        runId: reservation.run.id,
        assistantMessageId: randomUUID(),
        content: "Initial research complete",
        citations: [],
        usage: { inputTokens: 1, outputTokens: 0, webSearches: 0 },
      },
      database,
    );
    await writeRunSessionSnapshot(reservation.run.id, "post", [], database);

    const laterRun = await beginRunReservation(
      {
        userId,
        conversationId: conversation.id,
        requestId: randomUUID(),
        reservationCredits: 100,
        executionConfig: capturedConfig(100),
        parentRunId: reservation.run.id,
      },
      database,
    );
    const laterLease = await assignRunLease(laterRun.run.id);
    const artifact = await createCsvArtifact(
      {
        userId,
        conversationId: conversation.id,
        messageId: null,
        runId: laterRun.run.id,
        ...laterLease,
        snapshot,
        storageDirectory: artifactDirectory,
      },
      database,
    );
    const finalized = await finalizeSuccessfulChatRun(
      {
        userId,
        conversationId: conversation.id,
        runId: laterRun.run.id,
        assistantMessageId: randomUUID(),
        content: "Exported the earlier research",
        citations: [],
        usage: { inputTokens: 1, outputTokens: 0, webSearches: 0 },
      },
      database,
    );

    expect(finalized.artifacts.map((item) => item.id)).toEqual([artifact.id]);
  });

  it("serializes finalization against concurrent artifact creation", async () => {
    const { conversation, reservation, snapshot, lease } = await prepareRun();
    const assistantMessageId = randomUUID();
    const finalizerApplicationName = `custent-finalizer-${randomUUID()}`;
    const artifactApplicationName = `custent-artifact-${randomUUID()}`;
    const finalizerDatabase = new Pool({
      connectionString: databaseUrl,
      application_name: finalizerApplicationName,
      max: 1,
    });
    const artifactDatabase = new Pool({
      connectionString: databaseUrl,
      application_name: artifactApplicationName,
      max: 1,
    });
    const blocker = await database.connect();
    let blockerTransactionOpen = true;

    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runs WHERE id = $1 FOR UPDATE", [
        reservation.run.id,
      ]);

      const finalizationPromise = finalizeSuccessfulChatRun(
        {
          userId,
          conversationId: conversation.id,
          runId: reservation.run.id,
          assistantMessageId,
          content: "Concurrent completion",
          citations: [],
          usage: { inputTokens: 1, outputTokens: 0, webSearches: 0 },
        },
        finalizerDatabase,
      );
      await waitForDatabaseLock(finalizerApplicationName);

      const artifactCreationPromise = createCsvArtifact(
        {
          userId,
          conversationId: conversation.id,
          messageId: null,
          runId: reservation.run.id,
          ...lease,
          snapshot,
          storageDirectory: artifactDirectory,
        },
        artifactDatabase,
      );
      const outcomesPromise = Promise.allSettled([
        finalizationPromise,
        artifactCreationPromise,
      ]);
      await waitForDatabaseLock(artifactApplicationName);

      await blocker.query("COMMIT");
      blockerTransactionOpen = false;
      const [finalization, artifactCreation] = await outcomesPromise;

      expect(finalization.status).toBe("fulfilled");
      expect(artifactCreation.status).toBe("rejected");
      if (artifactCreation.status === "rejected") {
        expect(artifactCreation.reason).toMatchObject({
          code: "RUN_ALREADY_EXISTS",
          status: 409,
        });
      }
      const unattached = await database.query<{ count: number }>(
        `
          SELECT COUNT(*)::integer AS count
          FROM artifacts
          WHERE run_id = $1 AND message_id IS NULL
        `,
        [reservation.run.id],
      );
      expect(unattached.rows[0].count).toBe(0);
    } finally {
      if (blockerTransactionOpen) {
        await blocker.query("ROLLBACK");
      }
      blocker.release();
      await finalizerDatabase.end();
      await artifactDatabase.end();
    }
  });
});
