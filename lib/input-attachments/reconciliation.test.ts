import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileInputAttachmentStorage } from "./reconciliation";

type QueryRow = { storage_path: string };

function queryResult(rows: QueryRow[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function temporaryFileName(): string {
  return `.${randomUUID()}.${randomUUID()}.tmp`;
}

async function expectPresent(filePath: string): Promise<void> {
  await expect(access(filePath)).resolves.toBeUndefined();
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("input attachment storage reconciliation", () => {
  let storageDirectory: string;

  beforeEach(async () => {
    storageDirectory = await mkdtemp(
      path.join(os.tmpdir(), "custent-attachment-reconciliation-"),
    );
  });

  afterEach(async () => {
    await rm(storageDirectory, { recursive: true, force: true });
  });

  it("deletes only aged unreferenced UUID files and stale project temp files", async () => {
    const orphanName = randomUUID();
    const knownName = randomUUID();
    const recentOrphanName = randomUUID();
    const staleTemporaryName = temporaryFileName();
    const recentTemporaryName = temporaryFileName();
    const unknownName = "notes.txt";
    const uppercaseUuidName = randomUUID().toUpperCase();
    const orphanPath = path.join(storageDirectory, orphanName);
    const knownPath = path.join(storageDirectory, knownName);
    const recentOrphanPath = path.join(storageDirectory, recentOrphanName);
    const staleTemporaryPath = path.join(
      storageDirectory,
      staleTemporaryName,
    );
    const recentTemporaryPath = path.join(
      storageDirectory,
      recentTemporaryName,
    );
    const unknownPath = path.join(storageDirectory, unknownName);
    const uppercaseUuidPath = path.join(storageDirectory, uppercaseUuidName);
    await Promise.all([
      writeFile(orphanPath, "orphan"),
      writeFile(knownPath, "known"),
      writeFile(recentOrphanPath, "recent orphan"),
      writeFile(staleTemporaryPath, "stale temporary"),
      writeFile(recentTemporaryPath, "recent temporary"),
      writeFile(unknownPath, "unknown"),
      writeFile(uppercaseUuidPath, "uppercase"),
    ]);
    const agedAt = new Date(Date.now() - 10_000);
    await Promise.all(
      [
        orphanPath,
        knownPath,
        staleTemporaryPath,
        unknownPath,
        uppercaseUuidPath,
      ].map((filePath) => utimes(filePath, agedAt, agedAt)),
    );
    const query = vi.fn(
      async (sql: string, parameters?: unknown[]) => {
        expect(sql).toContain("FROM input_attachments attachment");
        const storagePaths = parameters?.[0];
        if (!Array.isArray(storagePaths)) {
          throw new TypeError("storage path query parameter must be an array");
        }
        return queryResult(
          storagePaths.includes(knownName)
            ? [{ storage_path: knownName }]
            : [],
        );
      },
    );

    await expect(
      reconcileInputAttachmentStorage(
        {
          storageDirectory,
          batchSize: 100,
          orphanMinAgeMs: 1_000,
          temporaryFileStaleAgeMs: 1_000,
        },
        { query } as unknown as Pool,
      ),
    ).resolves.toEqual({
      orphanFilesDeleted: 1,
      staleTemporaryFilesDeleted: 1,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.arrayContaining([orphanName, knownName]),
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([[orphanName]]);
    await expectMissing(orphanPath);
    await expectMissing(staleTemporaryPath);
    await Promise.all([
      expectPresent(knownPath),
      expectPresent(recentOrphanPath),
      expectPresent(recentTemporaryPath),
      expectPresent(unknownPath),
      expectPresent(uppercaseUuidPath),
    ]);
  });

  it("ignores directories and symbolic links even when their names look valid", async () => {
    const directoryPath = path.join(storageDirectory, randomUUID());
    const symlinkPath = path.join(storageDirectory, randomUUID());
    const targetPath = path.join(storageDirectory, "target.txt");
    await mkdir(directoryPath);
    await writeFile(targetPath, "target");
    await symlink(targetPath, symlinkPath);
    const agedAt = new Date(Date.now() - 10_000);
    await Promise.all([
      utimes(directoryPath, agedAt, agedAt),
      utimes(targetPath, agedAt, agedAt),
    ]);
    const query = vi.fn(async () => queryResult([]));

    await expect(
      reconcileInputAttachmentStorage(
        {
          storageDirectory,
          batchSize: 100,
          orphanMinAgeMs: 1_000,
          temporaryFileStaleAgeMs: 1_000,
        },
        { query } as unknown as Pool,
      ),
    ).resolves.toEqual({
      orphanFilesDeleted: 0,
      staleTemporaryFilesDeleted: 0,
    });
    expect(query).not.toHaveBeenCalled();
    await Promise.all([
      expectPresent(directoryPath),
      expectPresent(symlinkPath),
      expectPresent(targetPath),
    ]);
  });

  it("does not delete candidates changed by a concurrent upload after scanning", async () => {
    const formalPath = path.join(storageDirectory, randomUUID());
    const temporaryPath = path.join(storageDirectory, temporaryFileName());
    await Promise.all([
      writeFile(formalPath, "old"),
      writeFile(temporaryPath, "old"),
    ]);
    const agedAt = new Date(Date.now() - 10_000);
    await Promise.all([
      utimes(formalPath, agedAt, agedAt),
      utimes(temporaryPath, agedAt, agedAt),
    ]);
    const query = vi.fn(async () => {
      await Promise.all([
        writeFile(formalPath, "concurrent formal upload"),
        writeFile(temporaryPath, "concurrent temporary upload"),
      ]);
      return queryResult([]);
    });

    await expect(
      reconcileInputAttachmentStorage(
        {
          storageDirectory,
          batchSize: 100,
          orphanMinAgeMs: 1_000,
          temporaryFileStaleAgeMs: 1_000,
        },
        { query } as unknown as Pool,
      ),
    ).resolves.toEqual({
      orphanFilesDeleted: 0,
      staleTemporaryFilesDeleted: 0,
    });
    await Promise.all([
      expectPresent(formalPath),
      expectPresent(temporaryPath),
    ]);
  });

  it("does not let more than one batch of older known files starve a later orphan", async () => {
    const knownNames: string[] = [randomUUID(), randomUUID(), randomUUID()];
    const orphanName = randomUUID();
    const knownPaths = knownNames.map((name) =>
      path.join(storageDirectory, name),
    );
    const orphanPath = path.join(storageDirectory, orphanName);
    await Promise.all([
      ...knownPaths.map((filePath) => writeFile(filePath, "known")),
      writeFile(orphanPath, "orphan"),
    ]);
    const oldestAt = new Date(Date.now() - 20_000);
    const laterAt = new Date(Date.now() - 10_000);
    await Promise.all([
      ...knownPaths.map((filePath) => utimes(filePath, oldestAt, oldestAt)),
      utimes(orphanPath, laterAt, laterAt),
    ]);
    const querySizes: number[] = [];
    const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
      expect(sql).toContain("FROM input_attachment_deletions deletion");
      const storagePaths = parameters?.[0];
      if (!Array.isArray(storagePaths)) {
        throw new TypeError("storage path query parameter must be an array");
      }
      querySizes.push(storagePaths.length);
      return queryResult(
        storagePaths.flatMap((storagePath) =>
          typeof storagePath === "string" && knownNames.includes(storagePath)
            ? [{ storage_path: storagePath }]
            : [],
        ),
      );
    });

    await expect(
      reconcileInputAttachmentStorage(
        {
          storageDirectory,
          batchSize: 2,
          orphanMinAgeMs: 1_000,
          temporaryFileStaleAgeMs: 1_000,
        },
        { query } as unknown as Pool,
      ),
    ).resolves.toEqual({
      orphanFilesDeleted: 1,
      staleTemporaryFilesDeleted: 0,
    });

    expect(querySizes).toEqual([2, 2, 1]);
    await expectMissing(orphanPath);
    await Promise.all(knownPaths.map(expectPresent));
  });

  it("validates safety ages and batch size before touching storage", async () => {
    const database = { query: vi.fn() } as unknown as Pool;
    await expect(
      reconcileInputAttachmentStorage(
        {
          storageDirectory,
          batchSize: 0,
          orphanMinAgeMs: 1,
          temporaryFileStaleAgeMs: 1,
        },
        database,
      ),
    ).rejects.toThrow("batchSize must be a positive safe integer");
    await expect(
      reconcileInputAttachmentStorage(
        {
          storageDirectory,
          batchSize: 1,
          orphanMinAgeMs: Number.POSITIVE_INFINITY,
          temporaryFileStaleAgeMs: 1,
        },
        database,
      ),
    ).rejects.toThrow("orphanMinAgeMs must be a positive safe integer");
  });
});
