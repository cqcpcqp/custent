import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migration011Filename = "011_legacy_run_message_links.sql";
const migrationExplanation =
  "【系统迁移说明】这个历史运行在旧版本中被标记为“已完成”，但数据库中没有保存可恢复的助手回答。此消息由数据迁移生成，仅用于说明记录缺失，并不是模型生成的回答。";

type LegacySchemaContext = {
  client: PoolClient;
  migration011: string;
  assertion011: string;
};

async function withLegacySchema(
  test: (context: LegacySchemaContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_011_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);

    for (let migrationNumber = 1; migrationNumber <= 10; migrationNumber += 1) {
      const prefix = migrationNumber.toString().padStart(3, "0");
      const filenames = [
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
      ];
      const filename = filenames[migrationNumber - 1];
      if (filename === undefined || !filename.startsWith(prefix)) {
        throw new TypeError(`Missing migration fixture for ${prefix}`);
      }
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }

    await test({
      client,
      migration011: await readFile(
        path.join(migrationsDirectory, migration011Filename),
        "utf8",
      ),
      assertion011: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/011_legacy_run_message_links.sql",
        ),
        "utf8",
      ),
    });
  } finally {
    await client.query("RESET search_path");
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    client.release();
    await database.end();
  }
}

async function insertUserAndConversation(
  client: PoolClient,
  input: { userId: string; conversationId: string; title: string },
): Promise<void> {
  await client.query(
    "INSERT INTO users (id, name, available_credits) VALUES ($1, $2, 1000)",
    [input.userId, `${input.title} user`],
  );
  await client.query(
    `
      INSERT INTO conversations (id, user_id, title, updated_at)
      VALUES ($1, $2, $3, '2026-08-23T00:00:00.000Z')
    `,
    [input.conversationId, input.userId, input.title],
  );
}

async function insertCompletedLegacyRun(
  client: PoolClient,
  input: {
    runId: string;
    requestId: string;
    userId: string;
    conversationId: string;
    inputMessageId?: string;
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
        charged_credits,
        input_tokens,
        output_tokens,
        web_searches,
        input_message_id,
        created_at,
        completed_at,
        finished_at,
        updated_at,
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
        1,
        1,
        1,
        0,
        $5,
        '2026-08-24T00:00:00.000Z',
        '2026-08-24T00:00:50.000Z',
        '2026-08-24T00:01:00.000Z',
        '2026-08-24T00:01:10.000Z',
        1,
        1
      )
    `,
    [
      input.runId,
      input.requestId,
      input.userId,
      input.conversationId,
      input.inputMessageId ?? null,
    ],
  );
}

async function insertReconciliationLegacyRun(
  client: PoolClient,
  input: {
    runId: string;
    requestId: string;
    userId: string;
    conversationId: string;
    conversationTurn?: number;
    predecessorRunId?: string;
    inputMessageId?: string;
    assistantMessageId?: string;
    createdAt?: string;
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
        reconciliation_reason,
        failure_code,
        failure_message,
        created_at,
        finished_at,
        updated_at,
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
        'legacy reconciliation',
        'RUN_REQUIRES_RECONCILIATION',
        'legacy reconciliation',
        $7,
        $7::timestamptz + interval '1 minute',
        $7::timestamptz + interval '1 minute',
        $8,
        1,
        $9
      )
    `,
    [
      input.runId,
      input.requestId,
      input.userId,
      input.conversationId,
      input.inputMessageId ?? null,
      input.assistantMessageId ?? null,
      input.createdAt ?? "2026-08-24T00:00:00.000Z",
      input.conversationTurn ?? 1,
      input.predecessorRunId ?? null,
    ],
  );
}

describe.runIf(databaseUrl !== undefined)(
  "011 legacy Run message-link migration",
  () => {
    it(
      "binds each unique temporal input, explains irrecoverable completions, and plans terminal assistant IDs",
      async () => {
        await withLegacySchema(async ({ client, migration011, assertion011 }) => {
          const userId = randomUUID();
          const completedConversationId = randomUUID();
          const reconciliationConversationId = randomUUID();
          const completedRunId = randomUUID();
          const reconciliationRunId = randomUUID();
          const completedInputId = randomUUID();
          const reconciliationInputId = randomUUID();

          await insertUserAndConversation(client, {
            userId,
            conversationId: completedConversationId,
            title: "irrecoverable completed Run",
          });
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title, updated_at)
              VALUES ($1, $2, $3, '2026-08-23T00:00:00.000Z')
            `,
            [
              reconciliationConversationId,
              userId,
              "reconciliation without answer",
            ],
          );
          await insertCompletedLegacyRun(client, {
            runId: completedRunId,
            requestId: randomUUID(),
            userId,
            conversationId: completedConversationId,
          });
          await insertReconciliationLegacyRun(client, {
            runId: reconciliationRunId,
            requestId: randomUUID(),
            userId,
            conversationId: reconciliationConversationId,
          });
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
                ($1, $2, 'user', 'completed input', '[]', '2026-08-24T00:00:01.000Z'),
                ($3, $4, 'user', 'reconciliation input', '[]', '2026-08-24T00:00:01.000Z')
            `,
            [
              completedInputId,
              completedConversationId,
              reconciliationInputId,
              reconciliationConversationId,
            ],
          );

          await client.query(
            `
              UPDATE users
              SET available_credits = 900, reserved_credits = 80, frozen_credits = 20
              WHERE id = $1
            `,
            [userId],
          );
          await client.query(
            `
              UPDATE conversations
              SET read_through_terminal_event_id = 7
              WHERE id = ANY($1::uuid[])
            `,
            [[completedConversationId, reconciliationConversationId]],
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
              VALUES ($1, $2, $3, 'freeze', 0, -20, 20)
            `,
            [userId, reconciliationRunId, `migration-011:${reconciliationRunId}`],
          );
          await client.query(
            `
              INSERT INTO run_events (run_id, event_type, payload, created_at)
              VALUES (
                $1,
                'error',
                '{"type":"error","error":{"code":"LEGACY","message":"legacy terminal event","runId":"legacy"}}',
                '2026-08-24T00:01:01.000Z'
              )
            `,
            [reconciliationRunId],
          );
          await client.query(
            `
              INSERT INTO agent_session_items (
                conversation_id,
                position,
                item,
                created_at
              )
              VALUES (
                $1,
                1,
                '{"role":"user","content":"preserve legacy session"}',
                '2026-08-24T00:00:02.000Z'
              )
            `,
            [reconciliationConversationId],
          );

          const readUnchangedState = async () => {
            const user = await client.query(
              `
                SELECT available_credits, reserved_credits, frozen_credits, created_at, updated_at
                FROM users
                WHERE id = $1
              `,
              [userId],
            );
            const runs = await client.query(
              `
                SELECT
                  id,
                  status,
                  reservation_credits,
                  charged_credits,
                  input_tokens,
                  output_tokens,
                  web_searches,
                  reconciliation_reason,
                  failure_code,
                  failure_message,
                  created_at,
                  started_at,
                  completed_at,
                  updated_at,
                  finished_at,
                  conversation_turn,
                  attempt_index,
                  predecessor_run_id,
                  retry_of_run_id
                FROM runs
                WHERE id = ANY($1::uuid[])
                ORDER BY id
              `,
              [[completedRunId, reconciliationRunId]],
            );
            const ledger = await client.query(
              `
                SELECT
                  run_id,
                  idempotency_key,
                  entry_type,
                  available_delta,
                  reserved_delta,
                  frozen_delta,
                  created_at
                FROM credit_ledger
                WHERE user_id = $1
                ORDER BY id
              `,
              [userId],
            );
            const events = await client.query(
              `
                SELECT run_id, event_type, payload, created_at
                FROM run_events
                WHERE run_id = ANY($1::uuid[])
                ORDER BY id
              `,
              [[completedRunId, reconciliationRunId]],
            );
            const conversations = await client.query(
              `
                SELECT
                  id,
                  title,
                  created_at,
                  updated_at,
                  pinned_at,
                  archived_at,
                  deleted_at,
                  read_through_terminal_event_id
                FROM conversations
                WHERE id = ANY($1::uuid[])
                ORDER BY id
              `,
              [[completedConversationId, reconciliationConversationId]],
            );
            const session = await client.query(
              `
                SELECT conversation_id, position, item, created_at
                FROM agent_session_items
                WHERE conversation_id = ANY($1::uuid[])
                ORDER BY conversation_id, position
              `,
              [[completedConversationId, reconciliationConversationId]],
            );
            return structuredClone({
              user: user.rows,
              runs: runs.rows,
              ledger: ledger.rows,
              events: events.rows,
              conversations: conversations.rows,
              session: session.rows,
            });
          };
          const unchangedStateBefore = await readUnchangedState();

          await client.query(migration011);

          expect(await readUnchangedState()).toEqual(unchangedStateBefore);

          const result = await client.query<{
            id: string;
            input_message_id: string;
            assistant_message_id: string;
            input_run_id: string;
            assistant_run_id: string | null;
            assistant_content: string | null;
            assistant_created_at: Date | null;
          }>(
            `
              SELECT
                run.id,
                run.input_message_id,
                run.assistant_message_id,
                input_message.run_id AS input_run_id,
                assistant_message.run_id AS assistant_run_id,
                assistant_message.content AS assistant_content,
                assistant_message.created_at AS assistant_created_at
              FROM runs run
              JOIN messages input_message ON input_message.id = run.input_message_id
              LEFT JOIN messages assistant_message
                ON assistant_message.id = run.assistant_message_id
              WHERE run.id = ANY($1::uuid[])
              ORDER BY run.id
            `,
            [[completedRunId, reconciliationRunId]],
          );
          const completed = result.rows.find((row) => row.id === completedRunId);
          const reconciliation = result.rows.find(
            (row) => row.id === reconciliationRunId,
          );

          expect(completed).toMatchObject({
            input_message_id: completedInputId,
            input_run_id: completedRunId,
            assistant_run_id: completedRunId,
            assistant_content: migrationExplanation,
          });
          expect(completed?.assistant_created_at?.toISOString()).toBe(
            "2026-08-24T00:01:00.000Z",
          );
          expect(reconciliation).toMatchObject({
            input_message_id: reconciliationInputId,
            input_run_id: reconciliationRunId,
            assistant_run_id: null,
            assistant_content: null,
          });
          expect(reconciliation?.assistant_message_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          );

          await expect(client.query(assertion011)).resolves.toBeDefined();
        });
      },
      30_000,
    );

    it(
      "fails closed when a temporal input window is ambiguous",
      async () => {
        await withLegacySchema(async ({ client, migration011 }) => {
          const userId = randomUUID();
          const conversationId = randomUUID();
          const runId = randomUUID();
          await insertUserAndConversation(client, {
            userId,
            conversationId,
            title: "ambiguous legacy input",
          });
          await insertReconciliationLegacyRun(client, {
            runId,
            requestId: randomUUID(),
            userId,
            conversationId,
          });
          await client.query(
            `
              INSERT INTO messages (conversation_id, role, content, citations, created_at)
              VALUES
                ($1, 'user', 'candidate one', '[]', '2026-08-24T00:00:01.000Z'),
                ($1, 'user', 'candidate two', '[]', '2026-08-24T00:00:02.000Z')
            `,
            [conversationId],
          );

          await expect(client.query(migration011)).rejects.toMatchObject({
            code: "23514",
          });
          const unchanged = await client.query<{
            input_message_id: string | null;
            assistant_message_id: string | null;
          }>(
            `
              SELECT input_message_id, assistant_message_id
              FROM runs
              WHERE id = $1
            `,
            [runId],
          );
          expect(unchanged.rows[0]).toEqual({
            input_message_id: null,
            assistant_message_id: null,
          });
        });
      },
      30_000,
    );

    it(
      "fails closed instead of stealing a temporal input owned by another Run",
      async () => {
        await withLegacySchema(async ({ client, migration011 }) => {
          const userId = randomUUID();
          const conversationId = randomUUID();
          const missingRunId = randomUUID();
          const ownerRunId = randomUUID();
          const candidateMessageId = randomUUID();
          await insertUserAndConversation(client, {
            userId,
            conversationId,
            title: "already owned temporal input",
          });
          await insertReconciliationLegacyRun(client, {
            runId: missingRunId,
            requestId: randomUUID(),
            userId,
            conversationId,
          });
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
              VALUES ($1, $2, 'user', 'owned candidate', '[]', '2026-08-24T00:01:00.000Z')
            `,
            [candidateMessageId, conversationId],
          );
          await insertReconciliationLegacyRun(client, {
            runId: ownerRunId,
            requestId: randomUUID(),
            userId,
            conversationId,
            conversationTurn: 2,
            predecessorRunId: missingRunId,
            inputMessageId: candidateMessageId,
            assistantMessageId: randomUUID(),
            createdAt: "2026-08-24T00:02:00.000Z",
          });
          await client.query(
            "UPDATE messages SET run_id = $2 WHERE id = $1",
            [candidateMessageId, ownerRunId],
          );

          await expect(client.query(migration011)).rejects.toMatchObject({
            code: "23514",
          });
          const unchanged = await client.query<{
            input_message_id: string | null;
          }>("SELECT input_message_id FROM runs WHERE id = $1", [missingRunId]);
          expect(unchanged.rows[0]?.input_message_id).toBeNull();
        });
      },
      30_000,
    );

    it(
      "fails closed for every surviving completed-answer evidence channel",
      async () => {
        await withLegacySchema(async ({ client, migration011 }) => {
          const userId = randomUUID();
          const conversationId = randomUUID();
          const runId = randomUUID();
          const inputMessageId = randomUUID();
          await insertUserAndConversation(client, {
            userId,
            conversationId,
            title: "completed Run with evidence",
          });
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
              VALUES ($1, $2, 'user', 'known input', '[]', '2026-08-24T00:00:01.000Z')
            `,
            [inputMessageId, conversationId],
          );
          await insertCompletedLegacyRun(client, {
            runId,
            requestId: randomUUID(),
            userId,
            conversationId,
            inputMessageId,
          });
          await client.query("UPDATE messages SET run_id = $2 WHERE id = $1", [
            inputMessageId,
            runId,
          ]);

          const artifactSupportConversationId = randomUUID();
          const artifactSupportRunId = randomUUID();
          const artifactSupportInputId = randomUUID();
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'artifact evidence support')
            `,
            [artifactSupportConversationId, userId],
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
              VALUES ($1, $2, 'user', 'artifact support input', '[]', '2026-08-24T00:00:01.000Z')
            `,
            [artifactSupportInputId, artifactSupportConversationId],
          );
          await insertReconciliationLegacyRun(client, {
            runId: artifactSupportRunId,
            requestId: randomUUID(),
            userId,
            conversationId: artifactSupportConversationId,
            inputMessageId: artifactSupportInputId,
            assistantMessageId: randomUUID(),
          });
          await client.query("UPDATE messages SET run_id = $2 WHERE id = $1", [
            artifactSupportInputId,
            artifactSupportRunId,
          ]);

          const evidenceSetups: Array<{
            name: string;
            insert: () => Promise<unknown>;
          }> = [
            {
              name: "assistant message",
              insert: () =>
                client.query(
                  `
                    INSERT INTO messages (
                      conversation_id,
                      role,
                      content,
                      citations,
                      created_at
                    )
                    VALUES ($1, 'assistant', 'surviving answer', '[]', '2026-08-24T00:00:30.000Z')
                  `,
                  [conversationId],
                ),
            },
            {
              name: "assistant session item",
              insert: () =>
                client.query(
                  `
                    INSERT INTO agent_session_items (conversation_id, position, item)
                    VALUES (
                      $1,
                      1,
                      '{"role":"assistant","status":"completed","content":[{"type":"output_text","text":"surviving answer"}]}'
                    )
                  `,
                  [conversationId],
                ),
            },
            {
              name: "Run event",
              insert: () =>
                client.query(
                  `
                    INSERT INTO run_events (run_id, event_type, payload)
                    VALUES ($1, 'delta', '{"type":"delta","text":"surviving answer"}')
                  `,
                  [runId],
                ),
            },
            {
              name: "research snapshot",
              insert: () =>
                client.query(
                  `
                    INSERT INTO research_snapshots (
                      user_id,
                      conversation_id,
                      run_id,
                      title,
                      query_summary,
                      limitations
                    )
                    VALUES ($1, $2, $3, 'evidence', 'evidence', 'evidence')
                  `,
                  [userId, conversationId, runId],
                ),
            },
            {
              name: "artifact",
              insert: async () => {
                const snapshotId = randomUUID();
                await client.query(
                  `
                    INSERT INTO research_snapshots (
                      id,
                      user_id,
                      conversation_id,
                      run_id,
                      title,
                      query_summary,
                      limitations
                    )
                    VALUES ($1, $2, $3, $4, 'artifact evidence', 'evidence', 'evidence')
                  `,
                  [
                    snapshotId,
                    userId,
                    artifactSupportConversationId,
                    artifactSupportRunId,
                  ],
                );
                return client.query(
                  `
                    INSERT INTO artifacts (
                      id,
                      user_id,
                      conversation_id,
                      run_id,
                      research_snapshot_id,
                      name,
                      mime_type,
                      size_bytes,
                      sha256,
                      storage_path
                    )
                    VALUES (
                      $1,
                      $2,
                      $3,
                      $4,
                      $5,
                      'evidence.csv',
                      'text/csv',
                      1,
                      repeat('a', 64),
                      $6
                    )
                  `,
                  [
                    randomUUID(),
                    userId,
                    conversationId,
                    runId,
                    snapshotId,
                    `migration-011-artifact-${randomUUID()}`,
                  ],
                );
              },
            },
          ];

          await client.query("BEGIN");
          try {
            for (const evidence of evidenceSetups) {
              await client.query("SAVEPOINT evidence_channel");
              await evidence.insert();
              let migrationError: unknown = null;
              try {
                await client.query(migration011);
              } catch (error) {
                migrationError = error;
              }
              await client.query("ROLLBACK TO SAVEPOINT evidence_channel");
              expect(migrationError, evidence.name).toMatchObject({
                code: "23514",
              });
            }
          } finally {
            await client.query("ROLLBACK");
          }
        });
      },
      30_000,
    );

    it(
      "repairs multiple Turns while preserving real assistants and valid retry input ownership",
      async () => {
        await withLegacySchema(async ({ client, migration011, assertion011 }) => {
          const userId = randomUUID();
          const multiTurnConversationId = randomUUID();
          const firstTurnRunId = randomUUID();
          const secondTurnRunId = randomUUID();
          const firstTurnInputId = randomUUID();
          const secondTurnInputId = randomUUID();
          await insertUserAndConversation(client, {
            userId,
            conversationId: multiTurnConversationId,
            title: "multi-Turn input recovery",
          });
          await insertReconciliationLegacyRun(client, {
            runId: firstTurnRunId,
            requestId: randomUUID(),
            userId,
            conversationId: multiTurnConversationId,
            assistantMessageId: randomUUID(),
          });
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations, created_at)
              VALUES ($1, $2, 'user', 'first Turn', '[]', '2026-08-24T00:01:00.000Z')
            `,
            [firstTurnInputId, multiTurnConversationId],
          );
          await insertReconciliationLegacyRun(client, {
            runId: secondTurnRunId,
            requestId: randomUUID(),
            userId,
            conversationId: multiTurnConversationId,
            conversationTurn: 2,
            predecessorRunId: firstTurnRunId,
            assistantMessageId: randomUUID(),
            createdAt: "2026-08-24T00:02:00.000Z",
          });
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations, created_at)
              VALUES ($1, $2, 'user', 'second Turn', '[]', '2026-08-24T00:03:00.000Z')
            `,
            [secondTurnInputId, multiTurnConversationId],
          );

          const completedConversationId = randomUUID();
          const completedRunId = randomUUID();
          const completedInputId = randomUUID();
          const realAssistantId = randomUUID();
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'existing real assistant')
            `,
            [completedConversationId, userId],
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
                ($1, $2, 'user', 'known completed input', '[]', '2026-08-24T00:00:01.000Z'),
                ($3, $2, 'assistant', 'real historical answer', '[]', '2026-08-24T00:01:00.000Z')
            `,
            [completedInputId, completedConversationId, realAssistantId],
          );
          await insertCompletedLegacyRun(client, {
            runId: completedRunId,
            requestId: randomUUID(),
            userId,
            conversationId: completedConversationId,
            inputMessageId: completedInputId,
          });
          await client.query(
            `
              UPDATE runs
              SET assistant_message_id = $2
              WHERE id = $1
            `,
            [completedRunId, realAssistantId],
          );
          await client.query(
            `
              UPDATE messages
              SET run_id = $3
              WHERE id = ANY($1::uuid[]) AND conversation_id = $2
            `,
            [
              [completedInputId, realAssistantId],
              completedConversationId,
              completedRunId,
            ],
          );

          const retryConversationId = randomUUID();
          const sourceRunId = randomUUID();
          const retryRunId = randomUUID();
          const retryInputId = randomUUID();
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'valid retry ownership')
            `,
            [retryConversationId, userId],
          );
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, citations, created_at)
              VALUES ($1, $2, 'user', 'retry source input', '[]', '2026-08-24T00:00:01.000Z')
            `,
            [retryInputId, retryConversationId],
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
                created_at,
                finished_at,
                conversation_turn,
                attempt_index
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                'failed',
                20,
                $5,
                $6,
                'PROVIDER_ERROR',
                'source failed',
                '2026-08-24T00:00:00.000Z',
                '2026-08-24T00:01:00.000Z',
                1,
                1
              )
            `,
            [
              sourceRunId,
              randomUUID(),
              userId,
              retryConversationId,
              retryInputId,
              randomUUID(),
            ],
          );
          await client.query("UPDATE messages SET run_id = $2 WHERE id = $1", [
            retryInputId,
            sourceRunId,
          ]);
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
                created_at,
                finished_at,
                conversation_turn,
                attempt_index,
                retry_of_run_id
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                'failed',
                20,
                $5,
                $6,
                'PROVIDER_ERROR',
                'retry failed',
                '2026-08-24T00:02:00.000Z',
                '2026-08-24T00:03:00.000Z',
                1,
                2,
                $7
              )
            `,
            [
              retryRunId,
              randomUUID(),
              userId,
              retryConversationId,
              retryInputId,
              randomUUID(),
              sourceRunId,
            ],
          );

          await client.query(migration011);

          const recoveredInputs = await client.query<{
            id: string;
            input_message_id: string;
            message_run_id: string;
          }>(
            `
              SELECT run.id, run.input_message_id, message.run_id AS message_run_id
              FROM runs run
              JOIN messages message ON message.id = run.input_message_id
              WHERE run.id = ANY($1::uuid[])
              ORDER BY run.conversation_turn
            `,
            [[firstTurnRunId, secondTurnRunId]],
          );
          expect(recoveredInputs.rows).toEqual([
            {
              id: firstTurnRunId,
              input_message_id: firstTurnInputId,
              message_run_id: firstTurnRunId,
            },
            {
              id: secondTurnRunId,
              input_message_id: secondTurnInputId,
              message_run_id: secondTurnRunId,
            },
          ]);
          const preservedAssistant = await client.query<{
            assistant_message_id: string;
            content: string;
            run_id: string;
          }>(
            `
              SELECT run.assistant_message_id, message.content, message.run_id
              FROM runs run
              JOIN messages message ON message.id = run.assistant_message_id
              WHERE run.id = $1
            `,
            [completedRunId],
          );
          expect(preservedAssistant.rows[0]).toEqual({
            assistant_message_id: realAssistantId,
            content: "real historical answer",
            run_id: completedRunId,
          });
          const retryOwnership = await client.query<{
            source_input: string;
            retry_input: string;
            message_run_id: string;
          }>(
            `
              SELECT
                source.input_message_id AS source_input,
                retry.input_message_id AS retry_input,
                message.run_id AS message_run_id
              FROM runs source
              JOIN runs retry ON retry.retry_of_run_id = source.id
              JOIN messages message ON message.id = retry.input_message_id
              WHERE source.id = $1 AND retry.id = $2
            `,
            [sourceRunId, retryRunId],
          );
          expect(retryOwnership.rows[0]).toEqual({
            source_input: retryInputId,
            retry_input: retryInputId,
            message_run_id: sourceRunId,
          });
          await client.query(
            `
              SELECT assert_run_turn_queue_integrity(id)
              FROM runs
              WHERE user_id = $1
            `,
            [userId],
          );
          await expect(client.query(assertion011)).resolves.toBeDefined();
        });
      },
      30_000,
    );

    it(
      "fails closed for zero candidates, cross-conversation messages, and wrong roles",
      async () => {
        await withLegacySchema(async ({ client, migration011 }) => {
          const userId = randomUUID();
          await client.query(
            "INSERT INTO users (id, name, available_credits) VALUES ($1, 'candidate failures', 1000)",
            [userId],
          );
          const variants: Array<{
            name: string;
            insertCandidate: (
              targetConversationId: string,
            ) => Promise<unknown>;
          }> = [
            {
              name: "zero candidates",
              insertCandidate: async () => undefined,
            },
            {
              name: "cross-conversation candidate",
              insertCandidate: async () => {
                const otherConversationId = randomUUID();
                await client.query(
                  `
                    INSERT INTO conversations (id, user_id, title)
                    VALUES ($1, $2, 'other conversation')
                  `,
                  [otherConversationId, userId],
                );
                return client.query(
                  `
                    INSERT INTO messages (conversation_id, role, content, citations, created_at)
                    VALUES ($1, 'user', 'wrong conversation', '[]', '2026-08-24T00:00:01.000Z')
                  `,
                  [otherConversationId],
                );
              },
            },
            {
              name: "wrong-role candidate",
              insertCandidate: (targetConversationId) =>
                client.query(
                  `
                    INSERT INTO messages (conversation_id, role, content, citations, created_at)
                    VALUES ($1, 'assistant', 'wrong role', '[]', '2026-08-24T00:00:01.000Z')
                  `,
                  [targetConversationId],
                ),
            },
          ];

          await client.query("BEGIN");
          try {
            for (const variant of variants) {
              await client.query("SAVEPOINT candidate_variant");
              const conversationId = randomUUID();
              await client.query(
                `
                  INSERT INTO conversations (id, user_id, title)
                  VALUES ($1, $2, $3)
                `,
                [conversationId, userId, variant.name],
              );
              await insertReconciliationLegacyRun(client, {
                runId: randomUUID(),
                requestId: randomUUID(),
                userId,
                conversationId,
                assistantMessageId: randomUUID(),
              });
              await variant.insertCandidate(conversationId);

              let migrationError: unknown = null;
              try {
                await client.query(migration011);
              } catch (error) {
                migrationError = error;
              }
              await client.query("ROLLBACK TO SAVEPOINT candidate_variant");
              expect(migrationError, variant.name).toMatchObject({ code: "23514" });
            }
          } finally {
            await client.query("ROLLBACK");
          }
        });
      },
      30_000,
    );

    it(
      "postflight rejects a rogue message linked to a Run but not declared by it",
      async () => {
        await withLegacySchema(async ({ client, migration011 }) => {
          const userId = randomUUID();
          const conversationId = randomUUID();
          const runId = randomUUID();
          const inputMessageId = randomUUID();
          const assistantMessageId = randomUUID();
          await insertUserAndConversation(client, {
            userId,
            conversationId,
            title: "rogue linked message",
          });
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
                ($1, $2, 'user', 'declared input', '[]', '2026-08-24T00:00:01.000Z'),
                ($3, $2, 'assistant', 'declared answer', '[]', '2026-08-24T00:01:00.000Z')
            `,
            [inputMessageId, conversationId, assistantMessageId],
          );
          await insertCompletedLegacyRun(client, {
            runId,
            requestId: randomUUID(),
            userId,
            conversationId,
            inputMessageId,
          });
          await client.query(
            "UPDATE runs SET assistant_message_id = $2 WHERE id = $1",
            [runId, assistantMessageId],
          );
          await client.query(
            "UPDATE messages SET run_id = $2 WHERE id = ANY($1::uuid[])",
            [[inputMessageId, assistantMessageId], runId],
          );
          await client.query("DROP INDEX messages_run_role_unique_idx");
          const rogueMessageId = randomUUID();
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
                'rogue linked answer',
                '[]',
                '2026-08-24T00:01:01.000Z'
              )
            `,
            [rogueMessageId, conversationId, runId],
          );

          await expect(client.query(migration011)).rejects.toMatchObject({
            code: "23514",
          });
          const links = await client.query<{
            assistant_message_id: string;
          }>("SELECT assistant_message_id FROM runs WHERE id = $1", [runId]);
          expect(links.rows[0]?.assistant_message_id).toBe(assistantMessageId);
        });
      },
      30_000,
    );

    it(
      "fails closed for non-terminal and retry-shaped legacy rows",
      async () => {
        await withLegacySchema(async ({ client, migration011 }) => {
          const userId = randomUUID();
          const queuedConversationId = randomUUID();
          const queuedRunId = randomUUID();
          await insertUserAndConversation(client, {
            userId,
            conversationId: queuedConversationId,
            title: "non-terminal missing links",
          });
          await client.query(
            `
              INSERT INTO runs (
                id,
                request_id,
                user_id,
                conversation_id,
                status,
                reservation_credits,
                created_at,
                conversation_turn,
                attempt_index
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                'queued',
                20,
                '2026-08-24T00:00:00.000Z',
                1,
                1
              )
            `,
            [queuedRunId, randomUUID(), userId, queuedConversationId],
          );
          await client.query(
            `
              INSERT INTO messages (conversation_id, role, content, citations, created_at)
              VALUES ($1, 'user', 'queued input', '[]', '2026-08-24T00:00:01.000Z')
            `,
            [queuedConversationId],
          );

          await expect(client.query(migration011)).rejects.toMatchObject({
            code: "23514",
          });
          const queuedAfterFailure = await client.query<{
            input_message_id: string | null;
          }>("SELECT input_message_id FROM runs WHERE id = $1", [queuedRunId]);
          expect(queuedAfterFailure.rows[0]?.input_message_id).toBeNull();

          await client.query("DELETE FROM runs WHERE id = $1", [queuedRunId]);
          await client.query("DELETE FROM messages WHERE conversation_id = $1", [
            queuedConversationId,
          ]);

          const retryConversationId = randomUUID();
          const sourceRunId = randomUUID();
          const retryRunId = randomUUID();
          const sourceInputId = randomUUID();
          await client.query(
            `
              INSERT INTO conversations (id, user_id, title)
              VALUES ($1, $2, 'retry-shaped missing links')
            `,
            [retryConversationId, userId],
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
              VALUES ($1, $2, 'user', 'source input', '[]', '2026-08-24T00:00:01.000Z')
            `,
            [sourceInputId, retryConversationId],
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
                created_at,
                finished_at,
                conversation_turn,
                attempt_index
              )
              VALUES (
                $1,
                $2,
                $3,
                $4,
                'failed',
                20,
                $5,
                $6,
                'PROVIDER_ERROR',
                'legacy failure',
                '2026-08-24T00:00:00.000Z',
                '2026-08-24T00:01:00.000Z',
                1,
                1
              )
            `,
            [
              sourceRunId,
              randomUUID(),
              userId,
              retryConversationId,
              sourceInputId,
              randomUUID(),
            ],
          );
          await client.query("UPDATE messages SET run_id = $2 WHERE id = $1", [
            sourceInputId,
            sourceRunId,
          ]);
          await client.query(
            "ALTER TABLE runs DISABLE TRIGGER runs_turn_queue_integrity_insert_trigger",
          );
          try {
            await client.query(
              `
                INSERT INTO runs (
                  id,
                  request_id,
                  user_id,
                  conversation_id,
                  status,
                  reservation_credits,
                  failure_code,
                  failure_message,
                  created_at,
                  finished_at,
                  conversation_turn,
                  attempt_index,
                  retry_of_run_id
                )
                VALUES (
                  $1,
                  $2,
                  $3,
                  $4,
                  'failed',
                  20,
                  'PROVIDER_ERROR',
                  'legacy retry failure',
                  '2026-08-24T00:02:00.000Z',
                  '2026-08-24T00:03:00.000Z',
                  1,
                  2,
                  $5
                )
              `,
              [
                retryRunId,
                randomUUID(),
                userId,
                retryConversationId,
                sourceRunId,
              ],
            );
          } finally {
            await client.query(
              "ALTER TABLE runs ENABLE TRIGGER runs_turn_queue_integrity_insert_trigger",
            );
          }
          await client.query(
            `
              INSERT INTO messages (conversation_id, role, content, citations, created_at)
              VALUES ($1, 'user', 'wrong retry candidate', '[]', '2026-08-24T00:02:01.000Z')
            `,
            [retryConversationId],
          );

          await expect(client.query(migration011)).rejects.toMatchObject({
            code: "23514",
          });
        });
      },
      30_000,
    );
  },
);
