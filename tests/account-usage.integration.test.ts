import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getAccountUsagePage } from "@/lib/account";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
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
  "021_library_indexes.sql",
] as const;

describe.runIf(databaseUrl !== undefined)("account usage PostgreSQL repository", () => {
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const schemaName = `account_usage_${randomUUID().replaceAll("-", "")}`;
  const conversationIds = {
    deleted: randomUUID(),
    completed: randomUUID(),
    queued: randomUUID(),
    otherOwner: randomUUID(),
  };
  const runIds = {
    deleted: "f0000000-0000-4000-8000-000000000003",
    completed: "e0000000-0000-4000-8000-000000000002",
    queued: "d0000000-0000-4000-8000-000000000001",
    otherOwner: "c0000000-0000-4000-8000-000000000000",
  };
  const createdAt = "2026-08-28T08:00:00.123456Z";
  let adminDatabase: Pool;
  let database: Pool;

  beforeAll(async () => {
    adminDatabase = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminDatabase.query(`CREATE SCHEMA ${schemaName}`);
    database = new Pool({
      connectionString: databaseUrl,
      max: 2,
      options: `-c search_path=${schemaName},public`,
    });
    for (const filename of migrationFilenames) {
      await database.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO users (
            id,
            name,
            available_credits,
            reserved_credits,
            frozen_credits
          )
          VALUES
            ($1, 'Usage owner', 75, 20, 5),
            ($2, 'Other owner', 90, 10, 0)
        `,
        [ownerId, otherOwnerId],
      );
      await client.query(
        `
          INSERT INTO conversations (id, user_id, title, deleted_at)
          VALUES
            ($1, $5, 'Deleted but billable', now()),
            ($2, $5, 'Completed usage', NULL),
            ($3, $5, 'Queued usage', NULL),
            ($4, $6, 'Foreign owner usage', NULL)
        `,
        [
          conversationIds.deleted,
          conversationIds.completed,
          conversationIds.queued,
          conversationIds.otherOwner,
          ownerId,
          otherOwnerId,
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
            conversation_turn,
            attempt_index,
            created_at,
            completed_at,
            finished_at,
            updated_at
          )
          VALUES
            (
              $1, $9, $13, $5, 'completed', 20, 4, 100, 40, 2, 1, 1,
              $15::timestamptz, $15::timestamptz + interval '2 minutes',
              $15::timestamptz + interval '2 minutes', $15::timestamptz
            ),
            (
              $2, $10, $13, $6, 'completed', 20, 3, 80, 30, 1, 1, 1,
              $15::timestamptz, $15::timestamptz + interval '1 minute',
              $15::timestamptz + interval '1 minute', $15::timestamptz
            ),
            (
              $3, $11, $13, $7, 'queued', 20, NULL, NULL, NULL, NULL, 1, 1,
              $15::timestamptz, NULL, NULL, $15::timestamptz
            ),
            (
              $4, $12, $14, $8, 'completed', 10, 1, 10, 10, 0, 1, 1,
              $15::timestamptz, $15::timestamptz + interval '1 minute',
              $15::timestamptz + interval '1 minute', $15::timestamptz
            )
        `,
        [
          runIds.deleted,
          runIds.completed,
          runIds.queued,
          runIds.otherOwner,
          conversationIds.deleted,
          conversationIds.completed,
          conversationIds.queued,
          conversationIds.otherOwner,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          randomUUID(),
          ownerId,
          otherOwnerId,
          createdAt,
        ],
      );
      await client.query(
        `
          UPDATE conversations conversation
          SET selected_run_id = source.run_id
          FROM (
            VALUES
              ($1::uuid, $5::uuid),
              ($2::uuid, $6::uuid),
              ($3::uuid, $7::uuid),
              ($4::uuid, $8::uuid)
          ) AS source(conversation_id, run_id)
          WHERE conversation.id = source.conversation_id
        `,
        [
          conversationIds.deleted,
          conversationIds.completed,
          conversationIds.queued,
          conversationIds.otherOwner,
          runIds.deleted,
          runIds.completed,
          runIds.queued,
          runIds.otherOwner,
        ],
      );
      await client.query(
        `
          INSERT INTO credit_ledger (
            user_id,
            run_id,
            idempotency_key,
            entry_type,
            available_delta,
            reserved_delta,
            frozen_delta
          )
          VALUES
            ($1::uuid, $2::uuid, ($2::uuid)::text || ':reserve', 'reserve', -20, 20, 0),
            ($1::uuid, $2::uuid, ($2::uuid)::text || ':settle', 'settle', 16, -20, 0),
            ($1::uuid, $3::uuid, ($3::uuid)::text || ':reserve', 'reserve', -20, 20, 0),
            ($1::uuid, $3::uuid, ($3::uuid)::text || ':settle', 'settle', 17, -20, 0),
            ($1::uuid, $4::uuid, ($4::uuid)::text || ':reserve', 'reserve', -20, 20, 0)
        `,
        [ownerId, runIds.deleted, runIds.completed, runIds.queued],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }, 30_000);

  afterAll(async () => {
    await database?.end();
    if (adminDatabase !== undefined) {
      await adminDatabase.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminDatabase.end();
    }
  });

  it("isolates owners, keeps soft-deleted titles, and keyset-paginates Runs", async () => {
    const firstPage = await getAccountUsagePage(
      { userId: ownerId, cursor: null, limit: 2 },
      database,
    );
    const secondPage = await getAccountUsagePage(
      { userId: ownerId, cursor: firstPage.nextCursor, limit: 2 },
      database,
    );
    const items = [...firstPage.items, ...secondPage.items];

    expect(firstPage.balance).toEqual({ available: 75, reserved: 20, frozen: 5 });
    expect(secondPage.balance).toEqual(firstPage.balance);
    expect(items.map((item) => item.runId)).toEqual([
      runIds.deleted,
      runIds.completed,
      runIds.queued,
    ]);
    expect(items.map((item) => item.conversationTitle)).toEqual([
      "Deleted but billable",
      "Completed usage",
      "Queued usage",
    ]);
    expect(items.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "queued",
    ]);
    expect(items[0]).toMatchObject({
      chargedCredits: 4,
      inputTokens: 100,
      outputTokens: 40,
      webSearches: 2,
    });
    expect(items[2]).toMatchObject({
      chargedCredits: null,
      inputTokens: null,
      outputTokens: null,
      webSearches: null,
      finishedAt: null,
    });
    expect(firstPage.nextCursor).not.toBeNull();
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set(items.map((item) => item.runId))).toHaveLength(3);
    expect(items.some((item) => item.runId === runIds.otherOwner)).toBe(false);
  });
});
