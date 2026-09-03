import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type PoolClient, Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  inputAttachmentFormatSpecifications,
  INPUT_ATTACHMENT_MIME_TYPES,
} from "@/lib/input-attachment-formats";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationsDirectory = path.resolve(process.cwd(), "db/migrations");
const migrationFilenamesBefore017 = [
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
] as const;

type MigrationContext = {
  assertion017: string;
  client: PoolClient;
  migration017: string;
};

async function withSchemaBefore017(
  test: (context: MigrationContext) => Promise<void>,
): Promise<void> {
  if (databaseUrl === undefined) {
    throw new TypeError("TEST_DATABASE_URL is required");
  }

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await database.connect();
  const schemaName = `migration_017_${randomUUID().replaceAll("-", "")}`;

  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    for (const filename of migrationFilenamesBefore017) {
      await client.query(
        await readFile(path.join(migrationsDirectory, filename), "utf8"),
      );
    }
    await test({
      assertion017: await readFile(
        path.resolve(
          process.cwd(),
          "db/assertions/017_input_attachment_formats.sql",
        ),
        "utf8",
      ),
      client,
      migration017: await readFile(
        path.join(
          migrationsDirectory,
          "017_input_attachment_formats.sql",
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

describe.runIf(databaseUrl !== undefined)(
  "017 input attachment formats migration",
  () => {
    it("preserves legacy rows and enforces every expanded MIME/kind pair", async () => {
      await withSchemaBefore017(
        async ({ assertion017, client, migration017 }) => {
          const legacyId = randomUUID();
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
                expires_at
              )
              VALUES (
                $1,
                '11111111-1111-4111-8111-111111111111',
                'file',
                'legacy.txt',
                'text/plain',
                1,
                repeat('a', 64),
                $1::uuid::text,
                now() + interval '1 hour'
              )
            `,
            [legacyId],
          );

          await client.query(migration017);
          await expect(
            client.query<{
              kind: string;
              mime_type: string;
            }>(
              "SELECT kind, mime_type FROM input_attachments WHERE id = $1",
              [legacyId],
            ),
          ).resolves.toMatchObject({
            rows: [{ kind: "file", mime_type: "text/plain" }],
          });

          const migrationMimeTypes = Array.from(
            new Set(
              Array.from(
                migration017.matchAll(/'([^']+\/[^']+)'/gu),
                (match) => match[1],
              ),
            ),
          ).sort();
          expect(migrationMimeTypes).toEqual(
            [...INPUT_ATTACHMENT_MIME_TYPES].sort(),
          );

          for (const mimeType of INPUT_ATTACHMENT_MIME_TYPES) {
            const kind = inputAttachmentFormatSpecifications[mimeType].kind;
            const id = randomUUID();
            await expect(
              client.query(
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
                    expires_at
                  )
                  VALUES (
                    $1,
                    '11111111-1111-4111-8111-111111111111',
                    $2,
                    'expanded.fixture',
                    $3,
                    1,
                    repeat('b', 64),
                    $1::uuid::text,
                    now() + interval '1 hour'
                  )
                `,
                [id, kind, mimeType],
              ),
            ).resolves.toMatchObject({ rowCount: 1 });

            await expect(
              client.query(
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
                    expires_at
                  )
                  VALUES (
                    $1,
                    '11111111-1111-4111-8111-111111111111',
                    $2,
                    'opposite-kind.fixture',
                    $3,
                    1,
                    repeat('c', 64),
                    $1::uuid::text,
                    now() + interval '1 hour'
                  )
                `,
                [
                  randomUUID(),
                  kind === "file" ? "image" : "file",
                  mimeType,
                ],
              ),
            ).rejects.toMatchObject({ code: "23514" });
          }

          await expect(
            client.query(
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
                  expires_at
                )
                VALUES (
                  $1,
                  '11111111-1111-4111-8111-111111111111',
                  'image',
                  'unknown.svg',
                  'image/svg+xml',
                  1,
                  repeat('d', 64),
                  $1::uuid::text,
                  now() + interval '1 hour'
                )
              `,
              [randomUUID()],
            ),
          ).rejects.toMatchObject({ code: "23514" });

          await expect(client.query(assertion017)).resolves.toBeDefined();
          await expect(client.query(assertion017)).resolves.toBeDefined();
        },
      );
    });
  },
);
