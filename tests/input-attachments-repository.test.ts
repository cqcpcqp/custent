import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createInputAttachment,
  getStagedInputAttachment,
} from "@/lib/input-attachments";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  attachment: "22222222-2222-4222-8222-222222222222",
};
const createdAt = new Date("2026-08-25T08:00:00.000Z");
const requestedExpiresAt = new Date("2099-08-26T08:00:00.000Z");
const persistedExpiresAt = new Date("2099-08-26T08:00:00.123Z");
const stored = {
  id: ids.attachment,
  kind: "file" as const,
  originalName: "buyers.txt",
  mimeType: "text/plain" as const,
  sizeBytes: 6,
  sha256: "f".repeat(64),
  storagePath: ids.attachment,
};

function stagedRow() {
  return {
    id: ids.attachment,
    user_id: ids.user,
    kind: stored.kind,
    original_name: stored.originalName,
    mime_type: stored.mimeType,
    size_bytes: stored.sizeBytes,
    sha256: stored.sha256,
    storage_path: stored.storagePath,
    created_at: createdAt,
    attached_at: null,
    expires_at: persistedExpiresAt,
  };
}

function expectedResponse() {
  return {
    attachment: {
      id: ids.attachment,
      kind: "file" as const,
      name: stored.originalName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      downloadUrl: `/api/input-attachments/${ids.attachment}/content`,
      createdAt: createdAt.toISOString(),
    },
    expiresAt: persistedExpiresAt.toISOString(),
  };
}

describe("staged input attachment repository", () => {
  it("returns the persisted expiration from INSERT RETURNING", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [stagedRow()],
    });
    const database = { query } as unknown as Pool;

    await expect(
      createInputAttachment(
        { userId: ids.user, stored, expiresAt: requestedExpiresAt },
        database,
      ),
    ).resolves.toEqual(expectedResponse());

    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("RETURNING");
    expect(sql).toContain("expires_at");
    expect(parameters).toEqual([
      ids.user,
      ids.attachment,
      stored.kind,
      stored.originalName,
      stored.mimeType,
      stored.sizeBytes,
      stored.sha256,
      stored.storagePath,
      requestedExpiresAt,
    ]);
    expect(persistedExpiresAt.toISOString()).not.toBe(
      requestedExpiresAt.toISOString(),
    );
  });

  it("reads only a live unbound attachment owned by the current user", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [stagedRow()],
    });
    const database = { query } as unknown as Pool;

    await expect(
      getStagedInputAttachment(ids.user, ids.attachment, database),
    ).resolves.toEqual(expectedResponse());

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    const normalizedSql = sql.replaceAll(/\s+/gu, " ").trim();
    expect(normalizedSql).toContain("attachment.id = $1");
    expect(normalizedSql).toContain("attachment.user_id = $2");
    expect(normalizedSql).toContain("attachment.attached_at IS NULL");
    expect(normalizedSql).toContain("attachment.expires_at > now()");
    expect(parameters).toEqual([ids.attachment, ids.user]);
  });

  it("returns null when no live owned staged attachment matches", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const database = { query } as unknown as Pool;

    await expect(
      getStagedInputAttachment(ids.user, ids.attachment, database),
    ).resolves.toBeNull();
  });
});
