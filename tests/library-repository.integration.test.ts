import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getLibraryResearchDetail,
  listLibraryArtifactPage,
  listLibraryResearchPage,
} from "@/lib/library";

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

type RunFixture = {
  assistantMessageId: string;
  conversationId: string;
  createdAt: string;
  runId: string;
  userId: string;
  userMessageId: string;
};

type SnapshotFixture = {
  conversationId: string;
  createdAt: string;
  id: string;
  runId: string;
  title?: string;
  userId: string;
};

type ArtifactFixture = {
  assistantMessageId: string | null;
  conversationId: string;
  createdAt: string;
  id: string;
  name?: string;
  researchSnapshotId: string | null;
  runId: string;
  userId: string;
};

async function insertCompletedRun(
  client: PoolClient,
  fixture: RunFixture,
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
        ($1, $2, 'user', 'Find buyers', '[]'::jsonb, $3::timestamptz),
        ($4, $2, 'assistant', 'Completed research', '[]'::jsonb, $3::timestamptz + interval '1 second')
    `,
    [
      fixture.userMessageId,
      fixture.conversationId,
      fixture.createdAt,
      fixture.assistantMessageId,
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
        1,
        1,
        1,
        $7::timestamptz,
        $7::timestamptz,
        $7::timestamptz + interval '2 seconds',
        $7::timestamptz + interval '2 seconds',
        $7::timestamptz + interval '2 seconds'
      )
    `,
    [
      fixture.runId,
      randomUUID(),
      fixture.userId,
      fixture.conversationId,
      fixture.userMessageId,
      fixture.assistantMessageId,
      fixture.createdAt,
    ],
  );
  await client.query(
    "UPDATE messages SET run_id = $1 WHERE id = ANY($2::uuid[])",
    [fixture.runId, [fixture.userMessageId, fixture.assistantMessageId]],
  );
  await client.query(
    "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
    [fixture.conversationId, fixture.runId],
  );
}

async function insertRunningRun(
  client: PoolClient,
  fixture: RunFixture,
): Promise<void> {
  await client.query(
    `
      INSERT INTO messages (id, conversation_id, role, content, citations, created_at)
      VALUES
        ($1, $2, 'user', 'Research in progress', '[]'::jsonb, $3::timestamptz),
        ($4, $2, 'assistant', 'Partial result', '[]'::jsonb, $3::timestamptz + interval '1 second')
    `,
    [
      fixture.userMessageId,
      fixture.conversationId,
      fixture.createdAt,
      fixture.assistantMessageId,
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
        input_message_id,
        assistant_message_id,
        conversation_turn,
        attempt_index,
        attempt_count,
        created_at,
        started_at,
        model_started_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, 'running', 10, $5, $6, 1, 1, 1,
        $7::timestamptz, $7::timestamptz, $7::timestamptz, $7::timestamptz
      )
    `,
    [
      fixture.runId,
      randomUUID(),
      fixture.userId,
      fixture.conversationId,
      fixture.userMessageId,
      fixture.assistantMessageId,
      fixture.createdAt,
    ],
  );
  await client.query(
    "UPDATE messages SET run_id = $1 WHERE id = ANY($2::uuid[])",
    [fixture.runId, [fixture.userMessageId, fixture.assistantMessageId]],
  );
  await client.query(
    "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
    [fixture.conversationId, fixture.runId],
  );
}

async function insertSnapshot(
  client: PoolClient,
  fixture: SnapshotFixture,
): Promise<void> {
  await client.query(
    `
      INSERT INTO research_snapshots (
        id,
        user_id,
        conversation_id,
        run_id,
        title,
        query_summary,
        limitations,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, 'Public-source buyer research',
        'Only public evidence was used.', $6::timestamptz
      )
    `,
    [
      fixture.id,
      fixture.userId,
      fixture.conversationId,
      fixture.runId,
      fixture.title ?? "Pump buyers",
      fixture.createdAt,
    ],
  );
}

async function insertArtifact(
  client: PoolClient,
  fixture: ArtifactFixture,
): Promise<void> {
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
        storage_path,
        created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, 'text/csv', 128, $8, $9,
        $10::timestamptz
      )
    `,
    [
      fixture.id,
      fixture.userId,
      fixture.conversationId,
      fixture.assistantMessageId,
      fixture.runId,
      fixture.researchSnapshotId,
      fixture.name ?? "buyers.csv",
      "a".repeat(64),
      `library-test-${fixture.id}.csv`,
      fixture.createdAt,
    ],
  );
}

describe.runIf(databaseUrl !== undefined)("Library PostgreSQL repository", () => {
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const schemaName = `library_${randomUUID().replaceAll("-", "")}`;
  const mainConversationId = randomUUID();
  const crossConversationId = randomUUID();
  const deletedConversationId = randomUUID();
  const runningConversationId = randomUUID();
  const brokenConversationId = randomUUID();
  const otherConversationId = randomUUID();
  const mainRun: RunFixture = {
    assistantMessageId: randomUUID(),
    conversationId: mainConversationId,
    createdAt: "2026-08-28T07:00:00Z",
    runId: randomUUID(),
    userId: ownerId,
    userMessageId: randomUUID(),
  };
  const crossRun: RunFixture = {
    assistantMessageId: randomUUID(),
    conversationId: crossConversationId,
    createdAt: "2026-08-28T07:01:00Z",
    runId: randomUUID(),
    userId: ownerId,
    userMessageId: randomUUID(),
  };
  const deletedRun: RunFixture = {
    assistantMessageId: randomUUID(),
    conversationId: deletedConversationId,
    createdAt: "2026-08-28T07:02:00Z",
    runId: randomUUID(),
    userId: ownerId,
    userMessageId: randomUUID(),
  };
  const runningRun: RunFixture = {
    assistantMessageId: randomUUID(),
    conversationId: runningConversationId,
    createdAt: "2026-08-28T07:03:00Z",
    runId: randomUUID(),
    userId: ownerId,
    userMessageId: randomUUID(),
  };
  const brokenRun: RunFixture = {
    assistantMessageId: randomUUID(),
    conversationId: brokenConversationId,
    createdAt: "2026-08-28T07:04:00Z",
    runId: randomUUID(),
    userId: ownerId,
    userMessageId: randomUUID(),
  };
  const otherRun: RunFixture = {
    assistantMessageId: randomUUID(),
    conversationId: otherConversationId,
    createdAt: "2026-08-28T07:05:00Z",
    runId: randomUUID(),
    userId: otherOwnerId,
    userMessageId: randomUUID(),
  };
  const snapshotIds = [
    "90000000-0000-4000-8000-000000000003",
    "80000000-0000-4000-8000-000000000002",
    "70000000-0000-4000-8000-000000000001",
  ] as const;
  const crossSnapshotId = randomUUID();
  const deletedSnapshotId = randomUUID();
  const runningSnapshotId = randomUUID();
  const brokenSnapshotId = randomUUID();
  const otherSnapshotId = randomUUID();
  const validArtifactIds = [
    "90000000-0000-4000-8000-000000000013",
    "80000000-0000-4000-8000-000000000012",
  ] as const;
  const crossConversationArtifactId = randomUUID();
  const crossOwnerArtifactId = randomUUID();
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
          INSERT INTO users (id, name, available_credits)
          VALUES
            ($1, 'Library owner', 100),
            ($2, 'Other owner', 100)
        `,
        [ownerId, otherOwnerId],
      );
      await client.query(
        `
          INSERT INTO conversations (
            id,
            user_id,
            title,
            archived_at,
            deleted_at
          )
          VALUES
            ($1, $7, 'Archived buyers', now(), NULL),
            ($2, $7, 'Other owner conversation', NULL, NULL),
            ($3, $7, 'Deleted buyers', NULL, now()),
            ($4, $7, 'Running buyers', NULL, NULL),
            ($5, $7, 'Broken assistant', NULL, NULL),
            ($6, $8, 'Foreign owner buyers', NULL, NULL)
        `,
        [
          mainConversationId,
          crossConversationId,
          deletedConversationId,
          runningConversationId,
          brokenConversationId,
          otherConversationId,
          ownerId,
          otherOwnerId,
        ],
      );
      await insertCompletedRun(client, mainRun);
      await insertCompletedRun(client, crossRun);
      await insertCompletedRun(client, deletedRun);
      await insertRunningRun(client, runningRun);
      await insertCompletedRun(client, brokenRun);
      await insertCompletedRun(client, otherRun);

      for (const id of snapshotIds) {
        await insertSnapshot(client, {
          id,
          userId: ownerId,
          conversationId: mainConversationId,
          runId: mainRun.runId,
          createdAt: "2026-08-28T08:00:00.123456Z",
        });
      }
      await insertSnapshot(client, {
        id: crossSnapshotId,
        userId: ownerId,
        conversationId: crossConversationId,
        runId: crossRun.runId,
        createdAt: "2026-08-28T06:00:01Z",
      });
      await insertSnapshot(client, {
        id: deletedSnapshotId,
        userId: ownerId,
        conversationId: deletedConversationId,
        runId: deletedRun.runId,
        createdAt: "2026-08-28T09:00:02Z",
      });
      await insertSnapshot(client, {
        id: runningSnapshotId,
        userId: ownerId,
        conversationId: runningConversationId,
        runId: runningRun.runId,
        createdAt: "2026-08-28T09:00:03Z",
      });
      await insertSnapshot(client, {
        id: brokenSnapshotId,
        userId: ownerId,
        conversationId: brokenConversationId,
        runId: brokenRun.runId,
        createdAt: "2026-08-28T09:00:04Z",
      });
      await insertSnapshot(client, {
        id: otherSnapshotId,
        userId: otherOwnerId,
        conversationId: otherConversationId,
        runId: otherRun.runId,
        createdAt: "2026-08-28T09:00:05Z",
      });

      const companyId = randomUUID();
      const contactId = randomUUID();
      await client.query(
        `
          INSERT INTO research_companies (
            id,
            snapshot_id,
            ordinal,
            name,
            website_url,
            country,
            company_type,
            relevance_summary
          )
          VALUES (
            $1, $2, 0, 'Buyer GmbH', 'https://buyer.example', 'Germany',
            'distributor', 'Relevant industrial distributor.'
          )
        `,
        [companyId, snapshotIds[0]],
      );
      await client.query(
        `
          INSERT INTO research_contacts (
            id,
            company_id,
            ordinal,
            name,
            title_original,
            role_category,
            public_profile_url,
            confidence
          )
          VALUES (
            $1, $2, 0, 'Alex Buyer', 'Purchasing Manager', 'purchasing',
            'https://buyer.example/alex', 'A'
          )
        `,
        [contactId, companyId],
      );
      await client.query(
        `
          INSERT INTO research_evidence (
            id,
            snapshot_id,
            company_id,
            contact_id,
            ordinal,
            claim,
            source_url,
            source_title,
            supports
          )
          VALUES
            ($1, $3, $4, NULL, 0, 'The company distributes pumps.', 'https://buyer.example/company', 'Company source', 'business_fit'),
            ($2, $3, NULL, $5, 0, 'The public profile lists a purchasing role.', 'https://buyer.example/alex', 'Contact source', 'contact_role')
        `,
        [randomUUID(), randomUUID(), snapshotIds[0], companyId, contactId],
      );

      await insertArtifact(client, {
        id: validArtifactIds[0],
        userId: ownerId,
        conversationId: mainConversationId,
        runId: mainRun.runId,
        assistantMessageId: mainRun.assistantMessageId,
        researchSnapshotId: snapshotIds[0],
        createdAt: "2026-08-28T08:30:00.654321Z",
      });
      await insertArtifact(client, {
        id: validArtifactIds[1],
        userId: ownerId,
        conversationId: mainConversationId,
        runId: mainRun.runId,
        assistantMessageId: mainRun.assistantMessageId,
        researchSnapshotId: null,
        createdAt: "2026-08-28T08:30:00.654321Z",
      });
      await insertArtifact(client, {
        id: crossConversationArtifactId,
        userId: ownerId,
        conversationId: mainConversationId,
        runId: mainRun.runId,
        assistantMessageId: mainRun.assistantMessageId,
        researchSnapshotId: crossSnapshotId,
        createdAt: "2026-08-28T09:30:01Z",
      });
      await insertArtifact(client, {
        id: crossOwnerArtifactId,
        userId: ownerId,
        conversationId: mainConversationId,
        runId: mainRun.runId,
        assistantMessageId: mainRun.assistantMessageId,
        researchSnapshotId: otherSnapshotId,
        createdAt: "2026-08-28T09:30:02Z",
      });
      await insertArtifact(client, {
        id: randomUUID(),
        userId: ownerId,
        conversationId: mainConversationId,
        runId: mainRun.runId,
        assistantMessageId: null,
        researchSnapshotId: null,
        createdAt: "2026-08-28T09:30:03Z",
      });
      await insertArtifact(client, {
        id: randomUUID(),
        userId: ownerId,
        conversationId: deletedConversationId,
        runId: deletedRun.runId,
        assistantMessageId: deletedRun.assistantMessageId,
        researchSnapshotId: deletedSnapshotId,
        createdAt: "2026-08-28T09:30:04Z",
      });
      await insertArtifact(client, {
        id: randomUUID(),
        userId: ownerId,
        conversationId: runningConversationId,
        runId: runningRun.runId,
        assistantMessageId: runningRun.assistantMessageId,
        researchSnapshotId: runningSnapshotId,
        createdAt: "2026-08-28T09:30:05Z",
      });
      await insertArtifact(client, {
        id: randomUUID(),
        userId: otherOwnerId,
        conversationId: otherConversationId,
        runId: otherRun.runId,
        assistantMessageId: otherRun.assistantMessageId,
        researchSnapshotId: otherSnapshotId,
        createdAt: "2026-08-28T09:30:06Z",
      });

      const attachmentId = randomUUID();
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
            $1, $2, 'file', 'supplier-list.csv', 'text/csv', 64, $3, $4, now()
          )
        `,
        [attachmentId, ownerId, "b".repeat(64), attachmentId],
      );
      await client.query(
        `
          INSERT INTO message_input_attachments (message_id, attachment_id, position)
          VALUES ($1, $2, 0)
        `,
        [mainRun.userMessageId, attachmentId],
      );

      await client.query(
        "UPDATE messages SET run_id = NULL WHERE id = $1",
        [brokenRun.assistantMessageId],
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

  it("includes archived research and paginates equal timestamps without gaps", async () => {
    const firstPage = await listLibraryResearchPage(
      { userId: ownerId, cursor: null, limit: 2 },
      database,
    );
    const secondPage = await listLibraryResearchPage(
      { userId: ownerId, cursor: firstPage.nextCursor, limit: 2 },
      database,
    );

    expect(firstPage.items.map((item) => item.id)).toEqual(snapshotIds.slice(0, 2));
    expect(firstPage.items[0]?.conversation.archivedAt).not.toBeNull();
    expect(secondPage.items.map((item) => item.id)).toEqual([
      snapshotIds[2],
      crossSnapshotId,
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)),
    ).toHaveLength(4);
  });

  it("returns only finalized generated files and rejects unreachable snapshot links", async () => {
    const firstPage = await listLibraryArtifactPage(
      { userId: ownerId, cursor: null, limit: 1 },
      database,
    );
    const secondPage = await listLibraryArtifactPage(
      { userId: ownerId, cursor: firstPage.nextCursor, limit: 1 },
      database,
    );
    const items = [...firstPage.items, ...secondPage.items];

    expect(items.map((item) => item.id)).toEqual(validArtifactIds);
    expect(items.map((item) => item.name)).toEqual(["buyers.csv", "buyers.csv"]);
    expect(items.map((item) => item.researchSnapshotId)).toEqual([
      snapshotIds[0],
      null,
    ]);
    expect(items.some((item) => item.name === "supplier-list.csv")).toBe(false);
    expect(items.some((item) => item.id === crossOwnerArtifactId)).toBe(false);
    expect(items.some((item) => item.id === crossConversationArtifactId)).toBe(
      false,
    );
    expect(secondPage.nextCursor).toBeNull();
  });

  it("materializes only completed owner-visible research with a reachable assistant", async () => {
    const detail = await getLibraryResearchDetail(
      ownerId,
      snapshotIds[0],
      database,
    );
    expect(detail).toMatchObject({
      id: snapshotIds[0],
      companyCount: 1,
      conversation: { id: mainConversationId },
      companies: [
        {
          name: "Buyer GmbH",
          contacts: [{ name: "Alex Buyer", confidence: "A" }],
        },
      ],
    });
    await expect(
      getLibraryResearchDetail(otherOwnerId, snapshotIds[0], database),
    ).resolves.toBeNull();
    await expect(
      getLibraryResearchDetail(ownerId, deletedSnapshotId, database),
    ).resolves.toBeNull();
    await expect(
      getLibraryResearchDetail(ownerId, runningSnapshotId, database),
    ).resolves.toBeNull();
    await expect(
      getLibraryResearchDetail(ownerId, brokenSnapshotId, database),
    ).resolves.toBeNull();
  });
});
