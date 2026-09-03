import { randomUUID } from "node:crypto";

import type { AgentInputItem } from "@openai/agents";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  branchConversationFromMessage,
  createConversation,
  getConversation,
  listMessages,
  withTransaction,
} from "@/lib/db";
import {
  listConversationRuns,
  readConversationContextSeedItems,
} from "@/lib/runs";
import { getConversationBoundInputAttachmentRecord } from "@/lib/input-attachments";
import { writeRunSessionSnapshot } from "@/lib/runs/session-snapshots";
import { insertCapturedRunExecutionConfig } from "@/lib/run-config";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.runIf(databaseUrl !== undefined)(
  "message branches into new conversations",
  () => {
    const userId = randomUUID();
    let database: Pool;

    beforeAll(async () => {
      database = new Pool({ connectionString: databaseUrl });
      await database.query(
        `
          INSERT INTO users (id, name, available_credits)
          VALUES ($1, 'Conversation branch user', 1000)
        `,
        [userId],
      );
    });

    afterAll(async () => {
      await database.query("DELETE FROM conversations WHERE user_id = $1", [
        userId,
      ]);
      await database.query(
        "DELETE FROM input_attachment_deletions WHERE user_id = $1",
        [userId],
      );
      await database.query("DELETE FROM users WHERE id = $1", [userId]);
      await database.end();
    });

    async function completedSource(input: {
      title: string;
      withSnapshot: boolean;
      withAttachment?: boolean;
    }) {
      const conversation = await createConversation(
        userId,
        input.title,
        database,
      );
      const runId = randomUUID();
      const requestId = randomUUID();
      const inputMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const attachmentId = input.withAttachment ? randomUUID() : null;

      await withTransaction(async (client) => {
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
            VALUES ($1, $2, 'user', 'Find German pump buyers', '[]', now())
          `,
          [inputMessageId, conversation.id],
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
              'completed',
              20,
              3,
              10,
              5,
              1,
              $5,
              $6,
              now(),
              now(),
              1,
              1
            )
          `,
          [
            runId,
            requestId,
            userId,
            conversation.id,
            inputMessageId,
            assistantMessageId,
          ],
        );
        await insertCapturedRunExecutionConfig(
          runId,
          {
            ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
            billing: {
              ...TEST_CAPTURED_RUN_EXECUTION_CONFIG.billing,
              reservationCredits: 20,
            },
          },
          client,
        );
        await client.query(
          "UPDATE messages SET run_id = $2 WHERE id = $1",
          [inputMessageId, runId],
        );
        await client.query(
          `
            INSERT INTO messages (
              id,
              conversation_id,
              run_id,
              role,
              content,
              citations,
              created_at
            )
            VALUES (
              $1,
              $2,
              $3,
              'assistant',
              'Three verified German buyers',
              '[]',
              now() + interval '1 millisecond'
            )
          `,
          [assistantMessageId, conversation.id, runId],
        );
        if (attachmentId !== null) {
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
                $1,
                $2,
                'file',
                'buyers.txt',
                'text/plain',
                12,
                $3,
                ($1::uuid)::text,
                now()
              )
            `,
            [attachmentId, userId, "a".repeat(64)],
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
            [inputMessageId, attachmentId],
          );
        }
        await client.query(
          `
            UPDATE conversations
            SET selected_run_id = $2
            WHERE id = $1
          `,
          [conversation.id, runId],
        );
      }, database);

      const sessionItems = [
        {
          role: "user",
          content:
            attachmentId === null
              ? "Find German pump buyers"
              : [
                  {
                    type: "input_text" as const,
                    text: "Find German pump buyers",
                  },
                  {
                    type: "input_file" as const,
                    file: `custent-attachment:${attachmentId}`,
                    filename: "buyers.txt",
                  },
                ],
        },
        {
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Three verified German buyers" },
          ],
        },
      ] satisfies AgentInputItem[];
      if (input.withSnapshot) {
        await writeRunSessionSnapshot(runId, "post", sessionItems, database);
      }

      return {
        assistantMessageId,
        attachmentId,
        conversation,
        inputMessageId,
        runId,
        sessionItems,
      };
    }

    async function appendCompletedRun(input: {
      conversationId: string;
      conversationTurn: number;
      predecessorRunId: string | null;
      inputContent: string;
      assistantContent: string;
      sessionItems: AgentInputItem[];
      select?: boolean;
    }) {
      const runId = randomUUID();
      const inputMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      await withTransaction(async (client) => {
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
            VALUES ($1, $2, 'user', $3, '[]', clock_timestamp())
          `,
          [inputMessageId, input.conversationId, input.inputContent],
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
              'completed',
              20,
              0,
              0,
              0,
              0,
              $5,
              $6,
              clock_timestamp(),
              clock_timestamp(),
              $7,
              1,
              $8
            )
          `,
          [
            runId,
            randomUUID(),
            userId,
            input.conversationId,
            inputMessageId,
            assistantMessageId,
            input.conversationTurn,
            input.predecessorRunId,
          ],
        );
        await insertCapturedRunExecutionConfig(
          runId,
          {
            ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
            billing: {
              ...TEST_CAPTURED_RUN_EXECUTION_CONFIG.billing,
              reservationCredits: 20,
            },
          },
          client,
        );
        await client.query(
          "UPDATE messages SET run_id = $2 WHERE id = $1",
          [inputMessageId, runId],
        );
        await client.query(
          `
            INSERT INTO messages (
              id,
              conversation_id,
              run_id,
              role,
              content,
              citations,
              created_at
            )
            VALUES (
              $1,
              $2,
              $3,
              'assistant',
              $4,
              '[]',
              clock_timestamp() + interval '1 millisecond'
            )
          `,
          [
            assistantMessageId,
            input.conversationId,
            runId,
            input.assistantContent,
          ],
        );
        if (input.select !== false) {
          await client.query(
            "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
            [input.conversationId, runId],
          );
        }
      }, database);
      await writeRunSessionSnapshot(
        runId,
        "post",
        input.sessionItems,
        database,
      );
      return { assistantMessageId, inputMessageId, runId };
    }

    async function appendReconciliationRun(input: {
      conversationId: string;
      conversationTurn: number;
      predecessorRunId: string;
      inputContent: string;
    }) {
      const runId = randomUUID();
      const inputMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      await withTransaction(async (client) => {
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
            VALUES ($1, $2, 'user', $3, '[]', clock_timestamp())
          `,
          [inputMessageId, input.conversationId, input.inputContent],
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
              reconciliation_reason,
              failure_code,
              failure_message,
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
              'reconciliation_required',
              20,
              $5,
              $6,
              'integration reconciliation',
              'RUN_REQUIRES_RECONCILIATION',
              'integration reconciliation',
              clock_timestamp(),
              $7,
              1,
              $8
            )
          `,
          [
            runId,
            randomUUID(),
            userId,
            input.conversationId,
            inputMessageId,
            assistantMessageId,
            input.conversationTurn,
            input.predecessorRunId,
          ],
        );
        await insertCapturedRunExecutionConfig(
          runId,
          {
            ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
            billing: {
              ...TEST_CAPTURED_RUN_EXECUTION_CONFIG.billing,
              reservationCredits: 20,
            },
          },
          client,
        );
        await client.query(
          "UPDATE messages SET run_id = $2 WHERE id = $1",
          [inputMessageId, runId],
        );
        await client.query(
          "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
          [input.conversationId, runId],
        );
      }, database);
      return { assistantMessageId, inputMessageId, runId };
    }

    it("copies visible messages and attachment links while preserving only immutable Agent context", async () => {
      const source = await completedSource({
        title: "German pump buyers",
        withAttachment: true,
        withSnapshot: true,
      });
      const request = {
        requestId: randomUUID(),
        sourceMessageId: source.assistantMessageId,
      };

      const first = await branchConversationFromMessage(
        {
          userId,
          sourceConversationId: source.conversation.id,
          request,
        },
        database,
      );
      const repeated = await branchConversationFromMessage(
        {
          userId,
          sourceConversationId: source.conversation.id,
          request,
        },
        database,
      );

      expect(repeated).toEqual(first);
      expect(first.conversation).toMatchObject({
        title: source.conversation.title,
        selectedRunId: null,
        activeRun: null,
        waitingRunCount: 0,
      });
      const copiedMessages = await listMessages(
        userId,
        first.conversation.id,
        database,
      );
      expect(copiedMessages).toHaveLength(2);
      expect(copiedMessages.map((message) => ({
        role: message.role,
        content: message.content,
        runId: message.runId,
      }))).toEqual([
        {
          role: "user",
          content: "Find German pump buyers",
          runId: null,
        },
        {
          role: "assistant",
          content: "Three verified German buyers",
          runId: null,
        },
      ]);
      expect(copiedMessages[0].attachments.map((item) => item.id)).toEqual([
        source.attachmentId,
      ]);
      await expect(
        listConversationRuns(userId, first.conversation.id, database),
      ).resolves.toEqual([]);
      await expect(
        readConversationContextSeedItems(first.conversation.id, database),
      ).resolves.toEqual(source.sessionItems);

      const sourceAfter = await getConversation(
        userId,
        source.conversation.id,
        database,
      );
      expect(sourceAfter?.selectedRunId).toBe(source.runId);
      const targetCount = await database.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM conversation_branch_requests
          WHERE request_id = $1
        `,
        [request.requestId],
      );
      expect(targetCount.rows[0].count).toBe("1");
    });

    it("keeps standalone history and attachment bindings across repeated branches", async () => {
      const source = await completedSource({
        title: "Repeated buyer branch",
        withAttachment: true,
        withSnapshot: true,
      });
      const firstBranch = await branchConversationFromMessage(
        {
          userId,
          sourceConversationId: source.conversation.id,
          request: {
            requestId: randomUUID(),
            sourceMessageId: source.assistantMessageId,
          },
        },
        database,
      );
      const continuedSessionItems = [
        ...source.sessionItems,
        { role: "user", content: "Prioritize distributors" },
        {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Two distributors" }],
        },
      ] satisfies AgentInputItem[];
      const firstContinuation = await appendCompletedRun({
        conversationId: firstBranch.conversation.id,
        conversationTurn: 1,
        predecessorRunId: null,
        inputContent: "Prioritize distributors",
        assistantContent: "Two distributors",
        sessionItems: continuedSessionItems,
      });

      const secondBranch = await branchConversationFromMessage(
        {
          userId,
          sourceConversationId: firstBranch.conversation.id,
          request: {
            requestId: randomUUID(),
            sourceMessageId: firstContinuation.assistantMessageId,
          },
        },
        database,
      );
      const secondBranchMessages = await listMessages(
        userId,
        secondBranch.conversation.id,
        database,
      );
      expect(
        secondBranchMessages.map((message) => ({
          role: message.role,
          content: message.content,
          runId: message.runId,
        })),
      ).toEqual([
        {
          role: "user",
          content: "Find German pump buyers",
          runId: null,
        },
        {
          role: "assistant",
          content: "Three verified German buyers",
          runId: null,
        },
        { role: "user", content: "Prioritize distributors", runId: null },
        { role: "assistant", content: "Two distributors", runId: null },
      ]);
      expect(secondBranchMessages[0].attachments.map((item) => item.id)).toEqual([
        source.attachmentId,
      ]);
      await expect(
        readConversationContextSeedItems(
          secondBranch.conversation.id,
          database,
        ),
      ).resolves.toEqual(continuedSessionItems);
      await expect(
        getConversationBoundInputAttachmentRecord(
          {
            userId,
            conversationId: secondBranch.conversation.id,
            attachmentId: source.attachmentId as string,
          },
          database,
        ),
      ).resolves.toMatchObject({ id: source.attachmentId });

      const finalSessionItems = [
        ...continuedSessionItems,
        { role: "user", content: "Rank them" },
        {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Ranked distributors" }],
        },
      ] satisfies AgentInputItem[];
      const secondContinuation = await appendCompletedRun({
        conversationId: secondBranch.conversation.id,
        conversationTurn: 1,
        predecessorRunId: null,
        inputContent: "Rank them",
        assistantContent: "Ranked distributors",
        sessionItems: finalSessionItems,
      });
      await expect(
        database.query(
          "SELECT assert_conversation_context_seed_integrity($1)",
          [secondBranch.conversation.id],
        ),
      ).resolves.toBeDefined();

      const thirdBranch = await branchConversationFromMessage(
        {
          userId,
          sourceConversationId: secondBranch.conversation.id,
          request: {
            requestId: randomUUID(),
            sourceMessageId: secondContinuation.assistantMessageId,
          },
        },
        database,
      );
      const thirdBranchMessages = await listMessages(
        userId,
        thirdBranch.conversation.id,
        database,
      );
      expect(thirdBranchMessages).toHaveLength(6);
      expect(thirdBranchMessages.every((message) => message.runId === null)).toBe(
        true,
      );
      expect(thirdBranchMessages[0].attachments.map((item) => item.id)).toEqual([
        source.attachmentId,
      ]);
      await expect(
        readConversationContextSeedItems(
          thirdBranch.conversation.id,
          database,
        ),
      ).resolves.toEqual(finalSessionItems);
    });

    it("copies visible failed-turn inputs before a later completed answer", async () => {
      const source = await completedSource({
        title: "Recovered branch",
        withSnapshot: true,
      });
      const reconciliation = await appendReconciliationRun({
        conversationId: source.conversation.id,
        conversationTurn: 2,
        predecessorRunId: source.runId,
        inputContent: "Find French buyers",
      });
      const recoveredSessionItems = [
        ...source.sessionItems,
        { role: "user", content: "Retry French buyers" },
        {
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "French buyers recovered" }],
        },
      ] satisfies AgentInputItem[];
      const recovered = await appendCompletedRun({
        conversationId: source.conversation.id,
        conversationTurn: 3,
        predecessorRunId: reconciliation.runId,
        inputContent: "Retry French buyers",
        assistantContent: "French buyers recovered",
        sessionItems: recoveredSessionItems,
      });

      const branch = await branchConversationFromMessage(
        {
          userId,
          sourceConversationId: source.conversation.id,
          request: {
            requestId: randomUUID(),
            sourceMessageId: recovered.assistantMessageId,
          },
        },
        database,
      );
      const copiedMessages = await listMessages(
        userId,
        branch.conversation.id,
        database,
      );
      expect(copiedMessages.map((message) => message.content)).toEqual([
        "Find German pump buyers",
        "Three verified German buyers",
        "Find French buyers",
        "Retry French buyers",
        "French buyers recovered",
      ]);
      for (let index = 1; index < copiedMessages.length; index += 1) {
        expect(
          Date.parse(copiedMessages[index].createdAt)
            - Date.parse(copiedMessages[index - 1].createdAt),
        ).toBeGreaterThanOrEqual(1);
      }
      expect(copiedMessages.every((message) => message.runId === null)).toBe(true);
      await expect(
        readConversationContextSeedItems(branch.conversation.id, database),
      ).resolves.toEqual(recoveredSessionItems);
    });

    it("rejects a completed answer outside the conversation selected path", async () => {
      const source = await completedSource({
        title: "Selected branch only",
        withSnapshot: true,
      });
      const selected = await appendCompletedRun({
        conversationId: source.conversation.id,
        conversationTurn: 2,
        predecessorRunId: source.runId,
        inputContent: "Selected child",
        assistantContent: "Selected answer",
        sessionItems: source.sessionItems,
      });
      const hidden = await appendCompletedRun({
        conversationId: source.conversation.id,
        conversationTurn: 2,
        predecessorRunId: source.runId,
        inputContent: "Hidden child",
        assistantContent: "Hidden answer",
        sessionItems: source.sessionItems,
        select: false,
      });
      expect(
        (
          await getConversation(userId, source.conversation.id, database)
        )?.selectedRunId,
      ).toBe(selected.runId);

      await expect(
        branchConversationFromMessage(
          {
            userId,
            sourceConversationId: source.conversation.id,
            request: {
              requestId: randomUUID(),
              sourceMessageId: hidden.assistantMessageId,
            },
          },
          database,
        ),
      ).rejects.toMatchObject({ code: "INVALID_BRANCH_TARGET" });
    });

    it("rolls the whole branch back when the source post snapshot is unavailable", async () => {
      const source = await completedSource({
        title: "Missing branch context",
        withSnapshot: false,
      });
      const before = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM conversations WHERE user_id = $1",
        [userId],
      );

      await expect(
        branchConversationFromMessage(
          {
            userId,
            sourceConversationId: source.conversation.id,
            request: {
              requestId: randomUUID(),
              sourceMessageId: source.assistantMessageId,
            },
          },
          database,
        ),
      ).rejects.toMatchObject({ code: "RUN_CONTEXT_UNAVAILABLE" });

      const after = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM conversations WHERE user_id = $1",
        [userId],
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });
  },
);
