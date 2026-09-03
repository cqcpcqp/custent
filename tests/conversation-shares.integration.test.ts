import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getConversationShare,
  getPublicConversationShare,
  listConversationSharePage,
  putConversationShare,
  revokeConversationShare,
  softDeleteConversation,
} from "@/lib/db";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const assertionsDirectory = path.resolve(process.cwd(), "db/assertions");
const migrationFilenames = [
  "001_initial.sql",
  "002_run_finalization.sql",
  "003_run_integrity.sql",
  "004_durable_agent_runs.sql",
  "005_conversation_lifecycle.sql",
  "006_input_attachments.sql",
  "007_input_attachment_lifecycle.sql",
  "008_conversation_attention.sql",
  "009_run_turn_queue.sql",
  "010_retry_predecessor_integrity.sql",
  "011_legacy_run_message_links.sql",
  "012_generic_artifacts.sql",
  "013_message_feedback.sql",
  "014_done_event_message_feedback.sql",
  "015_run_regeneration_snapshots.sql",
  "016_conversation_branches.sql",
  "017_input_attachment_formats.sql",
  "018_tracked_conversation_indexes.sql",
  "019_conversation_search_indexes.sql",
  "020_conversation_shares.sql",
  "025_conversation_share_management_index.sql",
] as const;

type CompletedRunFixture = {
  assistantContent: string;
  assistantId: string;
  citations?: unknown[];
  conversationId: string;
  conversationTurn: number;
  createdAt: string;
  predecessorRunId: string | null;
  runId: string;
  userContent: string;
  userId: string;
  userMessageId: string;
};

async function insertCompletedRun(
  client: PoolClient,
  fixture: CompletedRunFixture,
): Promise<void> {
  await client.query(
    `
      INSERT INTO messages (
        id,
        conversation_id,
        role,
        content,
        citations,
        created_at
      )
      VALUES
        ($1, $2, 'user', $3, '[]'::jsonb, $4::timestamptz),
        ($5, $2, 'assistant', $6, $7::jsonb, $4::timestamptz + interval '1 second')
    `,
    [
      fixture.userMessageId,
      fixture.conversationId,
      fixture.userContent,
      fixture.createdAt,
      fixture.assistantId,
      fixture.assistantContent,
      JSON.stringify(fixture.citations ?? []),
    ],
  );
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
        conversation_turn,
        attempt_index,
        predecessor_run_id,
        attempt_count,
        created_at,
        started_at,
        completed_at,
        finished_at,
        updated_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'completed',
        10,
        1,
        10,
        10,
        1,
        $5,
        $6,
        $7,
        1,
        $8,
        1,
        $9::timestamptz,
        $9::timestamptz,
        $9::timestamptz + interval '2 seconds',
        $9::timestamptz + interval '2 seconds',
        $9::timestamptz + interval '2 seconds'
      )
    `,
    [
      fixture.runId,
      randomUUID(),
      fixture.userId,
      fixture.conversationId,
      fixture.userMessageId,
      fixture.assistantId,
      fixture.conversationTurn,
      fixture.predecessorRunId,
      fixture.createdAt,
    ],
  );
  await client.query(
    "UPDATE messages SET run_id = $1 WHERE id = ANY($2::uuid[])",
    [fixture.runId, [fixture.userMessageId, fixture.assistantId]],
  );
}

describe.runIf(databaseUrl !== undefined)(
  "conversation share PostgreSQL repository",
  () => {
    const ownerId = randomUUID();
    const otherUserId = randomUUID();
    const schemaName = `conversation_shares_${randomUUID().replaceAll("-", "")}`;
    let adminDatabase: Pool;
    let database: Pool;

    beforeAll(async () => {
      adminDatabase = new Pool({ connectionString: databaseUrl, max: 1 });
      await adminDatabase.query(`CREATE SCHEMA ${schemaName}`);
      database = new Pool({
        connectionString: databaseUrl,
        max: 1,
        options: `-c search_path=${schemaName},public`,
      });
      for (const filename of migrationFilenames) {
        await database.query(
          await readFile(path.join(migrationsDirectory, filename), "utf8"),
        );
      }
      await database.query(
        `
          INSERT INTO users (id, name, available_credits)
          VALUES
            ($1, 'Share owner', 100),
            ($2, 'Share other user', 100)
        `,
        [ownerId, otherUserId],
      );
    }, 30_000);

    afterAll(async () => {
      await database.end();
      await adminDatabase.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.end();
    });

    it("publishes only the selected branch, refreshes a stable share, and revokes it", async () => {
      const conversationId = randomUUID();
      const rootRunId = randomUUID();
      const selectedRunId = randomUUID();
      const siblingRunId = randomUUID();
      const rootUserMessageId = randomUUID();
      const rootAssistantId = randomUUID();
      const selectedUserMessageId = randomUUID();
      const selectedAssistantId = randomUUID();
      const siblingUserMessageId = randomUUID();
      const siblingAssistantId = randomUUID();
      const attachmentId = randomUUID();
      const artifactId = randomUUID();
      const citation = {
        url: "https://buyer.example/source",
        title: "Buyer source",
        startIndex: 0,
        endIndex: 8,
      };
      const privateArtifactUrl =
        `/api/artifacts/${artifactId}/download`;
      const privateAttachmentUrl =
        `https://custent.example/api/input-attachments/${attachmentId}/content?download=1`;
      const privateCitation = {
        url: privateAttachmentUrl,
        title: "Private attachment",
        startIndex: 9,
        endIndex: 15,
      };
      const selectedAssistantContent =
        `Selected answer [CSV](${privateArtifactUrl}) and ` +
        `[brief](${privateAttachmentUrl}).`;

      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
            INSERT INTO conversations (id, user_id, title, archived_at)
            VALUES ($1, $2, 'Selected buyers', now())
          `,
          [conversationId, ownerId],
        );
        await insertCompletedRun(client, {
          assistantContent: "Root answer",
          assistantId: rootAssistantId,
          conversationId,
          conversationTurn: 1,
          createdAt: "2026-08-28T08:00:00Z",
          predecessorRunId: null,
          runId: rootRunId,
          userContent: "Root question",
          userId: ownerId,
          userMessageId: rootUserMessageId,
        });
        await insertCompletedRun(client, {
          assistantContent: "Sibling answer must stay private",
          assistantId: siblingAssistantId,
          conversationId,
          conversationTurn: 2,
          createdAt: "2026-08-28T08:01:00Z",
          predecessorRunId: rootRunId,
          runId: siblingRunId,
          userContent: "Sibling question must stay private",
          userId: ownerId,
          userMessageId: siblingUserMessageId,
        });
        await insertCompletedRun(client, {
          assistantContent: selectedAssistantContent,
          assistantId: selectedAssistantId,
          citations: [citation, privateCitation],
          conversationId,
          conversationTurn: 2,
          createdAt: "2026-08-28T08:02:00Z",
          predecessorRunId: rootRunId,
          runId: selectedRunId,
          userContent: "Selected question",
          userId: ownerId,
          userMessageId: selectedUserMessageId,
        });
        await client.query(
          "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
          [conversationId, selectedRunId],
        );
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
            VALUES ($1, $2, 'file', 'brief.txt', 'text/plain', 123, $3, $4, now())
          `,
          [attachmentId, ownerId, "a".repeat(64), attachmentId],
        );
        await client.query(
          `
            INSERT INTO message_input_attachments (message_id, attachment_id, position)
            VALUES ($1, $2, 0)
          `,
          [selectedUserMessageId, attachmentId],
        );
        await client.query(
          `
            INSERT INTO artifacts (
              id,
              user_id,
              conversation_id,
              message_id,
              run_id,
              research_snapshot_id,
              name,
              mime_type,
              size_bytes,
              sha256,
              storage_path
            )
            VALUES ($1, $2, $3, $4, $5, NULL, 'buyers.csv', 'text/csv', 456, $6, $7)
          `,
          [
            artifactId,
            ownerId,
            conversationId,
            selectedAssistantId,
            selectedRunId,
            "b".repeat(64),
            `/tmp/${artifactId}`,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await expect(
        getConversationShare(ownerId, conversationId, database),
      ).resolves.toBeNull();
      for (const operation of [getConversationShare, putConversationShare]) {
        await expect(
          operation(otherUserId, conversationId, database),
        ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      }

      const firstShare = await putConversationShare(
        ownerId,
        conversationId,
        database,
      );
      await expect(
        listConversationSharePage(
          { userId: ownerId, cursor: null, limit: 30 },
          database,
        ),
      ).resolves.toEqual({
        items: [{ ...firstShare, title: "Selected buyers" }],
        nextCursor: null,
      });
      await expect(
        listConversationSharePage(
          { userId: otherUserId, cursor: null, limit: 30 },
          database,
        ),
      ).resolves.toEqual({ items: [], nextCursor: null });
      const firstPublic = await getPublicConversationShare(
        firstShare.publicId,
        database,
      );
      expect(firstPublic).toMatchObject({
        title: "Selected buyers",
        messages: [
          { id: rootUserMessageId, content: "Root question", files: [] },
          { id: rootAssistantId, content: "Root answer", files: [] },
          {
            id: selectedUserMessageId,
            content: "Selected question",
            files: [
              {
                kind: "input_attachment",
                name: "brief.txt",
                mimeType: "text/plain",
                sizeBytes: 123,
              },
            ],
          },
          {
            id: selectedAssistantId,
            content: expect.stringContaining("Selected answer"),
            citations: [citation],
            files: [
              {
                kind: "artifact",
                name: "buyers.csv",
                mimeType: "text/csv",
                sizeBytes: 456,
              },
            ],
          },
        ],
      });
      expect(JSON.stringify(firstPublic)).not.toContain(siblingRunId);
      expect(JSON.stringify(firstPublic)).not.toContain("Sibling question");
      expect(JSON.stringify(firstPublic)).not.toContain("/api/artifacts/");
      expect(JSON.stringify(firstPublic)).not.toContain(
        "/api/input-attachments/",
      );
      expect(JSON.stringify(firstPublic)).not.toContain(artifactId);
      expect(JSON.stringify(firstPublic)).not.toContain(attachmentId);
      expect(firstPublic!.messages.at(-1)?.content).toHaveLength(
        selectedAssistantContent.length,
      );
      expect(
        firstPublic!.messages.at(-1)?.content.slice(
          citation.startIndex,
          citation.endIndex,
        ),
      ).toBe("Selected");
      const storedShare = await database.query<{ messages: unknown }>(
        "SELECT messages FROM conversation_shares WHERE conversation_id = $1",
        [conversationId],
      );
      const storedShareJson = JSON.stringify(storedShare.rows[0].messages);
      expect(storedShareJson).not.toContain("/api/artifacts/");
      expect(storedShareJson).not.toContain("/api/input-attachments/");
      expect(storedShareJson).not.toContain(artifactId);
      expect(storedShareJson).not.toContain(attachmentId);
      for (const message of firstPublic!.messages) {
        for (const file of message.files) {
          expect(file).not.toHaveProperty("id");
          expect(file).not.toHaveProperty("downloadUrl");
        }
      }

      await database.query(
        "UPDATE conversations SET title = 'Refreshed buyers' WHERE id = $1",
        [conversationId],
      );
      await database.query(
        "UPDATE messages SET content = 'Refreshed selected answer' WHERE id = $1",
        [selectedAssistantId],
      );
      await database.query("SELECT pg_sleep(0.005)");
      const refreshedShare = await putConversationShare(
        ownerId,
        conversationId,
        database,
      );
      expect(refreshedShare.publicId).toBe(firstShare.publicId);
      expect(refreshedShare.createdAt).toBe(firstShare.createdAt);
      expect(refreshedShare.updatedAt > firstShare.updatedAt).toBe(true);
      const refreshedPublic = await getPublicConversationShare(
        firstShare.publicId,
        database,
      );
      expect(refreshedPublic).toMatchObject({
        title: "Refreshed buyers",
        messages: expect.arrayContaining([
          expect.objectContaining({ content: "Refreshed selected answer" }),
        ]),
      });

      const historicalUnsafeContent =
        `Selected historical [CSV](${privateArtifactUrl}) and ` +
        `[brief](${privateAttachmentUrl}).`;
      const historicalMessages = refreshedPublic!.messages.map((message) =>
        message.id === selectedAssistantId
          ? {
              ...message,
              content: historicalUnsafeContent,
              citations: [citation, privateCitation],
            }
          : message,
      );
      await database.query(
        `
          UPDATE conversation_shares
          SET messages = $2::jsonb
          WHERE conversation_id = $1
        `,
        [conversationId, JSON.stringify(historicalMessages)],
      );
      const historicalPublic = await getPublicConversationShare(
        firstShare.publicId,
        database,
      );
      const historicalJson = JSON.stringify(historicalPublic);
      expect(historicalJson).not.toContain("/api/artifacts/");
      expect(historicalJson).not.toContain("/api/input-attachments/");
      expect(historicalJson).not.toContain(artifactId);
      expect(historicalJson).not.toContain(attachmentId);
      expect(historicalPublic!.messages.at(-1)?.content).toHaveLength(
        historicalUnsafeContent.length,
      );
      expect(historicalPublic!.messages.at(-1)?.citations).toEqual([citation]);
      await expect(
        getPublicConversationShare(firstShare.publicId, database),
      ).resolves.toEqual(historicalPublic);

      const revocation = await revokeConversationShare(
        ownerId,
        conversationId,
        firstShare.publicId,
        database,
      );
      expect(revocation).toMatchObject({
        conversationId,
        publicId: firstShare.publicId,
      });
      await expect(
        getPublicConversationShare(firstShare.publicId, database),
      ).resolves.toBeNull();
      await expect(
        getConversationShare(ownerId, conversationId, database),
      ).resolves.toBeNull();
      await expect(
        revokeConversationShare(
          ownerId,
          conversationId,
          firstShare.publicId,
          database,
        ),
      ).rejects.toMatchObject({ code: "SHARE_NOT_FOUND", status: 404 });

      const replacementShare = await putConversationShare(
        ownerId,
        conversationId,
        database,
      );
      expect(replacementShare.publicId).not.toBe(firstShare.publicId);
      await expect(
        revokeConversationShare(
          ownerId,
          conversationId,
          firstShare.publicId,
          database,
        ),
      ).rejects.toMatchObject({ code: "SHARE_NOT_FOUND", status: 404 });
      await expect(
        getPublicConversationShare(replacementShare.publicId, database),
      ).resolves.not.toBeNull();

      await softDeleteConversation(ownerId, conversationId, database);
      const retainedShare = await database.query(
        "SELECT 1 FROM conversation_shares WHERE conversation_id = $1",
        [conversationId],
      );
      expect(retainedShare.rowCount).toBe(0);
      await expect(
        getPublicConversationShare(replacementShare.publicId, database),
      ).resolves.toBeNull();
    });

    it("rejects empty and active conversations", async () => {
      const emptyConversationId = randomUUID();
      const activeConversationId = randomUUID();
      const activeInputMessageId = randomUUID();
      const activeRunId = randomUUID();
      const plannedAssistantId = randomUUID();
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `
            INSERT INTO conversations (id, user_id, title)
            VALUES
              ($1, $3, 'Empty conversation'),
              ($2, $3, 'Running conversation')
          `,
          [emptyConversationId, activeConversationId, ownerId],
        );
        await client.query(
          `
            INSERT INTO messages (id, conversation_id, role, content)
            VALUES ($1, $2, 'user', 'Running question')
          `,
          [activeInputMessageId, activeConversationId],
        );
        await client.query(
          `
            INSERT INTO runs (
              id,
              request_id,
              user_id,
              conversation_id,
              status,
              reservation_credits,
              input_message_id,
              assistant_message_id,
              conversation_turn,
              attempt_index,
              attempt_count,
              started_at,
              model_started_at
            )
            VALUES ($1, $2, $3, $4, 'running', 10, $5, $6, 1, 1, 1, now(), now())
          `,
          [
            activeRunId,
            randomUUID(),
            ownerId,
            activeConversationId,
            activeInputMessageId,
            plannedAssistantId,
          ],
        );
        await client.query("UPDATE messages SET run_id = $1 WHERE id = $2", [
          activeRunId,
          activeInputMessageId,
        ]);
        await client.query(
          "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
          [activeConversationId, activeRunId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await expect(
        putConversationShare(ownerId, emptyConversationId, database),
      ).rejects.toMatchObject({ code: "EMPTY_CONVERSATION", status: 409 });
      await expect(
        putConversationShare(ownerId, activeConversationId, database),
      ).rejects.toMatchObject({ code: "ACTIVE_RUN", status: 409 });
    });

    it("passes the repeatable 020 migration assertions", async () => {
      await expect(
        database.query(
          await readFile(
            path.join(assertionsDirectory, "020_conversation_shares.sql"),
            "utf8",
          ),
        ),
      ).resolves.toBeDefined();
    });
  },
);
