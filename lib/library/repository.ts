import { z } from "zod";

import {
  LibraryArtifactItemSchema,
  LibraryResearchDetailSchema,
  LibraryResearchItemSchema,
  ListLibraryArtifactsResponseSchema,
  ListLibraryResearchResponseSchema,
  type LibraryArtifactItem,
  type LibraryResearchDetail,
  type LibraryResearchItem,
  type ListLibraryArtifactsResponse,
  type ListLibraryResearchResponse,
} from "@/lib/contracts";
import { getPool } from "@/lib/db/pool";
import type { Queryable } from "@/lib/db/types";
import { AppError } from "@/lib/errors";
import { getResearchSnapshot } from "@/lib/research";

type LibraryCursorKind = "research" | "artifacts";

type LibraryCursor = {
  createdAt: string;
  id: string;
};

type LibraryPageInput = {
  userId: string;
  cursor: string | null;
  limit: number;
};

type LibraryResearchRow = {
  id: string;
  title: string;
  query_summary: string;
  company_count: number;
  created_at: Date;
  cursor_created_at: string;
  conversation_id: string;
  conversation_title: string;
  conversation_archived_at: Date | null;
  run_id: string;
  assistant_message_id: string;
};

type LibraryArtifactRow = {
  id: string;
  name: string;
  mime_type: "text/csv" | "application/pdf";
  size_bytes: number;
  created_at: Date;
  cursor_created_at: string;
  conversation_id: string;
  conversation_title: string;
  conversation_archived_at: Date | null;
  run_id: string;
  assistant_message_id: string;
  research_snapshot_id: string | null;
};

const LibraryPageInputSchema = z
  .object({
    userId: z.string().uuid(),
    cursor: z.string().min(1).max(1_024).nullable(),
    limit: z.number().int().min(1).max(50).safe(),
  })
  .strict();

const EncodedLibraryCursorSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9_-]+$/u);

const LibraryCursorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["research", "artifacts"]),
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

function invalidCursor(): AppError {
  return new AppError("INVALID_REQUEST", "资料库分页游标无效。", 400);
}

function decodeLibraryCursor(
  encodedValue: string | null,
  expectedKind: LibraryCursorKind,
): LibraryCursor | null {
  if (encodedValue === null) {
    return null;
  }

  try {
    const encoded = EncodedLibraryCursorSchema.parse(encodedValue);
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw invalidCursor();
    }
    const parsed = LibraryCursorSchema.parse(
      JSON.parse(decoded.toString("utf8")),
    );
    if (parsed.kind !== expectedKind) {
      throw invalidCursor();
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw invalidCursor();
  }
}

function encodeLibraryCursor(
  kind: LibraryCursorKind,
  row: Pick<LibraryResearchRow | LibraryArtifactRow, "cursor_created_at" | "id">,
): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      kind,
      createdAt: row.cursor_created_at,
      id: row.id,
    }),
    "utf8",
  ).toString("base64url");
}

function mapResearchItem(row: LibraryResearchRow): LibraryResearchItem {
  return LibraryResearchItemSchema.parse({
    id: row.id,
    title: row.title,
    querySummary: row.query_summary,
    companyCount: row.company_count,
    createdAt: row.created_at.toISOString(),
    conversation: {
      id: row.conversation_id,
      title: row.conversation_title,
      archivedAt: row.conversation_archived_at?.toISOString() ?? null,
    },
    runId: row.run_id,
    assistantMessageId: row.assistant_message_id,
  });
}

function mapArtifactItem(row: LibraryArtifactRow): LibraryArtifactItem {
  return LibraryArtifactItemSchema.parse({
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    downloadUrl: `/api/artifacts/${row.id}/download`,
    createdAt: row.created_at.toISOString(),
    conversation: {
      id: row.conversation_id,
      title: row.conversation_title,
      archivedAt: row.conversation_archived_at?.toISOString() ?? null,
    },
    runId: row.run_id,
    assistantMessageId: row.assistant_message_id,
    researchSnapshotId: row.research_snapshot_id,
  });
}

export async function listLibraryResearchPage(
  rawInput: LibraryPageInput,
  database: Queryable = getPool(),
): Promise<ListLibraryResearchResponse> {
  const input = LibraryPageInputSchema.parse(rawInput);
  const cursor = decodeLibraryCursor(input.cursor, "research");
  const result = await database.query<LibraryResearchRow>(
    `
      SELECT
        snapshot.id,
        snapshot.title,
        snapshot.query_summary,
        (
          SELECT count(*)::integer
          FROM research_companies company
          WHERE company.snapshot_id = snapshot.id
        ) AS company_count,
        snapshot.created_at,
        to_char(
          snapshot.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_created_at,
        conversation.id AS conversation_id,
        conversation.title AS conversation_title,
        conversation.archived_at AS conversation_archived_at,
        run.id AS run_id,
        assistant_message.id AS assistant_message_id
      FROM research_snapshots snapshot
      JOIN conversations conversation
        ON conversation.id = snapshot.conversation_id
        AND conversation.user_id = snapshot.user_id
      JOIN runs run
        ON run.id = snapshot.run_id
        AND run.user_id = snapshot.user_id
        AND run.conversation_id = snapshot.conversation_id
      JOIN messages assistant_message
        ON assistant_message.id = run.assistant_message_id
        AND assistant_message.run_id = run.id
        AND assistant_message.conversation_id = run.conversation_id
        AND assistant_message.role = 'assistant'
      WHERE
        snapshot.user_id = $1
        AND conversation.deleted_at IS NULL
        AND run.status = 'completed'
        AND (
          $2::timestamptz IS NULL
          OR snapshot.created_at < $2::timestamptz
          OR (
            snapshot.created_at = $2::timestamptz
            AND snapshot.id < $3::uuid
          )
        )
      ORDER BY snapshot.created_at DESC, snapshot.id DESC
      LIMIT $4
    `,
    [
      input.userId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      input.limit + 1,
    ],
  );
  const hasNextPage = result.rows.length > input.limit;
  const pageRows = hasNextPage ? result.rows.slice(0, input.limit) : result.rows;
  const nextCursor = hasNextPage
    ? encodeLibraryCursor("research", pageRows[pageRows.length - 1])
    : null;
  return ListLibraryResearchResponseSchema.parse({
    items: pageRows.map(mapResearchItem),
    nextCursor,
  });
}

export async function listLibraryArtifactPage(
  rawInput: LibraryPageInput,
  database: Queryable = getPool(),
): Promise<ListLibraryArtifactsResponse> {
  const input = LibraryPageInputSchema.parse(rawInput);
  const cursor = decodeLibraryCursor(input.cursor, "artifacts");
  const result = await database.query<LibraryArtifactRow>(
    `
      SELECT
        artifact.id,
        artifact.name,
        artifact.mime_type,
        artifact.size_bytes,
        artifact.created_at,
        to_char(
          artifact.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_created_at,
        conversation.id AS conversation_id,
        conversation.title AS conversation_title,
        conversation.archived_at AS conversation_archived_at,
        run.id AS run_id,
        assistant_message.id AS assistant_message_id,
        artifact.research_snapshot_id
      FROM artifacts artifact
      JOIN conversations conversation
        ON conversation.id = artifact.conversation_id
        AND conversation.user_id = artifact.user_id
      JOIN runs run
        ON run.id = artifact.run_id
        AND run.user_id = artifact.user_id
        AND run.conversation_id = artifact.conversation_id
      JOIN messages assistant_message
        ON assistant_message.id = artifact.message_id
        AND assistant_message.id = run.assistant_message_id
        AND assistant_message.run_id = run.id
        AND assistant_message.conversation_id = run.conversation_id
        AND assistant_message.role = 'assistant'
      LEFT JOIN research_snapshots artifact_snapshot
        ON artifact_snapshot.id = artifact.research_snapshot_id
        AND artifact_snapshot.user_id = artifact.user_id
        AND artifact_snapshot.conversation_id = artifact.conversation_id
      WHERE
        artifact.user_id = $1
        AND conversation.deleted_at IS NULL
        AND run.status = 'completed'
        AND (
          artifact.research_snapshot_id IS NULL
          OR artifact_snapshot.id IS NOT NULL
        )
        AND (
          $2::timestamptz IS NULL
          OR artifact.created_at < $2::timestamptz
          OR (
            artifact.created_at = $2::timestamptz
            AND artifact.id < $3::uuid
          )
        )
      ORDER BY artifact.created_at DESC, artifact.id DESC
      LIMIT $4
    `,
    [input.userId, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1],
  );
  const hasNextPage = result.rows.length > input.limit;
  const pageRows = hasNextPage ? result.rows.slice(0, input.limit) : result.rows;
  const nextCursor = hasNextPage
    ? encodeLibraryCursor("artifacts", pageRows[pageRows.length - 1])
    : null;
  return ListLibraryArtifactsResponseSchema.parse({
    items: pageRows.map(mapArtifactItem),
    nextCursor,
  });
}

export async function getLibraryResearchDetail(
  userId: string,
  snapshotId: string,
  database: Queryable = getPool(),
): Promise<LibraryResearchDetail | null> {
  const identity = z
    .object({ userId: z.string().uuid(), snapshotId: z.string().uuid() })
    .strict()
    .parse({ userId, snapshotId });
  const source = await database.query<LibraryResearchRow>(
    `
      SELECT
        snapshot.id,
        snapshot.title,
        snapshot.query_summary,
        (
          SELECT count(*)::integer
          FROM research_companies company
          WHERE company.snapshot_id = snapshot.id
        ) AS company_count,
        snapshot.created_at,
        to_char(
          snapshot.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_created_at,
        conversation.id AS conversation_id,
        conversation.title AS conversation_title,
        conversation.archived_at AS conversation_archived_at,
        run.id AS run_id,
        assistant_message.id AS assistant_message_id
      FROM research_snapshots snapshot
      JOIN conversations conversation
        ON conversation.id = snapshot.conversation_id
        AND conversation.user_id = snapshot.user_id
      JOIN runs run
        ON run.id = snapshot.run_id
        AND run.user_id = snapshot.user_id
        AND run.conversation_id = snapshot.conversation_id
      JOIN messages assistant_message
        ON assistant_message.id = run.assistant_message_id
        AND assistant_message.run_id = run.id
        AND assistant_message.conversation_id = run.conversation_id
        AND assistant_message.role = 'assistant'
      WHERE
        snapshot.id = $1
        AND snapshot.user_id = $2
        AND conversation.deleted_at IS NULL
        AND run.status = 'completed'
    `,
    [identity.snapshotId, identity.userId],
  );
  if (source.rowCount === 0) {
    return null;
  }
  if (source.rowCount !== 1) {
    throw new TypeError("Library research identity query returned multiple rows");
  }

  const snapshot = await getResearchSnapshot(
    identity.userId,
    identity.snapshotId,
    database,
  );
  if (snapshot === null) {
    throw new TypeError("Library research snapshot disappeared while materializing");
  }
  const row = source.rows[0];
  return LibraryResearchDetailSchema.parse({
    ...mapResearchItem(row),
    limitations: snapshot.limitations,
    companies: snapshot.companies,
  });
}
