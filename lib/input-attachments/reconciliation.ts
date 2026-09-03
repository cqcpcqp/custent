import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";

import type { Stats } from "node:fs";
import type { Pool } from "pg";

import { getPool } from "@/lib/db/pool";

import {
  isInputAttachmentStoragePath,
  isInputAttachmentTemporaryFileName,
} from "./naming";
import { listKnownInputAttachmentStoragePaths } from "./repository";

type StorageCandidate = {
  kind: "formal" | "temporary";
  name: string;
  absolutePath: string;
  cutoffMs: number;
  snapshot: Stats;
};

export type InputAttachmentStorageReconciliation = {
  orphanFilesDeleted: number;
  staleTemporaryFilesDeleted: number;
};

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function resolveStorageDirectory(storageDirectory: string): string {
  if (storageDirectory.length === 0) {
    throw new TypeError("storageDirectory must not be empty");
  }
  return path.resolve(storageDirectory);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function deleteUnchangedCandidate(
  candidate: StorageCandidate,
): Promise<boolean> {
  if (!(await candidateRemainsUnchanged(candidate))) {
    return false;
  }

  try {
    await unlink(candidate.absolutePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function candidateRemainsUnchanged(
  candidate: StorageCandidate,
): Promise<boolean> {
  let current: Stats;
  try {
    current = await lstat(candidate.absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }

  if (
    !current.isFile() ||
    current.mtimeMs >= candidate.cutoffMs ||
    !sameFileSnapshot(candidate.snapshot, current)
  ) {
    return false;
  }
  return true;
}

export async function reconcileInputAttachmentStorage(
  input: {
    storageDirectory: string;
    batchSize: number;
    orphanMinAgeMs: number;
    temporaryFileStaleAgeMs: number;
  },
  database: Pool = getPool(),
): Promise<InputAttachmentStorageReconciliation> {
  positiveSafeInteger(input.batchSize, "batchSize");
  positiveSafeInteger(input.orphanMinAgeMs, "orphanMinAgeMs");
  positiveSafeInteger(
    input.temporaryFileStaleAgeMs,
    "temporaryFileStaleAgeMs",
  );

  const storageDirectory = resolveStorageDirectory(input.storageDirectory);
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  const nowMs = Date.now();
  const formalCutoffMs = nowMs - input.orphanMinAgeMs;
  const temporaryCutoffMs = nowMs - input.temporaryFileStaleAgeMs;
  const directoryEntries = await readdir(storageDirectory, {
    withFileTypes: true,
  });
  const candidates: StorageCandidate[] = [];

  for (const entry of directoryEntries) {
    if (!entry.isFile()) {
      continue;
    }
    const kind = isInputAttachmentStoragePath(entry.name)
      ? "formal"
      : isInputAttachmentTemporaryFileName(entry.name)
        ? "temporary"
        : null;
    if (kind === null) {
      continue;
    }

    const absolutePath = path.join(storageDirectory, entry.name);
    let snapshot: Stats;
    try {
      snapshot = await lstat(absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }
      throw error;
    }
    const cutoffMs = kind === "formal" ? formalCutoffMs : temporaryCutoffMs;
    if (!snapshot.isFile() || snapshot.mtimeMs >= cutoffMs) {
      continue;
    }
    candidates.push({
      kind,
      name: entry.name,
      absolutePath,
      cutoffMs,
      snapshot,
    });
  }

  candidates.sort(
    (left, right) =>
      left.snapshot.mtimeMs - right.snapshot.mtimeMs ||
      left.name.localeCompare(right.name),
  );
  const formalStoragePaths = candidates.flatMap((candidate) =>
    candidate.kind === "formal" ? [candidate.name] : [],
  );
  const knownStoragePaths = new Set<string>();
  for (
    let offset = 0;
    offset < formalStoragePaths.length;
    offset += input.batchSize
  ) {
    const chunk = formalStoragePaths.slice(offset, offset + input.batchSize);
    const chunkKnownStoragePaths =
      await listKnownInputAttachmentStoragePaths(chunk, database);
    for (const storagePath of chunkKnownStoragePaths) {
      knownStoragePaths.add(storagePath);
    }
  }
  const selected = candidates
    .filter(
      (candidate) =>
        candidate.kind === "temporary" ||
        !knownStoragePaths.has(candidate.name),
    )
    .slice(0, input.batchSize);

  let orphanFilesDeleted = 0;
  let staleTemporaryFilesDeleted = 0;
  for (const candidate of selected) {
    if (candidate.kind === "formal") {
      if (!(await candidateRemainsUnchanged(candidate))) {
        continue;
      }
      const currentKnownStoragePaths =
        await listKnownInputAttachmentStoragePaths(
          [candidate.name],
          database,
        );
      if (currentKnownStoragePaths.has(candidate.name)) {
        continue;
      }
    }
    if (!(await deleteUnchangedCandidate(candidate))) {
      continue;
    }
    if (candidate.kind === "formal") {
      orphanFilesDeleted += 1;
    } else {
      staleTemporaryFilesDeleted += 1;
    }
  }

  return { orphanFilesDeleted, staleTemporaryFilesDeleted };
}
