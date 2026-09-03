import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getAccountCustomInstructions,
  updateAccountCustomInstructions,
} from "@/lib/custom-instructions";
import { createConversation } from "@/lib/db";
import { claimNextRun, enqueueChatRun } from "@/lib/runs";
import {
  TEST_CAPTURED_RUN_EXECUTION_CONFIG,
  TEST_RUN_WORKER_CAPABILITY,
} from "@/tests/fixtures/run-config";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration029Filename = "029_custom_instructions.sql";

describe.runIf(databaseUrl !== undefined)(
  "029 custom instructions migration and repository",
  () => {
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const historicalConversationId = randomUUID();
    const schemaName = `custom_instructions_${randomUUID().replaceAll("-", "")}`;
    let administration: Pool;
    let database: Pool;
    let assertion029: string;

    beforeAll(async () => {
      if (databaseUrl === undefined) {
        throw new TypeError("TEST_DATABASE_URL is required");
      }

      administration = new Pool({ connectionString: databaseUrl, max: 1 });
      await administration.query(`CREATE SCHEMA ${schemaName}`);
      database = new Pool({
        connectionString: databaseUrl,
        max: 4,
        options: `-c search_path=${schemaName},public`,
      });

      const earlierMigrations = (await readdir(migrationsDirectory))
        .filter(
          (filename) =>
            /^\d{3}_[a-z0-9_]+\.sql$/u.test(filename) &&
            filename < migration029Filename,
        )
        .sort();
      for (const filename of earlierMigrations) {
        await database.query(
          await readFile(path.join(migrationsDirectory, filename), "utf8"),
        );
      }

      await database.query(
        `
          INSERT INTO users (id, name, available_credits)
          VALUES
            ($1, 'Custom instructions owner', 1000),
            ($2, 'Other owner', 1000)
        `,
        [ownerId, otherOwnerId],
      );
      await database.query(
        `
          INSERT INTO conversations (id, user_id, title)
          VALUES ($1, $2, 'Historical conversation')
        `,
        [historicalConversationId, ownerId],
      );

      await database.query(
        await readFile(
          path.join(migrationsDirectory, migration029Filename),
          "utf8",
        ),
      );
      assertion029 = await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/029_custom_instructions.sql",
        ),
        "utf8",
      );
    }, 40_000);

    afterAll(async () => {
      await database?.end();
      if (administration !== undefined) {
        await administration.query(
          `DROP SCHEMA IF EXISTS ${schemaName} CASCADE`,
        );
        await administration.end();
      }
    });

    it("captures immutable snapshots, retains disabled content, and CAS-updates atomically", async () => {
      await expect(database.query(assertion029)).resolves.toBeDefined();
      await expect(database.query(assertion029)).resolves.toBeDefined();

      await expect(
        getAccountCustomInstructions(ownerId, database),
      ).resolves.toMatchObject({
        enabled: false,
        content: "",
        revision: 0,
        updatedAt: expect.any(String),
      });
      await expect(
        database.query<{
          custom_instructions_snapshot: string | null;
          custom_instructions_snapshot_revision: number;
        }>(
          `
            SELECT
              custom_instructions_snapshot,
              custom_instructions_snapshot_revision
            FROM conversations
            WHERE id = $1
          `,
          [historicalConversationId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            custom_instructions_snapshot: null,
            custom_instructions_snapshot_revision: 0,
          },
        ],
      });

      const rawContent = "  Research only public sources.\nKeep citations.  ";
      const enabled = await updateAccountCustomInstructions(
        {
          userId: ownerId,
          enabled: true,
          content: rawContent,
          expectedRevision: 0,
        },
        database,
      );
      expect(enabled).toMatchObject({
        enabled: true,
        content: rawContent,
        revision: 1,
      });

      const capturedConversation = await createConversation(
        ownerId,
        "Captured custom instructions",
        database,
      );
      const captured = await database.query<{
        custom_instructions_snapshot: string | null;
        custom_instructions_snapshot_revision: number;
      }>(
        `
          SELECT
            custom_instructions_snapshot,
            custom_instructions_snapshot_revision
          FROM conversations
          WHERE id = $1 AND user_id = $2
        `,
        [capturedConversation.id, ownerId],
      );
      expect(captured.rows).toEqual([
        {
          custom_instructions_snapshot: rawContent,
          custom_instructions_snapshot_revision: 1,
        },
      ]);

      const capturedStart = await enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "append",
            conversationId: capturedConversation.id,
            parentRunId: null,
            message: "Use the captured instructions",
            attachmentIds: [],
            requestId: randomUUID(),
            executionProfileId: "standard_research",
          },
          executionConfig: TEST_CAPTURED_RUN_EXECUTION_CONFIG,
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        database,
      );
      const capturedClaim = await claimNextRun(
        {
          workerId: randomUUID(),
          leaseDurationMs: 10_000,
          capability: TEST_RUN_WORKER_CAPABILITY,
        },
        database,
      );
      expect(capturedClaim).toMatchObject({
        run: { id: capturedStart.run.id },
        customInstructionsSnapshot: {
          content: rawContent,
          revision: 1,
        },
      });

      await updateAccountCustomInstructions(
        {
          userId: ownerId,
          enabled: false,
          content: "Retained while disabled",
          expectedRevision: 1,
        },
        database,
      );
      const disabledConversation = await createConversation(
        ownerId,
        "Disabled custom instructions",
        database,
      );
      const disabledSnapshot = await database.query<{
        custom_instructions_snapshot: string | null;
        custom_instructions_snapshot_revision: number;
      }>(
        `
          SELECT
            custom_instructions_snapshot,
            custom_instructions_snapshot_revision
          FROM conversations
          WHERE id = $1
        `,
        [disabledConversation.id],
      );
      expect(disabledSnapshot.rows).toEqual([
        {
          custom_instructions_snapshot: null,
          custom_instructions_snapshot_revision: 0,
        },
      ]);
      const disabledStart = await enqueueChatRun(
        {
          userId: ownerId,
          request: {
            kind: "append",
            conversationId: disabledConversation.id,
            parentRunId: null,
            message: "Do not use custom instructions",
            attachmentIds: [],
            requestId: randomUUID(),
            executionProfileId: "standard_research",
          },
          executionConfig: TEST_CAPTURED_RUN_EXECUTION_CONFIG,
          maxAttachmentCount: 5,
          maxAttachmentTotalBytes: 20 * 1024 * 1024,
        },
        database,
      );
      const disabledClaim = await claimNextRun(
        {
          workerId: randomUUID(),
          leaseDurationMs: 10_000,
          capability: TEST_RUN_WORKER_CAPABILITY,
        },
        database,
      );
      expect(disabledClaim).toMatchObject({
        run: { id: disabledStart.run.id },
        customInstructionsSnapshot: null,
      });
      await expect(
        getAccountCustomInstructions(ownerId, database),
      ).resolves.toMatchObject({
        enabled: false,
        content: "Retained while disabled",
        revision: 2,
      });

      await expect(
        database.query(
          `
            UPDATE conversations
            SET
              custom_instructions_snapshot = 'Mutated',
              custom_instructions_snapshot_revision = 2
            WHERE id = $1
          `,
          [capturedConversation.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      const unchanged = await database.query<{
        custom_instructions_snapshot: string;
        custom_instructions_snapshot_revision: number;
      }>(
        `
          SELECT
            custom_instructions_snapshot,
            custom_instructions_snapshot_revision
          FROM conversations
          WHERE id = $1
        `,
        [capturedConversation.id],
      );
      expect(unchanged.rows).toEqual([
        {
          custom_instructions_snapshot: rawContent,
          custom_instructions_snapshot_revision: 1,
        },
      ]);

      await expect(
        database.query(
          `
            UPDATE users
            SET
              custom_instructions_enabled = TRUE,
              custom_instructions_content = E' \n\t ',
              custom_instructions_revision = 3
            WHERE id = $1
          `,
          [ownerId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "users_custom_instructions_content_check",
      });
      await expect(
        database.query(
          `
            UPDATE users
            SET
              custom_instructions_enabled = TRUE,
              custom_instructions_content = 'Valid',
              custom_instructions_revision = 0
            WHERE id = $1
          `,
          [otherOwnerId],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "users_custom_instructions_revision_check",
      });

      const contenders = await Promise.allSettled([
        updateAccountCustomInstructions(
          {
            userId: ownerId,
            enabled: true,
            content: "Concurrent value A",
            expectedRevision: 2,
          },
          database,
        ),
        updateAccountCustomInstructions(
          {
            userId: ownerId,
            enabled: true,
            content: "Concurrent value B",
            expectedRevision: 2,
          },
          database,
        ),
      ]);
      const successes = contenders.filter(
        (result) => result.status === "fulfilled",
      );
      const conflicts = contenders.filter(
        (result) => result.status === "rejected",
      );
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(successes[0]).toMatchObject({
        value: { enabled: true, revision: 3 },
      });
      expect(conflicts[0]).toMatchObject({
        reason: {
          code: "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
          status: 409,
        },
      });

      await expect(
        updateAccountCustomInstructions(
          {
            userId: ownerId,
            enabled: true,
            content: "Stale write",
            expectedRevision: 2,
          },
          database,
        ),
      ).rejects.toMatchObject({
        code: "CUSTOM_INSTRUCTIONS_REVISION_CONFLICT",
        status: 409,
      });
      await expect(
        getAccountCustomInstructions(randomUUID(), database),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
      await expect(
        updateAccountCustomInstructions(
          {
            userId: randomUUID(),
            enabled: false,
            content: "",
            expectedRevision: 0,
          },
          database,
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

      await expect(database.query(assertion029)).resolves.toBeDefined();
    }, 20_000);
  },
);
