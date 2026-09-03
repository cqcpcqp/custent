import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migrationFilenamesBefore016 = [
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
] as const;

type MigrationContext = {
  client: PoolClient;
  database: Pool;
  schemaName: string;
  migration016: string;
  assertion016: string;
};

async function withSchemaBefore016(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 3 });
  const client = await database.connect();
  const schemaName = `migration_016_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);

    for (const filename of migrationFilenamesBefore016) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      client,
      database,
      schemaName,
      migration016: await readFile(
        path.join(migrationsDirectory, "016_conversation_branches.sql"),
        "utf8",
      ),
      assertion016: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/016_conversation_branches.sql",
        ),
        "utf8",
      ),
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release();
    await database.end();
  }
}

type HistoricalFixture = {
  userId: string;
  otherUserId: string;
  branchConversationId: string;
  attachmentConversationId: string;
  emptyConversationId: string;
  firstInputMessageId: string;
  firstAssistantMessageId: string;
  secondInputMessageId: string;
  secondAssistantMessageId: string;
  attachmentMessageIds: [string, string];
  firstRunId: string;
  secondRunId: string;
  attachmentIds: [string, string];
  stagedAttachmentId: string;
};

async function insertHistoricalFixture(
  client: PoolClient,
): Promise<HistoricalFixture> {
  const fixture: HistoricalFixture = {
    userId: randomUUID(),
    otherUserId: randomUUID(),
    branchConversationId: randomUUID(),
    attachmentConversationId: randomUUID(),
    emptyConversationId: randomUUID(),
    firstInputMessageId: randomUUID(),
    firstAssistantMessageId: randomUUID(),
    secondInputMessageId: randomUUID(),
    secondAssistantMessageId: randomUUID(),
    attachmentMessageIds: [randomUUID(), randomUUID()],
    firstRunId: randomUUID(),
    secondRunId: randomUUID(),
    attachmentIds: [randomUUID(), randomUUID()],
    stagedAttachmentId: randomUUID(),
  };

  await client.query("BEGIN");
  await client.query(
    `
      INSERT INTO users (id, name, available_credits)
      VALUES
        ($1, '016 migration owner', 1000),
        ($2, '016 migration other owner', 1000)
    `,
    [fixture.userId, fixture.otherUserId],
  );
  await client.query(
    `
      INSERT INTO conversations (id, user_id, title)
      VALUES
        ($1, $4, 'historical linear branch'),
        ($2, $4, 'historical attachment messages'),
        ($3, $4, 'historical empty conversation')
    `,
    [
      fixture.branchConversationId,
      fixture.attachmentConversationId,
      fixture.emptyConversationId,
      fixture.userId,
    ],
  );
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
        ($1, $7, 'user', 'first input', '[]', '2035-01-01T00:00:01Z'),
        ($2, $7, 'assistant', 'first answer', '[]', '2035-01-01T00:00:02Z'),
        ($3, $7, 'user', 'second input', '[]', '2020-01-01T00:00:01Z'),
        ($4, $7, 'assistant', 'second answer', '[]', '2020-01-01T00:00:02Z'),
        ($5, $8, 'user', 'old immutable attachment message', '[]', now()),
        ($6, $8, 'user', 'new immutable attachment message', '[]', now())
    `,
    [
      fixture.firstInputMessageId,
      fixture.firstAssistantMessageId,
      fixture.secondInputMessageId,
      fixture.secondAssistantMessageId,
      fixture.attachmentMessageIds[0],
      fixture.attachmentMessageIds[1],
      fixture.branchConversationId,
      fixture.attachmentConversationId,
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
        created_at,
        completed_at,
        finished_at,
        updated_at,
        conversation_turn,
        attempt_index,
        predecessor_run_id
      )
      VALUES
        (
          $1, $2, $3, $4, 'completed', 20, 1, 1, 1, 0, $5, $6,
          '2035-01-01T00:00:00Z', now(), now(), now(), 1, 1, NULL
        ),
        (
          $7, $8, $3, $4, 'completed', 20, 1, 1, 1, 0, $9, $10,
          '2020-01-01T00:00:00Z', now(), now(), now(), 2, 1, $1
        )
    `,
    [
      fixture.firstRunId,
      randomUUID(),
      fixture.userId,
      fixture.branchConversationId,
      fixture.firstInputMessageId,
      fixture.firstAssistantMessageId,
      fixture.secondRunId,
      randomUUID(),
      fixture.secondInputMessageId,
      fixture.secondAssistantMessageId,
    ],
  );
  await client.query(
    `
      UPDATE messages
      SET run_id = CASE id
        WHEN $1::uuid THEN $5::uuid
        WHEN $2::uuid THEN $5::uuid
        WHEN $3::uuid THEN $6::uuid
        WHEN $4::uuid THEN $6::uuid
      END
      WHERE id = ANY($7::uuid[])
    `,
    [
      fixture.firstInputMessageId,
      fixture.firstAssistantMessageId,
      fixture.secondInputMessageId,
      fixture.secondAssistantMessageId,
      fixture.firstRunId,
      fixture.secondRunId,
      [
        fixture.firstInputMessageId,
        fixture.firstAssistantMessageId,
        fixture.secondInputMessageId,
        fixture.secondAssistantMessageId,
      ],
    ],
  );
  await client.query(
    `
      INSERT INTO input_attachments (
        id,
        user_id,
        message_id,
        position,
        kind,
        original_name,
        mime_type,
        size_bytes,
        sha256,
        storage_path,
        created_at,
        attached_at,
        expires_at
      )
      VALUES
        (
          $1, $4, $5, 0, 'file', 'first.txt', 'text/plain', 5,
          repeat('a', 64), $1::uuid::text, '2026-01-01T00:00:00Z',
          '2026-01-01T00:01:00Z', NULL
        ),
        (
          $2, $4, $5, 1, 'file', 'second.txt', 'text/plain', 6,
          repeat('b', 64), $2::uuid::text, '2026-01-01T00:00:01Z',
          '2026-01-01T00:01:01Z', NULL
        ),
        (
          $3, $4, NULL, NULL, 'file', 'staged.txt', 'text/plain', 7,
          repeat('c', 64), $3::uuid::text, '2026-01-01T00:00:02Z',
          NULL, '2099-01-01T00:00:00Z'
        )
    `,
    [
      fixture.attachmentIds[0],
      fixture.attachmentIds[1],
      fixture.stagedAttachmentId,
      fixture.userId,
      fixture.attachmentMessageIds[0],
    ],
  );
  await client.query("COMMIT");

  return fixture;
}

async function expectDeferredFailure(
  client: PoolClient,
  action: () => Promise<void>,
  expected: { code: string; message?: string },
): Promise<void> {
  await client.query("BEGIN");
  try {
    await action();
    await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject(
      {
        code: expected.code,
        ...(expected.message === undefined
          ? {}
          : { message: expect.stringContaining(expected.message) }),
      },
    );
  } finally {
    await client.query("ROLLBACK");
  }
}

async function insertFailedRoot(
  client: PoolClient,
  input: {
    userId: string;
    conversationId: string;
    inputMessageId: string;
    runId: string;
  },
): Promise<void> {
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
        failure_code,
        failure_message,
        finished_at,
        conversation_turn,
        attempt_index
      )
      VALUES (
        $1, $2, $3, $4, 'failed', 20, $5, $6,
        'PROVIDER_ERROR', 'provider failed', now(), 1, 1
      )
    `,
    [
      input.runId,
      randomUUID(),
      input.userId,
      input.conversationId,
      input.inputMessageId,
      randomUUID(),
    ],
  );
}

describe.runIf(databaseUrl !== undefined)(
  "016 conversation branch and normalized attachment migration",
  () => {
    it("refuses to guess a selected Run when historical structure has multiple leaves", async () => {
      await withSchemaBefore016(async ({ client, migration016 }) => {
        const fixture = await insertHistoricalFixture(client);
        const divergentRunId = randomUUID();

        await client.query(
          "ALTER TABLE runs DISABLE TRIGGER runs_turn_queue_integrity_insert_trigger",
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
              failure_code,
              failure_message,
              finished_at,
              conversation_turn,
              attempt_index,
              regenerate_of_run_id
            )
            VALUES (
              $1, $2, $3, $4, 'failed', 20, $5, $6,
              'PROVIDER_ERROR', 'divergent historical leaf', now(), 1, 2, $7
            )
          `,
          [
            divergentRunId,
            randomUUID(),
            fixture.userId,
            fixture.branchConversationId,
            fixture.firstInputMessageId,
            randomUUID(),
            fixture.firstRunId,
          ],
        );
        await client.query(
          "ALTER TABLE runs ENABLE TRIGGER runs_turn_queue_integrity_insert_trigger",
        );

        await expect(client.query(migration016)).rejects.toMatchObject({
          code: "23514",
          message: expect.stringContaining(
            "exactly one structural Run leaf per historical non-empty conversation",
          ),
        });

        await expect(
          client.query(
            `
              SELECT 1
              FROM information_schema.columns
              WHERE
                table_schema = current_schema()
                AND table_name = 'conversations'
                AND column_name = 'selected_run_id'
            `,
          ),
        ).resolves.toMatchObject({ rowCount: 0 });
      });
    });

    it("backfills deterministic heads, supports branches, and normalizes shared attachments without data loss", async () => {
      await withSchemaBefore016(
        async ({
          client,
          database,
          schemaName,
          migration016,
          assertion016,
        }) => {
          const fixture = await insertHistoricalFixture(client);

          await client.query(migration016);

          const selected = await client.query<{
            id: string;
            selected_run_id: string | null;
          }>(
            `
              SELECT id, selected_run_id
              FROM conversations
              WHERE id = ANY($1::uuid[])
              ORDER BY id
            `,
            [[
              fixture.branchConversationId,
              fixture.attachmentConversationId,
              fixture.emptyConversationId,
            ]],
          );
          expect(
            new Map(
              selected.rows.map((row) => [row.id, row.selected_run_id]),
            ),
          ).toEqual(
            new Map([
              [fixture.branchConversationId, fixture.secondRunId],
              [fixture.attachmentConversationId, null],
              [fixture.emptyConversationId, null],
            ]),
          );

          await expect(
            client.query<{ column_name: string }>(
              `
                SELECT column_name
                FROM information_schema.columns
                WHERE
                  table_schema = current_schema()
                  AND table_name = 'input_attachments'
                  AND column_name IN ('message_id', 'position')
              `,
            ),
          ).resolves.toMatchObject({ rowCount: 0 });

          const indexes = await client.query<{ indexname: string }>(
            `
              SELECT indexname
              FROM pg_indexes
              WHERE
                schemaname = current_schema()
                AND tablename = 'runs'
              ORDER BY indexname
            `,
          );
          expect(indexes.rows.map((row) => row.indexname)).toContain(
            "runs_input_message_attempt_unique_idx",
          );
          expect(indexes.rows.map((row) => row.indexname)).not.toContain(
            "runs_conversation_turn_attempt_unique_idx",
          );
          expect(indexes.rows.map((row) => row.indexname)).not.toContain(
            "runs_initial_input_message_unique_idx",
          );

          const migratedAttachments = await client.query<{
            attachment_id: string;
            message_id: string;
            position: number;
          }>(
            `
              SELECT attachment_id, message_id, position
              FROM message_input_attachments
              WHERE attachment_id = ANY($1::uuid[])
              ORDER BY position
            `,
            [fixture.attachmentIds],
          );
          expect(migratedAttachments.rows).toEqual([
            {
              attachment_id: fixture.attachmentIds[0],
              message_id: fixture.attachmentMessageIds[0],
              position: 0,
            },
            {
              attachment_id: fixture.attachmentIds[1],
              message_id: fixture.attachmentMessageIds[0],
              position: 1,
            },
          ]);
          await expect(
            client.query(
              `
                SELECT id
                FROM input_attachments
                WHERE id = ANY($1::uuid[])
              `,
              [[...fixture.attachmentIds, fixture.stagedAttachmentId]],
            ),
          ).resolves.toMatchObject({ rowCount: 3 });

          await expectDeferredFailure(
            client,
            async () => {
              await client.query(
                "UPDATE conversations SET selected_run_id = NULL WHERE id = $1",
                [fixture.branchConversationId],
              );
            },
            {
              code: "23514",
              message: "non-empty conversation must select a Run",
            },
          );

          const foreignConversationId = randomUUID();
          const foreignInputId = randomUUID();
          const foreignRunId = randomUUID();
          await client.query("BEGIN");
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'foreign selected Run')
            `,
            [foreignConversationId, fixture.otherUserId],
          );
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations)
              VALUES ($1, $2, 'user', 'foreign input', '[]')
            `,
            [foreignInputId, foreignConversationId],
          );
          await insertFailedRoot(client, {
            userId: fixture.otherUserId,
            conversationId: foreignConversationId,
            inputMessageId: foreignInputId,
            runId: foreignRunId,
          });
          await client.query(
            "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
            [foreignConversationId, foreignRunId],
          );
          await client.query("COMMIT");

          await expectDeferredFailure(
            client,
            async () => {
              await client.query(
                "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
                [fixture.branchConversationId, foreignRunId],
              );
            },
            {
              code: "23514",
              message: "selected Run must belong to the same user and conversation",
            },
          );

          const regeneratedRunId = randomUUID();
          const siblingInputMessageId = randomUUID();
          const siblingRunId = randomUUID();
          await client.query("BEGIN");
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations)
              VALUES ($1, $2, 'user', 'sibling branch input', '[]')
            `,
            [siblingInputMessageId, fixture.branchConversationId],
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
                failure_code,
                failure_message,
                finished_at,
                conversation_turn,
                attempt_index,
                regenerate_of_run_id
              )
              VALUES (
                $1, $2, $3, $4, 'failed', 20, $5, $6,
                'PROVIDER_ERROR', 'regenerated branch failed', now(), 1, 2, $7
              )
            `,
            [
              regeneratedRunId,
              randomUUID(),
              fixture.userId,
              fixture.branchConversationId,
              fixture.firstInputMessageId,
              randomUUID(),
              fixture.firstRunId,
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
                predecessor_run_id
              )
              VALUES ($1, $2, $3, $4, 'waiting', 20, $5, $6, 2, 1, $7)
            `,
            [
              siblingRunId,
              randomUUID(),
              fixture.userId,
              fixture.branchConversationId,
              siblingInputMessageId,
              randomUUID(),
              regeneratedRunId,
            ],
          );
          await client.query(
            "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
            [fixture.branchConversationId, siblingRunId],
          );
          await client.query("COMMIT");

          await expect(
            client.query(
              `
                SELECT id
                FROM runs
                WHERE
                  conversation_id = $1
                  AND conversation_turn = 2
                  AND attempt_index = 1
              `,
              [fixture.branchConversationId],
            ),
          ).resolves.toMatchObject({ rowCount: 2 });
          await expect(
            client.query("SELECT assert_run_turn_queue_integrity($1)", [
              fixture.secondRunId,
            ]),
          ).resolves.toBeDefined();

          const concurrentConversationId = randomUUID();
          const concurrentParentInputId = randomUUID();
          const concurrentParentRunId = randomUUID();
          const concurrentInputIds = [randomUUID(), randomUUID()] as const;
          await client.query("BEGIN");
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'concurrent waiting successor serialization')
            `,
            [concurrentConversationId, fixture.userId],
          );
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations)
              VALUES
                ($1, $4, 'user', 'concurrent parent', '[]'),
                ($2, $4, 'user', 'concurrent child one', '[]'),
                ($3, $4, 'user', 'concurrent child two', '[]')
            `,
            [
              concurrentParentInputId,
              concurrentInputIds[0],
              concurrentInputIds[1],
              concurrentConversationId,
            ],
          );
          await insertFailedRoot(client, {
            userId: fixture.userId,
            conversationId: concurrentConversationId,
            inputMessageId: concurrentParentInputId,
            runId: concurrentParentRunId,
          });
          await client.query(
            "UPDATE conversations SET selected_run_id = $2 WHERE id = $1",
            [concurrentConversationId, concurrentParentRunId],
          );
          await client.query("COMMIT");

          const concurrentClients = [
            await database.connect(),
            await database.connect(),
          ] as const;
          try {
            await Promise.all(
              concurrentClients.map((concurrentClient) =>
                concurrentClient.query(
                  `SET search_path TO ${schemaName}, public`,
                ),
              ),
            );
            const concurrentRunIds = [randomUUID(), randomUUID()] as const;
            const concurrentResults = await Promise.allSettled(
              concurrentClients.map((concurrentClient, index) =>
                concurrentClient.query(
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
                      predecessor_run_id
                    )
                    VALUES (
                      $1, $2, $3, $4, 'waiting', 20, $5, $6, 2, 1, $7
                    )
                  `,
                  [
                    concurrentRunIds[index],
                    randomUUID(),
                    fixture.userId,
                    concurrentConversationId,
                    concurrentInputIds[index],
                    randomUUID(),
                    concurrentParentRunId,
                  ],
                ),
              ),
            );
            expect(
              concurrentResults.filter((result) => result.status === "fulfilled"),
            ).toHaveLength(1);
            const rejected = concurrentResults.find(
              (result) => result.status === "rejected",
            );
            expect(rejected).toMatchObject({
              status: "rejected",
              reason: {
                code: "23505",
                constraint: "runs_waiting_predecessor_unique_idx",
              },
            });
          } finally {
            concurrentClients.forEach((concurrentClient) =>
              concurrentClient.release(),
            );
          }
          await expect(
            client.query(
              `
                SELECT id
                FROM runs
                WHERE
                  predecessor_run_id = $1
                  AND status = 'waiting'
              `,
              [concurrentParentRunId],
            ),
          ).resolves.toMatchObject({ rowCount: 1 });

          await expect(
            client.query(
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
                  failure_code,
                  failure_message,
                  finished_at,
                  conversation_turn,
                  attempt_index,
                  predecessor_run_id
                )
                VALUES (
                  $1, $2, $3, $4, 'failed', 20, $5, $6,
                  'PROVIDER_ERROR', 'duplicate input attempt', now(), 2, 1, $7
                )
              `,
              [
                randomUUID(),
                randomUUID(),
                fixture.userId,
                fixture.branchConversationId,
                siblingInputMessageId,
                randomUUID(),
                fixture.firstRunId,
              ],
            ),
          ).rejects.toMatchObject({
            code: "23505",
            constraint: "runs_input_message_attempt_unique_idx",
          });

          const invalidChildInputId = randomUUID();
          await expectDeferredFailure(
            client,
            async () => {
              await client.query(
                `
                  INSERT INTO messages (id, conversation_id, role, content, citations)
                  VALUES ($1, $2, 'user', 'must wait after failure', '[]')
                `,
                [invalidChildInputId, fixture.branchConversationId],
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
                    predecessor_run_id
                  )
                  VALUES ($1, $2, $3, $4, 'queued', 20, $5, $6, 2, 1, $7)
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.branchConversationId,
                  invalidChildInputId,
                  randomUUID(),
                  regeneratedRunId,
                ],
              );
            },
            {
              code: "23514",
              message: "executable Run requires a completed predecessor",
            },
          );

          await expectDeferredFailure(
            client,
            async () => {
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
                    failure_code,
                    failure_message,
                    finished_at,
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES (
                    $1, $2, $3, $4, 'failed', 20, $5, $6,
                    'PROVIDER_ERROR', 'wrong source input', now(), 2, 2, $7, $8
                  )
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.branchConversationId,
                  siblingInputMessageId,
                  randomUUID(),
                  fixture.firstRunId,
                  fixture.secondRunId,
                ],
              );
            },
            {
              code: "23514",
              message: "regenerate Run must reuse its source input message",
            },
          );

          await expectDeferredFailure(
            client,
            async () => {
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
                    failure_code,
                    failure_message,
                    finished_at,
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES (
                    $1, $2, $3, $4, 'failed', 20, $5, $6,
                    'PROVIDER_ERROR', 'wrong source predecessor', now(),
                    2, 2, $7, $8
                  )
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.branchConversationId,
                  fixture.secondInputMessageId,
                  randomUUID(),
                  regeneratedRunId,
                  fixture.secondRunId,
                ],
              );
            },
            {
              code: "23514",
              message: "regenerate Run must preserve its source predecessor",
            },
          );

          await expectDeferredFailure(
            client,
            async () => {
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
                    failure_code,
                    failure_message,
                    finished_at,
                    conversation_turn,
                    attempt_index,
                    predecessor_run_id,
                    regenerate_of_run_id
                  )
                  VALUES (
                    $1, $2, $3, $4, 'failed', 20, $5, $6,
                    'PROVIDER_ERROR', 'non-adjacent source attempt', now(),
                    2, 3, $7, $8
                  )
                `,
                [
                  randomUUID(),
                  randomUUID(),
                  fixture.userId,
                  fixture.branchConversationId,
                  fixture.secondInputMessageId,
                  randomUUID(),
                  fixture.firstRunId,
                  fixture.secondRunId,
                ],
              );
            },
            {
              code: "23514",
              message:
                "regenerate attempt must immediately follow its source attempt",
            },
          );

          await client.query("BEGIN");
          await client.query(
            `
              INSERT INTO message_input_attachments (
                message_id,
                attachment_id,
                position
              )
              VALUES
                ($1, $3, 0),
                ($1, $2, 1)
            `,
            [
              fixture.attachmentMessageIds[1],
              fixture.attachmentIds[0],
              fixture.attachmentIds[1],
            ],
          );
          await client.query("COMMIT");

          const sharedOrder = await client.query<{
            attachment_id: string;
            position: number;
          }>(
            `
              SELECT attachment_id, position
              FROM message_input_attachments
              WHERE message_id = $1
              ORDER BY position
            `,
            [fixture.attachmentMessageIds[1]],
          );
          expect(sharedOrder.rows).toEqual([
            { attachment_id: fixture.attachmentIds[1], position: 0 },
            { attachment_id: fixture.attachmentIds[0], position: 1 },
          ]);

          const foreignMessageId = randomUUID();
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations)
              VALUES ($1, $2, 'user', 'foreign attachment target', '[]')
            `,
            [foreignMessageId, foreignConversationId],
          );
          await expectDeferredFailure(
            client,
            async () => {
              await client.query(
                `
                  INSERT INTO message_input_attachments (
                    message_id,
                    attachment_id,
                    position
                  )
                  VALUES ($1, $2, 0)
                `,
                [foreignMessageId, fixture.attachmentIds[0]],
              );
            },
            {
              code: "23514",
              message:
                "input attachment owner must match message conversation owner",
            },
          );

          await expect(
            client.query("DELETE FROM input_attachments WHERE id = $1", [
              fixture.attachmentIds[0],
            ]),
          ).rejects.toMatchObject({ code: "23503" });

          await client.query("BEGIN");
          await client.query("DELETE FROM messages WHERE id = $1", [
            fixture.attachmentMessageIds[0],
          ]);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          await client.query("COMMIT");
          await expect(
            client.query(
              "SELECT id FROM input_attachments WHERE id = ANY($1::uuid[])",
              [fixture.attachmentIds],
            ),
          ).resolves.toMatchObject({ rowCount: 2 });
          await expect(
            client.query(
              `
                SELECT attachment_id
                FROM input_attachment_deletions
                WHERE attachment_id = ANY($1::uuid[])
              `,
              [fixture.attachmentIds],
            ),
          ).resolves.toMatchObject({ rowCount: 0 });

          await client.query("BEGIN");
          await client.query("SET CONSTRAINTS ALL DEFERRED");
          await client.query("DELETE FROM messages WHERE id = $1", [
            fixture.attachmentMessageIds[1],
          ]);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          await client.query("COMMIT");
          await expect(
            client.query(
              "SELECT id FROM input_attachments WHERE id = ANY($1::uuid[])",
              [fixture.attachmentIds],
            ),
          ).resolves.toMatchObject({ rowCount: 0 });
          await expect(
            client.query(
              `
                SELECT attachment_id
                FROM input_attachment_deletions
                WHERE attachment_id = ANY($1::uuid[])
              `,
              [fixture.attachmentIds],
            ),
          ).resolves.toMatchObject({ rowCount: 2 });
          await expect(
            client.query("SELECT id FROM input_attachments WHERE id = $1", [
              fixture.stagedAttachmentId,
            ]),
          ).resolves.toMatchObject({ rowCount: 1 });

          const conversationCascadeId = randomUUID();
          const conversationCascadeMessageId = randomUUID();
          const conversationCascadeAttachmentId = randomUUID();
          await client.query("BEGIN");
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'conversation attachment cascade')
            `,
            [conversationCascadeId, fixture.userId],
          );
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations)
              VALUES ($1, $2, 'user', 'deleted with conversation', '[]')
            `,
            [conversationCascadeMessageId, conversationCascadeId],
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
                attached_at,
                expires_at
              )
              VALUES (
                $1, $2, 'file', 'conversation-delete.txt', 'text/plain', 1,
                repeat('d', 64), $1::uuid::text, now(), NULL
              )
            `,
            [conversationCascadeAttachmentId, fixture.userId],
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
            [conversationCascadeMessageId, conversationCascadeAttachmentId],
          );
          await client.query("COMMIT");

          await client.query("BEGIN");
          await client.query("DELETE FROM conversations WHERE id = $1", [
            conversationCascadeId,
          ]);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          await client.query("COMMIT");
          await expect(
            client.query("SELECT id FROM input_attachments WHERE id = $1", [
              conversationCascadeAttachmentId,
            ]),
          ).resolves.toMatchObject({ rowCount: 0 });
          await expect(
            client.query(
              `
                SELECT attachment_id
                FROM input_attachment_deletions
                WHERE attachment_id = $1
              `,
              [conversationCascadeAttachmentId],
            ),
          ).resolves.toMatchObject({ rowCount: 1 });

          const userCascadeId = randomUUID();
          const userCascadeConversationId = randomUUID();
          const userCascadeMessageId = randomUUID();
          const userCascadeAttachmentId = randomUUID();
          await client.query("BEGIN");
          await client.query(
            `
              INSERT INTO users (id, name, available_credits)
              VALUES ($1, '016 user cascade integration', 100)
            `,
            [userCascadeId],
          );
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'user attachment cascade')
            `,
            [userCascadeConversationId, userCascadeId],
          );
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations)
              VALUES ($1, $2, 'user', 'deleted with user', '[]')
            `,
            [userCascadeMessageId, userCascadeConversationId],
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
                attached_at,
                expires_at
              )
              VALUES (
                $1, $2, 'file', 'user-delete.txt', 'text/plain', 1,
                repeat('e', 64), $1::uuid::text, now(), NULL
              )
            `,
            [userCascadeAttachmentId, userCascadeId],
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
            [userCascadeMessageId, userCascadeAttachmentId],
          );
          await client.query("COMMIT");

          await client.query("BEGIN");
          await client.query("DELETE FROM users WHERE id = $1", [userCascadeId]);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          await client.query("COMMIT");
          await expect(
            client.query("SELECT id FROM input_attachments WHERE id = $1", [
              userCascadeAttachmentId,
            ]),
          ).resolves.toMatchObject({ rowCount: 0 });
          await expect(
            client.query(
              `
                SELECT attachment_id
                FROM message_input_attachments
                WHERE attachment_id = $1
              `,
              [userCascadeAttachmentId],
            ),
          ).resolves.toMatchObject({ rowCount: 0 });

          await expect(client.query(assertion016)).resolves.toBeDefined();
        },
      );
    });
  },
);
