import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { beginRunReservation, markRunRunning } from "@/lib/credits";
import {
  archiveAllConversations,
  createConversation,
  getConversation,
  getPublicConversationShare,
  insertMessage,
  listConversationPage,
  patchConversation,
  softDeleteAllConversations,
  softDeleteConversation,
  withTransaction,
} from "@/lib/db";
import { getInputAttachmentContentRecord } from "@/lib/input-attachments";
import {
  cancelAgentRun,
  enqueueChatRun,
  regenerateAgentRun,
  retryAgentRun,
} from "@/lib/runs";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;

function capturedConfig(reservationCredits = 20) {
  return {
    ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
    billing: {
      ...TEST_CAPTURED_RUN_EXECUTION_CONFIG.billing,
      reservationCredits,
    },
  };
}

describe.runIf(databaseUrl !== undefined)(
  "bulk conversation mutations PostgreSQL flow",
  () => {
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
      await database.query(
        "DELETE FROM runs WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query(
        "DELETE FROM input_attachments WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query(
        "DELETE FROM input_attachment_deletions WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query(
        "DELETE FROM users WHERE id = ANY($1::uuid[])",
        [userIds],
      );
      await database.end();
    });

    async function createTestUser(name: string): Promise<string> {
      const userId = randomUUID();
      userIds.push(userId);
      await database.query(
        `
          INSERT INTO users (id, name, available_credits)
          VALUES ($1, $2, 1000)
        `,
        [userId, name],
      );
      return userId;
    }

    async function bindTextAttachment(input: {
      userId: string;
      conversationId: string;
      content: string;
    }): Promise<string> {
      const message = await insertMessage(
        {
          userId: input.userId,
          conversationId: input.conversationId,
          role: "user",
          content: input.content,
          citations: [],
        },
        database,
      );
      const attachmentId = randomUUID();
      await withTransaction(async (client) => {
        await client.query(
          `
            INSERT INTO input_attachments (
              id,
              user_id,
              kind,
              original_name,
              mime_type,
              size_bytes,
              sha256,
              storage_path,
              attached_at
            )
            VALUES (
              $1::uuid,
              $2,
              'file',
              'buyers.txt',
              'text/plain',
              4,
              $3,
              $1::uuid::text,
              now()
            )
          `,
          [attachmentId, input.userId, "a".repeat(64)],
        );
        await client.query(
          `
            INSERT INTO message_input_attachments (
              message_id,
              attachment_id,
              position
            )
            VALUES ($1, $2, 0)
          `,
          [message.id, attachmentId],
        );
      }, database);
      return attachmentId;
    }

    async function insertShare(
      conversationId: string,
      title: string,
    ): Promise<string> {
      const publicId = randomUUID();
      await database.query(
        `
          INSERT INTO conversation_shares (
            conversation_id,
            public_id,
            title,
            messages
          )
          VALUES ($1, $2, $3, $4::jsonb)
        `,
        [
          conversationId,
          publicId,
          title,
          JSON.stringify([
            {
              id: randomUUID(),
              role: "user",
              content: "Shared buyer research",
              citations: [],
              createdAt: new Date().toISOString(),
              files: [],
            },
          ]),
        ],
      );
      return publicId;
    }

    it("archives only active owned conversations, preserves resources, and is empty-idempotent", async () => {
      const ownerId = await createTestUser("Bulk archive owner");
      const otherUserId = await createTestUser("Bulk archive other user");
      const active = await createConversation(
        ownerId,
        "Archive active buyers",
        database,
      );
      const pinned = await patchConversation(
        ownerId,
        active.id,
        { action: "set_pinned", pinned: true },
        database,
      );
      const attachmentId = await bindTextAttachment({
        userId: ownerId,
        conversationId: active.id,
        content: "Archive attachment owner",
      });
      const publicId = await insertShare(active.id, active.title);

      const alreadyArchived = await createConversation(
        ownerId,
        "Already archived buyers",
        database,
      );
      const archivedBefore = await patchConversation(
        ownerId,
        alreadyArchived.id,
        { action: "set_archived", archived: true },
        database,
      );
      const alreadyDeleted = await createConversation(
        ownerId,
        "Already deleted buyers",
        database,
      );
      await softDeleteConversation(ownerId, alreadyDeleted.id, database);
      const runMutationSource = await createConversation(
        ownerId,
        "Archived Run mutation source",
        database,
      );
      const terminalSource = await beginRunReservation(
        {
          userId: ownerId,
          conversationId: runMutationSource.id,
          requestId: randomUUID(),
          reservationCredits: 20,
          parentRunId: null,
          executionConfig: capturedConfig(),
        },
        database,
      );
      await cancelAgentRun(ownerId, terminalSource.run.id, database);
      const foreign = await createConversation(
        otherUserId,
        "Foreign active buyers",
        database,
      );

      const mutation = await archiveAllConversations(ownerId, database);

      expect(mutation).toMatchObject({
        action: "archive_all",
        conversationCount: 2,
      });
      expect(new Date(mutation.completedAt).toISOString()).toBe(
        mutation.completedAt,
      );
      await expect(
        getConversation(ownerId, active.id, database),
      ).resolves.toMatchObject({
        archivedAt: expect.any(String),
        pinnedAt: pinned.pinnedAt,
      });
      await expect(
        getConversation(ownerId, alreadyArchived.id, database),
      ).resolves.toMatchObject({ archivedAt: archivedBefore.archivedAt });
      await expect(
        getConversation(otherUserId, foreign.id, database),
      ).resolves.toMatchObject({ archivedAt: null });
      await expect(
        getInputAttachmentContentRecord(ownerId, attachmentId, database),
      ).resolves.not.toBeNull();
      await expect(
        getPublicConversationShare(publicId, database),
      ).resolves.not.toBeNull();

      await expect(
        enqueueChatRun(
          {
            userId: ownerId,
            request: {
              kind: "append",
              conversationId: active.id,
              parentRunId: null,
              message: "Must not enqueue after bulk archive",
              attachmentIds: [],
              requestId: randomUUID(),
              executionProfileId: "standard_research",
            },
            executionConfig: capturedConfig(),
            maxAttachmentCount: 5,
            maxAttachmentTotalBytes: 20 * 1024 * 1024,
          },
          database,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

      const retryRequestId = randomUUID();
      const regenerateRequestId = randomUUID();
      await expect(
        retryAgentRun(
          {
            userId: ownerId,
            sourceRunId: terminalSource.run.id,
            requestId: retryRequestId,
          },
          database,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        regenerateAgentRun(
          {
            userId: ownerId,
            sourceRunId: terminalSource.run.id,
            requestId: regenerateRequestId,
          },
          database,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      const bypassRuns = await database.query<{ count: number }>(
        `
          SELECT COUNT(*)::integer AS count
          FROM runs
          WHERE request_id = ANY($1::uuid[])
        `,
        [[retryRequestId, regenerateRequestId]],
      );
      expect(bypassRuns.rows[0].count).toBe(0);

      await expect(
        archiveAllConversations(ownerId, database),
      ).resolves.toMatchObject({
        action: "archive_all",
        conversationCount: 0,
      });
    });

    it("rejects archive-all and delete-all atomically for every outstanding Run state", async () => {
      for (const status of ["queued", "running", "waiting"] as const) {
        const ownerId = await createTestUser(`Bulk conflict ${status}`);
        const blocked = await createConversation(
          ownerId,
          `Blocked ${status}`,
          database,
        );
        const idle = await createConversation(
          ownerId,
          `Idle beside ${status}`,
          database,
        );
        const predecessor = await beginRunReservation(
          {
            userId: ownerId,
            conversationId: blocked.id,
            requestId: randomUUID(),
            reservationCredits: 20,
            parentRunId: null,
            executionConfig: capturedConfig(),
          },
          database,
        );

        if (status === "running") {
          await markRunRunning(ownerId, predecessor.run.id, database);
        } else if (status === "waiting") {
          const waiting = await enqueueChatRun(
            {
              userId: ownerId,
              request: {
                kind: "append",
                conversationId: blocked.id,
                parentRunId: predecessor.run.id,
                message: "Wait behind predecessor",
                attachmentIds: [],
                requestId: randomUUID(),
                executionProfileId: "standard_research",
              },
              executionConfig: capturedConfig(),
              maxAttachmentCount: 5,
              maxAttachmentTotalBytes: 20 * 1024 * 1024,
            },
            database,
          );
          expect(waiting.run.status).toBe("waiting");
          await cancelAgentRun(ownerId, predecessor.run.id, database);
        }

        await expect(
          archiveAllConversations(ownerId, database),
        ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });
        await expect(
          softDeleteAllConversations(ownerId, database),
        ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });

        const unchanged = await database.query<{
          id: string;
          archived_at: Date | null;
          deleted_at: Date | null;
        }>(
          `
            SELECT id, archived_at, deleted_at
            FROM conversations
            WHERE id = ANY($1::uuid[])
            ORDER BY id
          `,
          [[blocked.id, idle.id]],
        );
        expect(unchanged.rows).toHaveLength(2);
        expect(
          unchanged.rows.every(
            (row) => row.archived_at === null && row.deleted_at === null,
          ),
        ).toBe(true);
      }
    });

    it.each([
      ["retry", retryAgentRun] as const,
      ["regenerate", regenerateAgentRun] as const,
    ])("rejects a %s that was waiting on the row lock when archive commits", async (_name, mutateRun) => {
      const ownerId = await createTestUser(`Concurrent archived ${_name}`);
      const conversation = await createConversation(
        ownerId,
        `Concurrent ${_name} source`,
        database,
      );
      const source = await beginRunReservation(
        {
          userId: ownerId,
          conversationId: conversation.id,
          requestId: randomUUID(),
          reservationCredits: 20,
          parentRunId: null,
          executionConfig: capturedConfig(),
        },
        database,
      );
      await cancelAgentRun(ownerId, source.run.id, database);

      const applicationName = `bulk_archive_${_name}_${randomUUID()}`;
      const mutationDatabase = new Pool({
        connectionString: databaseUrl,
        application_name: applicationName,
        max: 1,
      });
      const archiveClient = await database.connect();
      const requestId = randomUUID();
      let archiveCommitted = false;
      try {
        await archiveClient.query("BEGIN");
        await archiveClient.query(
          "SELECT id FROM conversations WHERE id = $1 FOR UPDATE",
          [conversation.id],
        );
        await archiveClient.query(
          "UPDATE conversations SET archived_at = now() WHERE id = $1",
          [conversation.id],
        );

        const mutationResult = mutateRun(
          {
            userId: ownerId,
            sourceRunId: source.run.id,
            requestId,
          },
          mutationDatabase,
        ).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );

        await expect.poll(
          async () => {
            const waiting = await database.query<{ count: number }>(
              `
                SELECT COUNT(*)::integer AS count
                FROM pg_stat_activity
                WHERE
                  application_name = $1
                  AND wait_event_type = 'Lock'
              `,
              [applicationName],
            );
            return waiting.rows[0].count;
          },
          { timeout: 5_000 },
        ).toBe(1);

        await archiveClient.query("COMMIT");
        archiveCommitted = true;
        const settled = await mutationResult;
        expect(settled.value).toBeNull();
        expect(settled.error).toMatchObject({
          code: "NOT_FOUND",
          status: 404,
        });

        const bypassRun = await database.query<{ count: number }>(
          `
            SELECT COUNT(*)::integer AS count
            FROM runs
            WHERE request_id = $1
          `,
          [requestId],
        );
        expect(bypassRun.rows[0].count).toBe(0);
      } finally {
        if (!archiveCommitted) {
          await archiveClient.query("ROLLBACK");
        }
        archiveClient.release();
        await mutationDatabase.end();
      }
    });

    it("soft-deletes active and archived owned conversations, revokes shares, and keeps attachment bytes tombstone-free", async () => {
      const ownerId = await createTestUser("Bulk delete owner");
      const otherUserId = await createTestUser("Bulk delete other user");
      const active = await createConversation(
        ownerId,
        "Delete active buyers",
        database,
      );
      const archived = await createConversation(
        ownerId,
        "Delete archived buyers",
        database,
      );
      await patchConversation(
        ownerId,
        archived.id,
        { action: "set_archived", archived: true },
        database,
      );
      const alreadyDeleted = await createConversation(
        ownerId,
        "Excluded deleted buyers",
        database,
      );
      await softDeleteConversation(ownerId, alreadyDeleted.id, database);
      const foreign = await createConversation(
        otherUserId,
        "Foreign retained buyers",
        database,
      );
      const attachmentId = await bindTextAttachment({
        userId: ownerId,
        conversationId: active.id,
        content: "Delete attachment owner",
      });
      const activePublicId = await insertShare(active.id, active.title);
      const archivedPublicId = await insertShare(archived.id, archived.title);
      const foreignPublicId = await insertShare(foreign.id, foreign.title);

      const mutation = await softDeleteAllConversations(ownerId, database);

      expect(mutation).toMatchObject({
        action: "delete_all",
        conversationCount: 2,
      });
      expect(new Date(mutation.completedAt).toISOString()).toBe(
        mutation.completedAt,
      );
      await expect(
        getConversation(ownerId, active.id, database),
      ).resolves.toBeNull();
      await expect(
        getConversation(ownerId, archived.id, database),
      ).resolves.toBeNull();
      await expect(
        getConversation(otherUserId, foreign.id, database),
      ).resolves.toMatchObject({ id: foreign.id, archivedAt: null });
      for (const view of ["active", "archived"] as const) {
        await expect(
          listConversationPage(
            { userId: ownerId, view, query: "", cursor: null, limit: 30 },
            database,
          ),
        ).resolves.toEqual({ items: [], nextCursor: null });
      }

      await expect(
        getPublicConversationShare(activePublicId, database),
      ).resolves.toBeNull();
      await expect(
        getPublicConversationShare(archivedPublicId, database),
      ).resolves.toBeNull();
      await expect(
        getPublicConversationShare(foreignPublicId, database),
      ).resolves.not.toBeNull();
      await expect(
        getInputAttachmentContentRecord(ownerId, attachmentId, database),
      ).resolves.toBeNull();

      const retainedAttachment = await database.query(
        "SELECT 1 FROM input_attachments WHERE id = $1",
        [attachmentId],
      );
      expect(retainedAttachment.rowCount).toBe(1);
      const deletionJob = await database.query(
        "SELECT 1 FROM input_attachment_deletions WHERE attachment_id = $1",
        [attachmentId],
      );
      expect(deletionJob.rowCount).toBe(0);

      const retainedShares = await database.query<{ public_id: string }>(
        `
          SELECT public_id
          FROM conversation_shares
          WHERE public_id = ANY($1::uuid[])
          ORDER BY public_id
        `,
        [[activePublicId, archivedPublicId, foreignPublicId]],
      );
      expect(retainedShares.rows.map((row) => row.public_id)).toEqual([
        foreignPublicId,
      ]);

      await expect(
        softDeleteAllConversations(ownerId, database),
      ).resolves.toMatchObject({
        action: "delete_all",
        conversationCount: 0,
      });
    });
  },
);
