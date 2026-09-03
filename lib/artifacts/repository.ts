import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Pool, PoolClient } from "pg";

import { ArtifactSummarySchema, type ArtifactSummary } from "@/lib/contracts";
import { getPool, withTransaction } from "@/lib/db/pool";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";

import { renderGenericCsv, renderResearchCsv } from "./csv";
import {
  GenericCsvArtifactRequestSchema,
  GenericPdfArtifactRequestSchema,
} from "./generic";
import {
  defaultResearchArtifactName,
  requestedArtifactName,
} from "./naming";
import { renderGenericPdf, renderResearchPdf } from "./pdf";
import type {
  ArtifactRecord,
  CreateArtifactInput,
  CreateGenericCsvArtifactInput,
  CreateGenericPdfArtifactInput,
  CreateRunArtifactInput,
} from "./types";

type ArtifactRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id: string | null;
  run_id: string;
  research_snapshot_id: string | null;
  name: string;
  mime_type: "text/csv" | "application/pdf";
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: Date;
};

type ArtifactRunRow = {
  id: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
      | "cancelled"
      | "reconciliation_required";
  lease_owned: boolean;
  finalized: boolean;
};

function mapArtifactSummary(row: ArtifactRow): ArtifactSummary {
  return ArtifactSummarySchema.parse({
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    downloadUrl: `/api/artifacts/${row.id}/download`,
    createdAt: row.created_at.toISOString(),
  });
}

function mapArtifactRecord(row: ArtifactRow): ArtifactRecord {
  return {
    ...mapArtifactSummary(row),
    userId: row.user_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    runId: row.run_id,
    researchSnapshotId: row.research_snapshot_id,
    sha256: row.sha256,
    storagePath: row.storage_path,
  };
}

type PersistArtifactInput = CreateRunArtifactInput & {
  researchSnapshotId: string | null;
};

async function persistArtifact(
  input: PersistArtifactInput,
  payload: Buffer,
  name: string,
  mimeType: "text/csv" | "application/pdf",
  extension: "csv" | "pdf",
  database: Pool,
): Promise<ArtifactSummary> {
  if (payload.byteLength > 2_147_483_647) {
    throw new RangeError("Artifact exceeds the PostgreSQL integer size limit");
  }

  const artifactId = randomUUID();
  const rootDirectory = path.resolve(
    input.storageDirectory ?? getEnv().ARTIFACT_DIR,
  );
  const userDirectory = path.join(rootDirectory, input.userId);
  const storagePath = path.join(
    /* turbopackIgnore: true */ userDirectory,
    `${artifactId}.${extension}`,
  );
  const temporaryPath = `${storagePath}.tmp`;
  const sha256 = createHash("sha256").update(payload).digest("hex");

  await mkdir(userDirectory, { recursive: true });
  await writeFile(temporaryPath, payload, { flag: "wx" });
  await rename(temporaryPath, storagePath);

  try {
    const result = await withTransaction(async (client) => {
      const runResult = await client.query<ArtifactRunRow>(
        `
          WITH locked_run AS MATERIALIZED (
            SELECT
              run.id,
              run.status,
              run.lease_owner,
              run.lease_token,
              run.lease_expires_at,
              EXISTS (
                SELECT 1
                FROM messages assistant_message
                WHERE
                  assistant_message.id = run.assistant_message_id
                  AND assistant_message.run_id = run.id
                  AND assistant_message.conversation_id = run.conversation_id
                  AND assistant_message.role = 'assistant'
              ) AS finalized
            FROM runs run
            LEFT JOIN research_snapshots snapshot ON snapshot.id = $4::uuid
            LEFT JOIN runs snapshot_run ON snapshot_run.id = snapshot.run_id
            WHERE
              run.id = $3
              AND run.user_id = $1
              AND run.conversation_id = $2
              AND run.cancel_requested_at IS NULL
              AND (
                $4::uuid IS NULL
                OR (
                  snapshot.user_id = $1
                  AND snapshot.conversation_id = $2
                  AND (
                    snapshot.run_id = run.id
                    OR snapshot_run.status = 'completed'
                  )
                )
              )
            FOR UPDATE OF run
          )
          SELECT
            locked_run.id,
            locked_run.status,
            (
              locked_run.lease_owner = $5
              AND locked_run.lease_token = $6::bigint
              AND locked_run.lease_expires_at > clock_timestamp()
            ) IS TRUE AS lease_owned,
            locked_run.finalized
          FROM locked_run
        `,
        [
          input.userId,
          input.conversationId,
          input.runId,
          input.researchSnapshotId,
          input.leaseOwner,
          input.leaseToken,
        ],
      );
      if (runResult.rowCount !== 1) {
        throw new AppError(
          "NOT_FOUND",
          "Run or research snapshot was not found",
          404,
        );
      }

      const run = runResult.rows[0];
      if (run.status !== "running") {
        if (run.status !== "queued") {
          throw new AppError(
            "RUN_ALREADY_EXISTS",
            "Cannot add an artifact after the run was finalized",
            409,
          );
        }
        throw new AppError(
          "INVALID_REQUEST",
          "Artifacts can only be added while a run is active",
          409,
        );
      }
      if (!run.lease_owned) {
        throw new AppError(
          "NOT_FOUND",
          "Run or research snapshot was not found",
          404,
        );
      }
      if (run.finalized) {
        throw new AppError(
          "RUN_ALREADY_EXISTS",
          "Cannot add an artifact after the run was finalized",
          409,
        );
      }
      if (input.messageId !== null) {
        const message = await client.query<{ id: string }>(
          `
            SELECT id
            FROM messages
            WHERE id = $1 AND conversation_id = $2
          `,
          [input.messageId, input.conversationId],
        );
        if (message.rowCount !== 1) {
          throw new AppError("NOT_FOUND", "Message was not found", 404);
        }
      }

      return client.query<ArtifactRow>(
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING
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
        `,
        [
          artifactId,
          input.userId,
          input.conversationId,
          input.messageId,
          input.runId,
          input.researchSnapshotId,
          name,
          mimeType,
          payload.byteLength,
          sha256,
          storagePath,
        ],
      );
    }, database);

    if (result.rowCount !== 1) {
      throw new Error("Artifact insert did not return exactly one row");
    }
    return mapArtifactSummary(result.rows[0]);
  } catch (error) {
    await unlink(storagePath);
    throw error;
  }
}

export async function createCsvArtifact(
  input: CreateArtifactInput,
  database: Pool = getPool(),
): Promise<ArtifactSummary> {
  const name =
    input.name === undefined
      ? defaultResearchArtifactName(input.snapshot.title, input.snapshot.id, "csv")
      : requestedArtifactName(input.name, "csv");
  return persistArtifact(
    { ...input, researchSnapshotId: input.snapshot.id },
    renderResearchCsv(input.snapshot),
    name,
    "text/csv",
    "csv",
    database,
  );
}

export async function createPdfArtifact(
  input: CreateArtifactInput & { fontPath?: string },
  database: Pool = getPool(),
): Promise<ArtifactSummary> {
  const name =
    input.name === undefined
      ? defaultResearchArtifactName(input.snapshot.title, input.snapshot.id, "pdf")
      : requestedArtifactName(input.name, "pdf");
  const fontPath = input.fontPath ?? getEnv().PDF_FONT_PATH;
  return persistArtifact(
    { ...input, researchSnapshotId: input.snapshot.id },
    await renderResearchPdf(
      input.snapshot,
      fontPath === undefined ? {} : { fontPath },
    ),
    name,
    "application/pdf",
    "pdf",
    database,
  );
}

export async function createGenericCsvArtifact(
  input: CreateGenericCsvArtifactInput,
  database: Pool = getPool(),
): Promise<ArtifactSummary> {
  const request = GenericCsvArtifactRequestSchema.parse(input.request);
  return persistArtifact(
    { ...input, researchSnapshotId: null },
    renderGenericCsv({ columns: request.columns, rows: request.rows }),
    requestedArtifactName(request.fileName, "csv"),
    "text/csv",
    "csv",
    database,
  );
}

export async function createGenericPdfArtifact(
  input: CreateGenericPdfArtifactInput,
  database: Pool = getPool(),
): Promise<ArtifactSummary> {
  const request = GenericPdfArtifactRequestSchema.parse(input.request);
  const fontPath = input.fontPath ?? getEnv().PDF_FONT_PATH;
  return persistArtifact(
    { ...input, researchSnapshotId: null },
    await renderGenericPdf(
      { title: request.title, sections: request.sections },
      fontPath === undefined ? {} : { fontPath },
    ),
    requestedArtifactName(request.fileName, "pdf"),
    "application/pdf",
    "pdf",
    database,
  );
}

export async function listMessageArtifacts(
  userId: string,
  messageId: string,
  database: Pool = getPool(),
): Promise<ArtifactSummary[]> {
  const result = await database.query<ArtifactRow>(
    `
      SELECT
        artifact.id,
        artifact.user_id,
        artifact.conversation_id,
        artifact.message_id,
        artifact.run_id,
        artifact.research_snapshot_id,
        artifact.name,
        artifact.mime_type,
        artifact.size_bytes,
        artifact.sha256,
        artifact.storage_path,
        artifact.created_at
      FROM artifacts artifact
      JOIN messages message ON message.id = artifact.message_id
      JOIN conversations conversation ON conversation.id = message.conversation_id
      WHERE
        artifact.message_id = $1
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
      ORDER BY artifact.created_at, artifact.id
    `,
    [messageId, userId],
  );
  return result.rows.map(mapArtifactSummary);
}

export async function getArtifact(
  userId: string,
  artifactId: string,
  database: Pool = getPool(),
): Promise<ArtifactRecord | null> {
  const result = await database.query<ArtifactRow>(
    `
      SELECT
        artifact.id,
        artifact.user_id,
        artifact.conversation_id,
        artifact.message_id,
        artifact.run_id,
        artifact.research_snapshot_id,
        artifact.name,
        artifact.mime_type,
        artifact.size_bytes,
        artifact.sha256,
        artifact.storage_path,
        artifact.created_at
      FROM artifacts artifact
      JOIN conversations conversation ON conversation.id = artifact.conversation_id
      WHERE
        artifact.id = $1
        AND artifact.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
    `,
    [artifactId, userId],
  );
  return result.rowCount === 0 ? null : mapArtifactRecord(result.rows[0]);
}

export async function attachArtifactsToMessage(
  input: { userId: string; runId: string; messageId: string },
  database: Pool = getPool(),
): Promise<ArtifactSummary[]> {
  return withTransaction(
    (client) => attachRunArtifactsInTransaction(input, client),
    database,
  );
}

export async function attachRunArtifactsInTransaction(
  input: { userId: string; runId: string; messageId: string },
  client: PoolClient,
): Promise<ArtifactSummary[]> {
  const ownership = await client.query<{ id: string }>(
    `
      SELECT run.id
      FROM runs run
      JOIN messages message ON message.id = $2
      WHERE
        run.id = $1
        AND run.user_id = $3
        AND message.conversation_id = run.conversation_id
      FOR UPDATE OF run
    `,
    [input.runId, input.messageId, input.userId],
  );
  if (ownership.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Run or message was not found", 404);
  }

  const conflicting = await client.query<{ id: string }>(
    `
      SELECT id
      FROM artifacts
      WHERE run_id = $1 AND message_id IS NOT NULL AND message_id <> $2
      LIMIT 1
      FOR UPDATE
    `,
    [input.runId, input.messageId],
  );
  if (conflicting.rowCount !== 0) {
    throw new AppError(
      "INVALID_REQUEST",
      "An artifact from this run is already attached to another message",
      409,
    );
  }

  const result = await client.query<ArtifactRow>(
    `
      UPDATE artifacts
      SET message_id = $2
      WHERE run_id = $1 AND user_id = $3
      RETURNING
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
    `,
    [input.runId, input.messageId, input.userId],
  );
  return result.rows
    .sort((left, right) => {
      const timestampOrder = left.created_at.getTime() - right.created_at.getTime();
      return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder;
    })
    .map(mapArtifactSummary);
}
