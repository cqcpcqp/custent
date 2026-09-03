import type { Pool } from "pg";

import { getPool } from "@/lib/db/pool";

import {
  claimPendingInputAttachmentDeletions,
  completeInputAttachmentDeletion,
  queueExpiredInputAttachmentDeletions,
  recordInputAttachmentDeletionFailure,
} from "./repository";
import { deleteStoredInputAttachmentIfPresent } from "./storage";
import type { InputAttachmentDeletionJob } from "./types";
import {
  reconcileInputAttachmentStorage,
  type InputAttachmentStorageReconciliation,
} from "./reconciliation";

function deletionErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : "Unknown input attachment deletion error";
  return message.slice(0, 2_000);
}

export async function processInputAttachmentDeletion(
  input: {
    job: Pick<InputAttachmentDeletionJob, "attachmentId" | "storagePath">;
    storageDirectory: string;
    retryDelayMs: number;
  },
  database: Pool = getPool(),
): Promise<boolean> {
  try {
    await deleteStoredInputAttachmentIfPresent(
      input.storageDirectory,
      input.job.storagePath,
    );
    await completeInputAttachmentDeletion(input.job.attachmentId, database);
    return true;
  } catch (error) {
    await recordInputAttachmentDeletionFailure(
      {
        attachmentId: input.job.attachmentId,
        errorMessage: deletionErrorMessage(error),
        retryDelayMs: input.retryDelayMs,
      },
      database,
    );
    return false;
  }
}

export async function sweepInputAttachments(
  input: {
    storageDirectory: string;
    batchSize: number;
    retryDelayMs: number;
    orphanMinAgeMs: number;
    temporaryFileStaleAgeMs: number;
  },
  database: Pool = getPool(),
): Promise<
  {
    expiredQueued: number;
    completed: number;
    failed: number;
  } & InputAttachmentStorageReconciliation
> {
  const expiredQueued = await queueExpiredInputAttachmentDeletions(
    input.batchSize,
    database,
  );
  const jobs = await claimPendingInputAttachmentDeletions(
    { limit: input.batchSize, retryDelayMs: input.retryDelayMs },
    database,
  );
  const outcomes = await Promise.all(
    jobs.map((job) =>
      processInputAttachmentDeletion(
        {
          job,
          storageDirectory: input.storageDirectory,
          retryDelayMs: input.retryDelayMs,
        },
        database,
      ),
    ),
  );
  const completed = outcomes.filter(Boolean).length;
  const reconciliation = await reconcileInputAttachmentStorage(
    {
      storageDirectory: input.storageDirectory,
      batchSize: input.batchSize,
      orphanMinAgeMs: input.orphanMinAgeMs,
      temporaryFileStaleAgeMs: input.temporaryFileStaleAgeMs,
    },
    database,
  );
  return {
    expiredQueued,
    completed,
    failed: outcomes.length - completed,
    ...reconciliation,
  };
}
