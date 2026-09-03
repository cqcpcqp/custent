import type { AgentInputItem } from "@openai/agents";
import type { Pool, PoolClient } from "pg";

import type { AgentRunStatus } from "@/lib/contracts";
import { AppError } from "@/lib/errors";

import { readConversationContextSeedItems } from "./conversation-context-seeds";
import {
  readRunSessionSnapshot,
  writeRunSessionSnapshot,
} from "./session-snapshots";

type RetrySourceRow = {
  status: AgentRunStatus;
  predecessor_run_id: string | null;
  model_started_at: Date | null;
};

type PredecessorRow = {
  status: AgentRunStatus;
};

export type RetrySourcePreRunContext =
  | {
      kind: "available";
      items: AgentInputItem[];
    }
  | {
      kind: "deferred";
    };

function unavailable(): AppError {
  return new AppError(
    "RUN_CONTEXT_UNAVAILABLE",
    "Run retry context is unavailable",
    409,
  );
}

/**
 * Resolves the immutable pre-Run context of a failed or cancelled retry source.
 *
 * An existing pre snapshot is authoritative. A missing snapshot may only be
 * reconstructed while the source is known not to have reached the model:
 * roots use their immutable conversation seed (or the canonical empty root
 * history), and non-roots use their completed predecessor's post snapshot.
 */
export async function materializeRetrySourcePreRunContext(
  input: {
    userId: string;
    conversationId: string;
    sourceRunId: string;
    allowDeferredPredecessor: boolean;
  },
  database: Pool | PoolClient,
): Promise<RetrySourcePreRunContext> {
  const sourceResult = await database.query<RetrySourceRow>(
    `
      SELECT
        run.status,
        run.predecessor_run_id,
        run.model_started_at
      FROM runs run
      WHERE
        run.id = $1
        AND run.user_id = $2
        AND run.conversation_id = $3
    `,
    [input.sourceRunId, input.userId, input.conversationId],
  );
  if (sourceResult.rowCount !== 1) {
    throw unavailable();
  }
  const source = sourceResult.rows[0];
  if (source.status !== "failed" && source.status !== "cancelled") {
    throw unavailable();
  }

  const existing = await readRunSessionSnapshot(
    input.sourceRunId,
    "pre",
    database,
  );
  if (existing !== null) {
    return { kind: "available", items: existing.items };
  }
  if (source.model_started_at !== null) {
    throw unavailable();
  }

  let items: AgentInputItem[];
  if (source.predecessor_run_id === null) {
    items =
      (await readConversationContextSeedItems(
        input.conversationId,
        database,
      )) ?? [];
  } else {
    const predecessorResult = await database.query<PredecessorRow>(
      `
        SELECT predecessor.status
        FROM runs predecessor
        WHERE
          predecessor.id = $1
          AND predecessor.user_id = $2
          AND predecessor.conversation_id = $3
      `,
      [source.predecessor_run_id, input.userId, input.conversationId],
    );
    if (predecessorResult.rowCount !== 1) {
      throw unavailable();
    }
    if (predecessorResult.rows[0].status !== "completed") {
      if (input.allowDeferredPredecessor) {
        return { kind: "deferred" };
      }
      throw unavailable();
    }

    const predecessorPost = await readRunSessionSnapshot(
      source.predecessor_run_id,
      "post",
      database,
    );
    if (predecessorPost === null) {
      throw unavailable();
    }
    items = predecessorPost.items;
  }

  const materialized = await writeRunSessionSnapshot(
    input.sourceRunId,
    "pre",
    items,
    database,
  );
  return { kind: "available", items: materialized.items };
}
