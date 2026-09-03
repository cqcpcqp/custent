import { randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CapturedRunExecutionConfig } from "@/lib/contracts";
import {
  createConversation,
  listMessages,
  softDeleteConversation,
} from "@/lib/db";
import {
  createInputAttachment,
  deleteStagedInputAttachment,
  getConversationBoundInputAttachmentRecord,
  getInputAttachmentContentRecord,
  getMessageBoundInputAttachmentRecord,
  getStagedInputAttachment,
  processInputAttachmentDeletion,
  reconcileInputAttachmentStorage,
  storeInputAttachment,
  sweepInputAttachments,
} from "@/lib/input-attachments";
import {
  cancelAgentRun,
  enqueueChatRun,
} from "@/lib/runs";

const databaseUrl = process.env.TEST_DATABASE_URL;

function capturedConfig(
  overrides: Partial<CapturedRunExecutionConfig> = {},
): CapturedRunExecutionConfig {
  return {
    provenance: "captured",
    snapshotVersion: 2,
    executionProfileId: "standard_research",
    profileLabel: "标准研究",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6",
    reasoningMode: "standard",
    reasoningModeEnabled: false,
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    tools: {
      webSearch: true,
      codeInterpreter: false,
      listResearch: true,
      saveResearchResults: true,
      createCsv: true,
      createPdf: true,
      createCsvFile: true,
      createPdfFile: true,
    },
    maxAgentTurns: 8,
    billing: {
      policyVersion: 1,
      reservationCredits: 100,
      creditsPer1kInputTokens: 1,
      creditsPer1kOutputTokens: 5,
      creditsPerWebSearch: 10,
    },
    ...overrides,
  };
}

describe.runIf(databaseUrl !== undefined)("input attachment PostgreSQL flow", () => {
  const ownerId = randomUUID();
  const otherUserId = randomUUID();
  const userIds = [ownerId, otherUserId];
  let database: Pool;
  let storageDirectory: string;

  beforeAll(async () => {
    database = new Pool({ connectionString: databaseUrl });
    storageDirectory = await mkdtemp(
      path.join(os.tmpdir(), "custent-input-attachment-integration-"),
    );
    await database.query(
      `
        INSERT INTO users (id, name, available_credits)
        VALUES
          ($1, 'Attachment owner', 2000),
          ($2, 'Attachment other user', 2000)
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
    await database.query(
      "DELETE FROM input_attachments WHERE user_id = ANY($1::uuid[])",
      [userIds],
    );
    await database.query(
      "DELETE FROM input_attachment_deletions WHERE user_id = ANY($1::uuid[])",
      [userIds],
    );
    await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
      userIds,
    ]);
    await database.end();
    await rm(storageDirectory, { recursive: true, force: true });
  });

  async function uploadText(
    userId: string,
    name: string,
    text: string,
  ) {
    const stored = await storeInputAttachment({
      file: new File([text], name, { type: "text/plain" }),
      storageDirectory,
      maxBytes: 10 * 1024 * 1024,
    });
    const staged = await createInputAttachment(
      {
        userId,
        stored,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
      database,
    );
    return {
      stored,
      summary: staged.attachment,
      expiresAt: staged.expiresAt,
    };
  }

  function enqueueInput(
    userId: string,
    request: {
      conversationId: string | null;
      message: string;
      attachmentIds: string[];
      requestId: string;
    },
  ) {
    return enqueueChatRun(
      {
        userId,
        request: {
          kind: "append",
          parentRunId: null,
          executionProfileId: "standard_research",
          ...request,
        },
        executionConfig: capturedConfig(),
        maxAttachmentCount: 5,
        maxAttachmentTotalBytes: 20 * 1024 * 1024,
      },
      database,
    );
  }

  it("binds ordered attachments once and makes a concurrent request ID strictly idempotent", async () => {
    const first = await uploadText(ownerId, "first-buyers.txt", "first");
    const second = await uploadText(ownerId, "second-buyers.txt", "second");
    const requestId = randomUUID();
    const request = {
      conversationId: null,
      message: "",
      attachmentIds: [first.summary.id, second.summary.id],
      requestId,
    };

    const [started, retry] = await Promise.all([
      enqueueInput(ownerId, request),
      enqueueInput(ownerId, request),
    ]);

    expect(retry.run.id).toBe(started.run.id);
    expect(retry.userMessage.id).toBe(started.userMessage.id);
    expect(retry.conversation.id).toBe(started.conversation.id);
    expect(started.conversation.title).toBe("first-buyers.txt");
    expect(started.userMessage.content).toBe("");
    expect(started.userMessage.attachments.map((item) => item.id)).toEqual(
      request.attachmentIds,
    );
    await expect(
      getStagedInputAttachment(ownerId, first.summary.id, database),
    ).resolves.toBeNull();
    const messages = await listMessages(
      ownerId,
      started.conversation.id,
      database,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].attachments.map((item) => item.id)).toEqual(
      request.attachmentIds,
    );

    const runCounts = await database.query<{
      runs: number;
      messages: number;
      reservations: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM runs WHERE request_id = $1) AS runs,
          (
            SELECT COUNT(*)::integer
            FROM messages
            WHERE conversation_id = $2
          ) AS messages,
          (
            SELECT COUNT(*)::integer
            FROM credit_ledger
            WHERE user_id = $3 AND idempotency_key = $4
          ) AS reservations
      `,
      [
        requestId,
        started.conversation.id,
        ownerId,
        `${started.run.id}:reserve`,
      ],
    );
    expect(runCounts.rows[0]).toEqual({
      runs: 1,
      messages: 1,
      reservations: 1,
    });

    await expect(
      enqueueInput(ownerId, {
        ...request,
        attachmentIds: [...request.attachmentIds].reverse(),
      }),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });

    const bound = await getMessageBoundInputAttachmentRecord(
      {
        userId: ownerId,
        conversationId: started.conversation.id,
        messageId: started.userMessage.id,
        attachmentId: first.summary.id,
      },
      database,
    );
    expect(bound).toMatchObject({
      id: first.summary.id,
      messageId: started.userMessage.id,
      position: 0,
      storagePath: first.stored.storagePath,
    });
    await expect(
      getConversationBoundInputAttachmentRecord(
        {
          userId: otherUserId,
          conversationId: started.conversation.id,
          attachmentId: first.summary.id,
        },
        database,
      ),
    ).resolves.toBeNull();

    const orderedAttachmentIds = await database.query<{
      attachment_ids: string[];
    }>(
      `
        SELECT ARRAY(
          SELECT message_attachment.attachment_id
          FROM message_input_attachments message_attachment
          WHERE message_attachment.message_id = $1
          ORDER BY message_attachment.position
        ) AS attachment_ids
      `,
      [started.userMessage.id],
    );
    expect(orderedAttachmentIds.rows[0].attachment_ids).toEqual(
      request.attachmentIds,
    );
    await cancelAgentRun(ownerId, started.run.id, database);

    await expect(
      deleteStagedInputAttachment(ownerId, first.summary.id, database),
    ).rejects.toMatchObject({ status: 409 });
    await softDeleteConversation(ownerId, started.conversation.id, database);
    await expect(
      getConversationBoundInputAttachmentRecord(
        {
          userId: ownerId,
          conversationId: started.conversation.id,
          attachmentId: first.summary.id,
        },
        database,
      ),
    ).resolves.toBeNull();
    await expect(
      getInputAttachmentContentRecord(ownerId, first.summary.id, database),
    ).resolves.toBeNull();
  });

  it("creates an immutable root sibling when editing the first message and rolls back invalid attachment reuse", async () => {
    const first = await uploadText(ownerId, "root-first.txt", "first root file");
    const second = await uploadText(ownerId, "root-second.txt", "second root file");
    const original = await enqueueInput(ownerId, {
      conversationId: null,
      message: "Original root prompt",
      attachmentIds: [first.summary.id, second.summary.id],
      requestId: randomUUID(),
    });
    await expect(
      enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "edit",
            conversationId: original.conversation.id,
            parentRunId: null,
            sourceMessageId: original.userMessage.id,
            message: "Do not edit while the source branch is active",
            attachmentIds: [second.summary.id],
            requestId: randomUUID(),
            executionProfileId: "standard_research",
          },
          executionConfig: capturedConfig(),
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "RUN_IN_PROGRESS", status: 409 });
    await cancelAgentRun(ownerId, original.run.id, database);

    const replacement = await uploadText(
      ownerId,
      "root-replacement.txt",
      "replacement root file",
    );
    const editInput = {
      userId: ownerId,
      request: {
        kind: "edit" as const,
        conversationId: original.conversation.id,
        parentRunId: null,
        sourceMessageId: original.userMessage.id,
        message: "Edited root prompt",
        attachmentIds: [second.summary.id, replacement.summary.id],
        requestId: randomUUID(),
        executionProfileId: "standard_research" as const,
      },
      executionConfig: capturedConfig(),
      maxAttachmentCount: 5,
      maxAttachmentTotalBytes: 20 * 1024 * 1024,
    };
    const [edited, idempotentEdit] = await Promise.all([
      enqueueChatRun(editInput, database),
      enqueueChatRun(editInput, database),
    ]);

    expect(idempotentEdit).toEqual(edited);
    expect(edited.run).toMatchObject({
      status: "queued",
      conversationTurn: "1",
      attemptIndex: 1,
      predecessorRunId: null,
    });
    expect(edited.run.id).not.toBe(original.run.id);
    expect(edited.userMessage.id).not.toBe(original.userMessage.id);
    expect(edited.conversation.selectedRunId).toBe(edited.run.id);

    const branches = await database.query<{
      id: string;
      input_message_id: string;
      status: string;
    }>(
      `
        SELECT id, input_message_id, status
        FROM runs
        WHERE conversation_id = $1
        ORDER BY created_at, id
      `,
      [original.conversation.id],
    );
    expect(branches.rows).toEqual([
      {
        id: original.run.id,
        input_message_id: original.userMessage.id,
        status: "cancelled",
      },
      {
        id: edited.run.id,
        input_message_id: edited.userMessage.id,
        status: "queued",
      },
    ]);
    const attachmentLinks = await database.query<{
      attachment_ids: string[];
      message_id: string;
    }>(
      `
        SELECT
          message_attachment.message_id,
          array_agg(
            message_attachment.attachment_id
            ORDER BY message_attachment.position
          ) AS attachment_ids
        FROM message_input_attachments message_attachment
        WHERE message_attachment.message_id = ANY($1::uuid[])
        GROUP BY message_attachment.message_id
      `,
      [[original.userMessage.id, edited.userMessage.id]],
    );
    expect(
      new Map(
        attachmentLinks.rows.map((row) => [row.message_id, row.attachment_ids]),
      ),
    ).toEqual(
      new Map([
        [original.userMessage.id, [first.summary.id, second.summary.id]],
        [edited.userMessage.id, [second.summary.id, replacement.summary.id]],
      ]),
    );
    await cancelAgentRun(ownerId, edited.run.id, database);

    const external = await uploadText(
      ownerId,
      "external-message.txt",
      "belongs to another message",
    );
    const externalRun = await enqueueInput(ownerId, {
      conversationId: null,
      message: "External attachment owner",
      attachmentIds: [external.summary.id],
      requestId: randomUUID(),
    });
    await cancelAgentRun(ownerId, externalRun.run.id, database);

    const invalidRequestId = randomUUID();
    const countsBefore = await database.query<{
      messages: number;
      runs: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM runs WHERE user_id = $1) AS runs,
          (
            SELECT COUNT(*)::integer
            FROM messages message
            JOIN conversations conversation
              ON conversation.id = message.conversation_id
            WHERE conversation.user_id = $1
          ) AS messages
      `,
      [ownerId],
    );
    await expect(
      enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "edit",
            conversationId: edited.conversation.id,
            parentRunId: null,
            sourceMessageId: edited.userMessage.id,
            message: "Must roll back external attachment reuse",
            attachmentIds: [external.summary.id],
            requestId: invalidRequestId,
            executionProfileId: "standard_research",
          },
          executionConfig: capturedConfig(),
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 409 });
    const countsAfter = await database.query<{
      messages: number;
      request_runs: number;
      runs: number;
    }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM runs WHERE user_id = $1) AS runs,
          (
            SELECT COUNT(*)::integer
            FROM messages message
            JOIN conversations conversation
              ON conversation.id = message.conversation_id
            WHERE conversation.user_id = $1
          ) AS messages,
          (
            SELECT COUNT(*)::integer
            FROM runs
            WHERE request_id = $2
          ) AS request_runs
      `,
      [ownerId, invalidRequestId],
    );
    expect(countsAfter.rows[0]).toEqual({
      ...countsBefore.rows[0],
      request_runs: 0,
    });

    await expect(
      enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "edit",
            conversationId: original.conversation.id,
            parentRunId: null,
            sourceMessageId: original.userMessage.id,
            message: "Off-path edit",
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
    ).rejects.toMatchObject({ code: "INVALID_EDIT", status: 409 });
    await expect(
      enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "edit",
            conversationId: edited.conversation.id,
            parentRunId: randomUUID(),
            sourceMessageId: edited.userMessage.id,
            message: "Stale root edit",
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
    ).rejects.toMatchObject({ code: "STALE_PARENT", status: 409 });
  });

  it("includes the original nullable conversation ID in request idempotency", async () => {
    const existingConversation = await createConversation(
      ownerId,
      "Existing conversation",
      database,
    );
    const explicitRequestId = randomUUID();
    const explicit = await enqueueInput(ownerId, {
      conversationId: existingConversation.id,
      message: "explicit conversation",
      attachmentIds: [],
      requestId: explicitRequestId,
    });
    await expect(
      enqueueInput(ownerId, {
        conversationId: null,
        message: "explicit conversation",
        attachmentIds: [],
        requestId: explicitRequestId,
      }),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    await cancelAgentRun(ownerId, explicit.run.id, database);

    const newConversationRequestId = randomUUID();
    const created = await enqueueInput(ownerId, {
      conversationId: null,
      message: "new conversation",
      attachmentIds: [],
      requestId: newConversationRequestId,
    });
    await expect(
      enqueueInput(ownerId, {
        conversationId: created.conversation.id,
        message: "new conversation",
        attachmentIds: [],
        requestId: newConversationRequestId,
      }),
    ).rejects.toMatchObject({ code: "RUN_ALREADY_EXISTS", status: 409 });
    await cancelAgentRun(ownerId, created.run.id, database);
  });

  it("hides staged attachments across users and rolls back every invalid enqueue", async () => {
    const foreign = await uploadText(ownerId, "foreign.txt", "foreign");
    await expect(
      getStagedInputAttachment(ownerId, foreign.summary.id, database),
    ).resolves.toEqual({
      attachment: foreign.summary,
      expiresAt: foreign.expiresAt,
    });
    await expect(
      getStagedInputAttachment(otherUserId, foreign.summary.id, database),
    ).resolves.toBeNull();
    await expect(
      getInputAttachmentContentRecord(
        otherUserId,
        foreign.summary.id,
        database,
      ),
    ).resolves.toBeNull();
    await expect(
      enqueueInput(otherUserId, {
        conversationId: null,
        message: "",
        attachmentIds: [foreign.summary.id],
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    const valid = await uploadText(ownerId, "valid.txt", "valid");
    const before = await database.query<{ conversations: number; runs: number }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM conversations WHERE user_id = $1) AS conversations,
          (SELECT COUNT(*)::integer FROM runs WHERE user_id = $1) AS runs
      `,
      [ownerId],
    );
    await expect(
      enqueueInput(ownerId, {
        conversationId: null,
        message: "partial bind must roll back",
        attachmentIds: [valid.summary.id, randomUUID()],
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    const after = await database.query<{ conversations: number; runs: number }>(
      `
        SELECT
          (SELECT COUNT(*)::integer FROM conversations WHERE user_id = $1) AS conversations,
          (SELECT COUNT(*)::integer FROM runs WHERE user_id = $1) AS runs
      `,
      [ownerId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await expect(
      getInputAttachmentContentRecord(ownerId, valid.summary.id, database),
    ).resolves.toMatchObject({
      id: valid.summary.id,
      userId: ownerId,
    });

    await expect(
      enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "append",
            conversationId: null,
            parentRunId: null,
            message: "too large as a group",
            attachmentIds: [valid.summary.id],
            requestId: randomUUID(),
            executionProfileId: "standard_research",
          },
          executionConfig: capturedConfig(),
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: valid.stored.sizeBytes - 1,
        },
        database,
      ),
    ).rejects.toMatchObject({ status: 413 });

    await database.query(
      "UPDATE input_attachments SET expires_at = now() - interval '1 second' WHERE id = $1",
      [valid.summary.id],
    );
    await expect(
      enqueueInput(ownerId, {
        conversationId: null,
        message: "expired",
        attachmentIds: [valid.summary.id],
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      getInputAttachmentContentRecord(ownerId, valid.summary.id, database),
    ).resolves.toBeNull();
    await expect(
      getStagedInputAttachment(ownerId, valid.summary.id, database),
    ).resolves.toBeNull();
    const eligibleBeforeSweep = await database.query<{ count: number }>(
      `
        SELECT COUNT(*)::integer AS count
        FROM input_attachment_deletions
        WHERE completed_at IS NULL AND next_attempt_at <= now()
      `,
    );
    const swept = await sweepInputAttachments(
      {
        storageDirectory,
        batchSize: 100,
        retryDelayMs: 1_000,
        orphanMinAgeMs: 60 * 60 * 1_000,
        temporaryFileStaleAgeMs: 60 * 60 * 1_000,
      },
      database,
    );
    expect(swept).toMatchObject({
      expiredQueued: 1,
      completed: eligibleBeforeSweep.rows[0].count + 1,
      failed: 0,
    });
    const expiredRows = await database.query<{ count: number }>(
      "SELECT COUNT(*)::integer AS count FROM input_attachments WHERE id = $1",
      [valid.summary.id],
    );
    expect(expiredRows.rows[0].count).toBe(0);
  });

  it("deletes a staged row before its stored bytes", async () => {
    const staged = await uploadText(ownerId, "delete-me.txt", "delete me");
    const deleted = await deleteStagedInputAttachment(
      ownerId,
      staged.summary.id,
      database,
    );
    expect(deleted.deletion.attachmentId).toBe(staged.summary.id);
    await expect(
      getInputAttachmentContentRecord(ownerId, staged.summary.id, database),
    ).resolves.toBeNull();
    await expect(
      processInputAttachmentDeletion(
        {
          job: {
            attachmentId: deleted.deletion.attachmentId,
            storagePath: deleted.storagePath,
          },
          storageDirectory,
          retryDelayMs: 1_000,
        },
        database,
      ),
    ).resolves.toBe(true);
    const completed = await database.query<{
      completed_at: Date | null;
      attempt_count: number;
    }>(
      `
        SELECT completed_at, attempt_count
        FROM input_attachment_deletions
        WHERE attachment_id = $1
      `,
      [staged.summary.id],
    );
    expect(completed.rows[0].completed_at).toBeInstanceOf(Date);

    const retry = await deleteStagedInputAttachment(
      ownerId,
      staged.summary.id,
      database,
    );
    expect(retry.deletion).toEqual(deleted.deletion);
  });

  it("reconciles only aged unreferenced UUID files and stale project temp files", async () => {
    const referenced = await uploadText(
      ownerId,
      "referenced-storage.txt",
      "referenced",
    );
    const tombstonedId = randomUUID();
    const orphanId = randomUUID();
    const recentOrphanId = randomUUID();
    const staleTemporaryName = `.${randomUUID()}.${randomUUID()}.tmp`;
    const recentTemporaryName = `.${randomUUID()}.${randomUUID()}.tmp`;
    const unknownName = "do-not-touch.txt";
    const paths = Object.fromEntries(
      [
        referenced.stored.storagePath,
        tombstonedId,
        orphanId,
        recentOrphanId,
        staleTemporaryName,
        recentTemporaryName,
        unknownName,
      ].map((name) => [name, path.join(storageDirectory, name)]),
    );
    await Promise.all([
      writeFile(paths[tombstonedId], "tombstoned"),
      writeFile(paths[orphanId], "orphan"),
      writeFile(paths[recentOrphanId], "recent orphan"),
      writeFile(paths[staleTemporaryName], "stale temporary"),
      writeFile(paths[recentTemporaryName], "recent temporary"),
      writeFile(paths[unknownName], "unknown"),
    ]);
    await database.query(
      `
        INSERT INTO input_attachment_deletions (
          attachment_id,
          user_id,
          storage_path,
          completed_at
        )
        VALUES ($1, $2, $3, now())
      `,
      [tombstonedId, ownerId, tombstonedId],
    );
    const agedAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    await Promise.all(
      [
        paths[referenced.stored.storagePath],
        paths[tombstonedId],
        paths[orphanId],
        paths[staleTemporaryName],
        paths[unknownName],
      ].map((filePath) => utimes(filePath, agedAt, agedAt)),
    );

    await expect(
      reconcileInputAttachmentStorage(
        {
          storageDirectory,
          batchSize: 100,
          orphanMinAgeMs: 60 * 60 * 1_000,
          temporaryFileStaleAgeMs: 60 * 60 * 1_000,
        },
        database,
      ),
    ).resolves.toEqual({
      orphanFilesDeleted: 1,
      staleTemporaryFilesDeleted: 1,
    });

    await expect(access(paths[orphanId])).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(paths[staleTemporaryName])).rejects.toMatchObject({
      code: "ENOENT",
    });
    await Promise.all(
      [
        paths[referenced.stored.storagePath],
        paths[tombstonedId],
        paths[recentOrphanId],
        paths[recentTemporaryName],
        paths[unknownName],
      ].map((filePath) => expect(access(filePath)).resolves.toBeUndefined()),
    );
  });
});
