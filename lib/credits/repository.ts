import type { Pool, PoolClient } from "pg";

import type {
  CapturedRunExecutionConfig,
  CreditBalance,
} from "@/lib/contracts";
import { AppError } from "@/lib/errors";
import { getPool, withTransaction } from "@/lib/db/pool";
import { materializeInterruptedRunContext } from "@/lib/runs/interrupted-context";

import { calculateCreditCharge } from "./calculate";
import type {
  RunMutationResult,
  RunRecord,
  RunStatus,
  RunUsage,
} from "./types";
import {
  insertCapturedRunExecutionConfig,
  parseRunExecutionConfig,
  readCapturedRunBillingPolicy,
} from "@/lib/run-config";

type CreditRow = {
  available_credits: number;
  reserved_credits: number;
  frozen_credits: number;
};

type RunRow = {
  id: string;
  request_id: string;
  user_id: string;
  conversation_id: string;
  status: RunStatus;
  conversation_turn: string;
  attempt_index: number;
  predecessor_run_id: string | null;
  retry_of_run_id: string | null;
  regenerate_of_run_id: string | null;
  reservation_credits: number;
  charged_credits: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  web_searches: number | null;
  reconciliation_reason: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
};

const RUN_RECORD_COLUMNS = `
  id,
  request_id,
  user_id,
  conversation_id,
  status,
  conversation_turn::text AS conversation_turn,
  attempt_index,
  predecessor_run_id,
  retry_of_run_id,
  regenerate_of_run_id,
  reservation_credits,
  charged_credits,
  input_tokens,
  output_tokens,
  web_searches,
  reconciliation_reason,
  cancel_requested_at,
  created_at,
  started_at,
  completed_at
`;

const activeConversationRunIndex = "runs_conversation_active_unique_idx";

function isActiveConversationRunConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === activeConversationRunIndex
  );
}

function mapBalance(row: CreditRow): CreditBalance {
  return {
    available: row.available_credits,
    reserved: row.reserved_credits + row.frozen_credits,
  };
}

function mapRun(row: RunRow): RunRecord {
  const usage =
    row.input_tokens === null ||
    row.output_tokens === null ||
    row.web_searches === null
      ? null
      : {
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          webSearches: row.web_searches,
        };

  return {
    id: row.id,
    requestId: row.request_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    status: row.status,
    conversationTurn: row.conversation_turn,
    attemptIndex: row.attempt_index,
    predecessorRunId: row.predecessor_run_id,
    retryOfRunId: row.retry_of_run_id,
    regenerateOfRunId: row.regenerate_of_run_id,
    reservationCredits: row.reservation_credits,
    chargedCredits: row.charged_credits,
    usage,
    reconciliationReason: row.reconciliation_reason,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

async function selectBalanceForUpdate(
  client: PoolClient,
  userId: string,
): Promise<CreditRow> {
  const result = await client.query<CreditRow>(
    `
      SELECT available_credits, reserved_credits, frozen_credits
      FROM users
      WHERE id = $1
      FOR UPDATE
    `,
    [userId],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }
  return result.rows[0];
}

async function selectRunForUpdate(
  client: PoolClient,
  userId: string,
  runId: string,
): Promise<RunRow> {
  const result = await client.query<RunRow>(
    `
      SELECT
        id,
        request_id,
        user_id,
        conversation_id,
        status,
        conversation_turn::text AS conversation_turn,
        attempt_index,
        predecessor_run_id,
        retry_of_run_id,
        regenerate_of_run_id,
        reservation_credits,
        charged_credits,
        input_tokens,
        output_tokens,
        web_searches,
        reconciliation_reason,
        cancel_requested_at,
        created_at,
        started_at,
        completed_at
      FROM runs
      WHERE id = $1 AND user_id = $2
      FOR UPDATE
    `,
    [runId, userId],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Run was not found", 404);
  }
  return result.rows[0];
}

async function lockRunConversationForUpdate(
  client: PoolClient,
  userId: string,
  runId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `
      SELECT conversation.id
      FROM conversations conversation
      JOIN runs run ON run.conversation_id = conversation.id
      WHERE
        run.id = $1
        AND run.user_id = $2
        AND conversation.user_id = $2
        AND conversation.deleted_at IS NULL
      FOR UPDATE OF conversation
    `,
    [runId, userId],
  );
  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Run was not found", 404);
  }
}

async function promoteDirectWaitingSuccessorInTransaction(
  runId: string,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `
      UPDATE runs successor
      SET status = 'queued', updated_at = now()
      WHERE
        successor.predecessor_run_id = $1
        AND successor.status = 'waiting'
    `,
    [runId],
  );
}

function errorForExistingRun(status: RunStatus): AppError {
  if (status === "waiting" || status === "queued" || status === "running") {
    return new AppError("RUN_IN_PROGRESS", "Run is already in progress", 409);
  }
  if (status === "reconciliation_required") {
    return new AppError(
      "RUN_REQUIRES_RECONCILIATION",
      "Run requires credit reconciliation",
      409,
    );
  }
  return new AppError("RUN_ALREADY_EXISTS", "Run already exists", 409);
}

export async function getCreditBalance(
  userId: string,
  database: Pool = getPool(),
): Promise<CreditBalance> {
  const result = await database.query<CreditRow>(
    `
      SELECT available_credits, reserved_credits, frozen_credits
      FROM users
      WHERE id = $1
    `,
    [userId],
  );

  if (result.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }
  return mapBalance(result.rows[0]);
}

export async function reserveCreditsForRunInTransaction(
  input: {
    userId: string;
    runId: string;
    reservationCredits: number;
  },
  client: PoolClient,
): Promise<CreditBalance> {
  if (
    !Number.isSafeInteger(input.reservationCredits) ||
    input.reservationCredits <= 0
  ) {
    throw new TypeError("reservationCredits must be a positive safe integer");
  }

  const creditRow = await selectBalanceForUpdate(client, input.userId);
  if (creditRow.available_credits < input.reservationCredits) {
    throw new AppError(
      "INSUFFICIENT_CREDITS",
      "Insufficient credits for this run",
      402,
    );
  }

  const balanceResult = await client.query<CreditRow>(
    `
      UPDATE users
      SET
        available_credits = available_credits - $2,
        reserved_credits = reserved_credits + $2,
        updated_at = now()
      WHERE id = $1
      RETURNING available_credits, reserved_credits, frozen_credits
    `,
    [input.userId, input.reservationCredits],
  );
  if (balanceResult.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "User was not found", 404);
  }

  const ledgerResult = await client.query<{ id: string }>(
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
      SELECT $1, run.id, $3, 'reserve', $4, $5, 0
      FROM runs run
      WHERE run.id = $2 AND run.user_id = $1
      RETURNING id::text
    `,
    [
      input.userId,
      input.runId,
      `${input.runId}:reserve`,
      -input.reservationCredits,
      input.reservationCredits,
    ],
  );
  if (ledgerResult.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Run was not found", 404);
  }

  return mapBalance(balanceResult.rows[0]);
}

export async function beginRunReservationInTransaction(
  input: {
    kind: "append" | "edit";
    userId: string;
    conversationId: string;
    requestId: string;
    reservationCredits: number;
    inputMessageId?: string;
    assistantMessageId?: string;
    requestFingerprint?: string;
    parentRunId: string | null;
    executionConfig: CapturedRunExecutionConfig;
  },
  client: PoolClient,
): Promise<RunMutationResult> {
  if (
    !Number.isSafeInteger(input.reservationCredits) ||
    input.reservationCredits <= 0
  ) {
    throw new TypeError("reservationCredits must be a positive safe integer");
  }
  const executionConfig = parseRunExecutionConfig(input.executionConfig);
  if (executionConfig.provenance !== "captured") {
    throw new TypeError("A new Run requires a captured execution config");
  }
  if (
    executionConfig.billing.reservationCredits !==
    input.reservationCredits
  ) {
    throw new TypeError(
      "Run reservation must match its captured billing configuration",
    );
  }
  const hasInputMessage = input.inputMessageId !== undefined;
  const hasAssistantMessage = input.assistantMessageId !== undefined;
  if (hasInputMessage !== hasAssistantMessage) {
    throw new TypeError(
      "inputMessageId and assistantMessageId must be provided together",
    );
  }

  try {
    const conversation = await client.query<{ id: string }>(
      `
        SELECT id
        FROM conversations
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        FOR UPDATE
      `,
      [input.conversationId, input.userId],
    );
    if (conversation.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }

    const existing = await client.query<{ status: RunStatus }>(
      "SELECT status FROM runs WHERE request_id = $1",
      [input.requestId],
    );
    if (existing.rowCount === 1) {
      throw errorForExistingRun(existing.rows[0].status);
    }

    const parentResult = input.parentRunId === null
      ? null
      : await client.query<{
      id: string;
      status: RunStatus;
      conversation_turn: string;
    }>(
      `
        SELECT id, status, conversation_turn::text
        FROM runs
        WHERE id = $1 AND conversation_id = $2 AND user_id = $3
        FOR UPDATE OF runs
      `,
      [input.parentRunId, input.conversationId, input.userId],
    );
    const parent = parentResult?.rows[0] ?? null;
    if (input.parentRunId !== null && parent === null) {
      throw new AppError("STALE_PARENT", "Parent Run is not available", 409);
    }

    const outstandingRuns = await client.query<{
      id: string;
      status: Extract<RunStatus, "waiting" | "queued" | "running">;
    }>(
      `
        SELECT id, status
        FROM runs
        WHERE
          conversation_id = $1
          AND status IN ('waiting', 'queued', 'running')
        ORDER BY conversation_turn, created_at, id
        FOR UPDATE OF runs
      `,
      [input.conversationId],
    );

    let runStatus: "waiting" | "queued";
    let conversationTurn: string;
    if (parent === null) {
      const existingRun = await client.query<{ id: string }>(
        "SELECT id FROM runs WHERE conversation_id = $1 LIMIT 1",
        [input.conversationId],
      );
      if (input.kind === "append" && existingRun.rowCount !== 0) {
        throw new AppError(
          "STALE_PARENT",
          "A root Run can only be created in an empty conversation",
          409,
        );
      }
      if (input.kind === "edit") {
        if (!hasInputMessage || !hasAssistantMessage) {
          throw new TypeError(
            "A root edit reservation requires durable message IDs",
          );
        }
        if (existingRun.rowCount === 0) {
          throw new AppError(
            "STALE_PARENT",
            "A root edit requires an existing conversation branch",
            409,
          );
        }
        if (outstandingRuns.rowCount !== 0) {
          throw new AppError(
            "RUN_IN_PROGRESS",
            "Another branch already has an outstanding Run",
            409,
          );
        }
      }
      runStatus = "queued";
      conversationTurn = "1";
    } else if (
      parent.status === "completed" ||
      parent.status === "cancelled" ||
      parent.status === "reconciliation_required"
    ) {
      if (outstandingRuns.rowCount !== 0) {
        throw new AppError(
          "RUN_IN_PROGRESS",
          "Another branch already has an outstanding Run",
          409,
        );
      }
      if (parent.status !== "completed") {
        await materializeInterruptedRunContext({
          userId: input.userId,
          conversationId: input.conversationId,
          runId: parent.id,
        }, client);
      }
      const parentContext = await client.query<{ exists: boolean }>(
        `
          SELECT EXISTS (
            SELECT 1
            FROM run_session_snapshots snapshot
            WHERE snapshot.run_id = $1 AND snapshot.phase = 'post'
          ) AS exists
        `,
        [parent.id],
      );
      if (!parentContext.rows[0].exists) {
        throw new AppError(
          "RUN_CONTEXT_UNAVAILABLE",
          "Parent Run continuation context is unavailable",
          409,
        );
      }
      runStatus = "queued";
      conversationTurn = (BigInt(parent.conversation_turn) + 1n).toString();
    } else if (
      parent.status === "waiting" ||
      parent.status === "queued" ||
      parent.status === "running"
    ) {
      if (!hasInputMessage || !hasAssistantMessage) {
        throw new AppError(
          "RUN_IN_PROGRESS",
          "Another run is already active for this conversation",
          409,
        );
      }
      const offBranchOutstanding = await client.query<{ exists: boolean }>(
        `
          WITH RECURSIVE parent_path AS (
            SELECT id, predecessor_run_id
            FROM runs
            WHERE id = $1
            UNION ALL
            SELECT predecessor.id, predecessor.predecessor_run_id
            FROM runs predecessor
            JOIN parent_path child ON child.predecessor_run_id = predecessor.id
          )
          SELECT EXISTS (
            SELECT 1
            FROM runs outstanding
            WHERE
              outstanding.conversation_id = $2
              AND outstanding.status IN ('waiting', 'queued', 'running')
              AND NOT EXISTS (
                SELECT 1 FROM parent_path WHERE parent_path.id = outstanding.id
              )
          ) AS exists
        `,
        [parent.id, input.conversationId],
      );
      if (offBranchOutstanding.rows[0].exists) {
        throw new AppError(
          "RUN_IN_PROGRESS",
          "Another branch already has an outstanding Run",
          409,
        );
      }
      runStatus = "waiting";
      conversationTurn = (BigInt(parent.conversation_turn) + 1n).toString();
    } else {
      throw new AppError(
        "RUN_CONTEXT_UNAVAILABLE",
        "The parent Run has no continuation context; retry the failed Run first",
        409,
      );
    }

    const runResult = await client.query<RunRow>(
      `
        INSERT INTO runs (
          request_id,
          user_id,
          conversation_id,
          status,
          reservation_credits,
          input_message_id,
          assistant_message_id,
          request_fingerprint,
          conversation_turn,
          attempt_index,
          predecessor_run_id
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::bigint,
          1,
          $10
        )
        RETURNING
          id,
          request_id,
          user_id,
          conversation_id,
          status,
          conversation_turn::text AS conversation_turn,
          attempt_index,
          predecessor_run_id,
          retry_of_run_id,
          regenerate_of_run_id,
          reservation_credits,
          charged_credits,
          input_tokens,
          output_tokens,
          web_searches,
          reconciliation_reason,
          created_at,
          started_at,
          completed_at
      `,
      [
        input.requestId,
        input.userId,
        input.conversationId,
        runStatus,
        input.reservationCredits,
        input.inputMessageId ?? null,
        input.assistantMessageId ?? null,
        input.requestFingerprint ?? null,
        conversationTurn,
        parent?.id ?? null,
      ],
    );
    const run = runResult.rows[0];
    await insertCapturedRunExecutionConfig(run.id, executionConfig, client);
    const credits = await reserveCreditsForRunInTransaction(
      {
        userId: input.userId,
        runId: run.id,
        reservationCredits: input.reservationCredits,
      },
      client,
    );

    const selected = await client.query<{ id: string }>(
      `
        UPDATE conversations
        SET selected_run_id = $3, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id
      `,
      [input.conversationId, input.userId, run.id],
    );
    if (selected.rowCount !== 1) {
      throw new AppError("NOT_FOUND", "Conversation was not found", 404);
    }

    return { run: mapRun(run), credits };
  } catch (error) {
    if (isActiveConversationRunConflict(error)) {
      throw new AppError(
        "RUN_IN_PROGRESS",
        "Another run is already active for this conversation",
        409,
      );
    }
    throw error;
  }
}

export async function beginRunReservation(
  input: {
    userId: string;
    conversationId: string;
    requestId: string;
    reservationCredits: number;
    parentRunId: string | null;
    executionConfig: CapturedRunExecutionConfig;
  },
  database: Pool = getPool(),
): Promise<RunMutationResult> {
  return withTransaction(
    (client) =>
      beginRunReservationInTransaction({ ...input, kind: "append" }, client),
    database,
  );
}

export async function markRunRunning(
  userId: string,
  runId: string,
  database: Pool = getPool(),
): Promise<RunRecord> {
  const result = await database.query<RunRow>(
    `
      UPDATE runs
      SET status = 'running', started_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'queued'
      RETURNING ${RUN_RECORD_COLUMNS}
    `,
    [runId, userId],
  );

  if (result.rowCount === 1) {
    return mapRun(result.rows[0]);
  }

  const existing = await database.query<RunRow>(
    `
      SELECT ${RUN_RECORD_COLUMNS}
      FROM runs
      WHERE id = $1 AND user_id = $2
    `,
    [runId, userId],
  );
  if (existing.rowCount !== 1) {
    throw new AppError("NOT_FOUND", "Run was not found", 404);
  }
  if (existing.rows[0].status === "running") {
    return mapRun(existing.rows[0]);
  }
  throw errorForExistingRun(existing.rows[0].status);
}

export type SettleRunInTransactionResult =
  | {
      kind: "completed";
      value: RunMutationResult;
      alreadyCompleted: boolean;
    }
  | {
      kind: "reconciliation_required";
      credits: CreditBalance;
    };

export async function settleRunInTransaction(
  input: { userId: string; runId: string; usage: RunUsage },
  client: PoolClient,
): Promise<SettleRunInTransactionResult> {
  await lockRunConversationForUpdate(client, input.userId, input.runId);
  const run = await selectRunForUpdate(client, input.userId, input.runId);
  const creditRow = await selectBalanceForUpdate(client, input.userId);

  if (run.status === "completed") {
    if (
      run.input_tokens === input.usage.inputTokens &&
      run.output_tokens === input.usage.outputTokens &&
      run.web_searches === input.usage.webSearches
    ) {
      return {
        kind: "completed",
        value: { run: mapRun(run), credits: mapBalance(creditRow) },
        alreadyCompleted: true,
      };
    }
    throw new AppError(
      "RUN_ALREADY_EXISTS",
      "Run was already settled with different usage",
      409,
    );
  }
  if (run.status === "reconciliation_required") {
    throw errorForExistingRun(run.status);
  }
  if (run.status !== "running") {
    throw new AppError("RUN_IN_PROGRESS", "Run has not started", 409);
  }
  if (run.cancel_requested_at !== null) {
    throw new AppError(
      "RUN_IN_PROGRESS",
      "Run cancellation is pending",
      409,
    );
  }

  const billingPolicy = await readCapturedRunBillingPolicy(run.id, client);
  const charge = calculateCreditCharge(input.usage, billingPolicy);
  if (charge > run.reservation_credits) {
    const balanceResult = await client.query<CreditRow>(
      `
        UPDATE users
        SET
          reserved_credits = reserved_credits - $2,
          frozen_credits = frozen_credits + $2,
          updated_at = now()
        WHERE id = $1
        RETURNING available_credits, reserved_credits, frozen_credits
      `,
      [input.userId, run.reservation_credits],
    );
    await client.query(
      `
      UPDATE runs
      SET
        status = 'reconciliation_required',
        reconciliation_reason = $2,
        failure_code = 'RUN_REQUIRES_RECONCILIATION',
        failure_message = '这次运行需要积分对账。',
        finished_at = now(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = now()
        WHERE id = $1
      `,
      [run.id, `Calculated charge ${charge} exceeded reservation ${run.reservation_credits}`],
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
        VALUES ($1, $2, $3, 'freeze', 0, $4, $5)
      `,
      [
        input.userId,
        run.id,
        `${run.id}:freeze`,
        -run.reservation_credits,
        run.reservation_credits,
      ],
    );

    return {
      kind: "reconciliation_required",
      credits: mapBalance(balanceResult.rows[0]),
    };
  }

  const refund = run.reservation_credits - charge;
  const balanceResult = await client.query<CreditRow>(
    `
      UPDATE users
      SET
        available_credits = available_credits + $2,
        reserved_credits = reserved_credits - $3,
        updated_at = now()
      WHERE id = $1
      RETURNING available_credits, reserved_credits, frozen_credits
    `,
    [input.userId, refund, run.reservation_credits],
  );
  const settledRunResult = await client.query<RunRow>(
    `
      UPDATE runs
      SET
        status = 'completed',
        charged_credits = $2,
        input_tokens = $3,
        output_tokens = $4,
        web_searches = $5,
        completed_at = now(),
        finished_at = now(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = now()
      WHERE id = $1
      RETURNING ${RUN_RECORD_COLUMNS}
    `,
    [
      run.id,
      charge,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.webSearches,
    ],
  );
  await promoteDirectWaitingSuccessorInTransaction(run.id, client);
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
      VALUES ($1, $2, $3, 'settle', $4, $5, 0)
    `,
    [
      input.userId,
      run.id,
      `${run.id}:settle`,
      refund,
      -run.reservation_credits,
    ],
  );

  return {
    kind: "completed",
    value: {
      run: mapRun(settledRunResult.rows[0]),
      credits: mapBalance(balanceResult.rows[0]),
    },
    alreadyCompleted: false,
  };
}

export async function settleRun(
  input: { userId: string; runId: string; usage: RunUsage },
  database: Pool = getPool(),
): Promise<RunMutationResult> {
  const result = await withTransaction(
    (client) => settleRunInTransaction(input, client),
    database,
  );

  if (result.kind === "reconciliation_required") {
    throw new AppError(
      "RUN_REQUIRES_RECONCILIATION",
      "Calculated charge exceeded the reserved credits; the reservation was frozen",
      409,
    );
  }
  return result.value;
}

export async function markRunReconciliationRequired(
  input: { userId: string; runId: string; reason: string },
  database: Pool = getPool(),
): Promise<RunMutationResult> {
  if (input.reason.length === 0) {
    throw new TypeError("reason must not be empty");
  }

  return withTransaction(async (client) => {
    await lockRunConversationForUpdate(client, input.userId, input.runId);
    const run = await selectRunForUpdate(client, input.userId, input.runId);
    const creditRow = await selectBalanceForUpdate(client, input.userId);

    if (run.status === "reconciliation_required") {
      return { run: mapRun(run), credits: mapBalance(creditRow) };
    }
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled"
    ) {
      throw new AppError("RUN_ALREADY_EXISTS", "Completed run cannot be frozen", 409);
    }

    const balanceResult = await client.query<CreditRow>(
      `
        UPDATE users
        SET
          reserved_credits = reserved_credits - $2,
          frozen_credits = frozen_credits + $2,
          updated_at = now()
        WHERE id = $1
        RETURNING available_credits, reserved_credits, frozen_credits
      `,
      [input.userId, run.reservation_credits],
    );
    const runResult = await client.query<RunRow>(
      `
      UPDATE runs
      SET
        status = 'reconciliation_required',
        reconciliation_reason = $2,
        failure_code = 'RUN_REQUIRES_RECONCILIATION',
        failure_message = '这次运行需要积分对账。',
        finished_at = now(),
        lease_owner = NULL,
        lease_expires_at = NULL,
        heartbeat_at = NULL,
        updated_at = now()
        WHERE id = $1
        RETURNING ${RUN_RECORD_COLUMNS}
      `,
      [run.id, input.reason],
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
        VALUES ($1, $2, $3, 'freeze', 0, $4, $5)
      `,
      [
        input.userId,
        run.id,
        `${run.id}:freeze`,
        -run.reservation_credits,
        run.reservation_credits,
      ],
    );

    return {
      run: mapRun(runResult.rows[0]),
      credits: mapBalance(balanceResult.rows[0]),
    };
  }, database);
}

export async function getRunByRequestId(
  userId: string,
  requestId: string,
  database: Pool = getPool(),
): Promise<RunRecord | null> {
  const result = await database.query<RunRow>(
    `
      SELECT ${RUN_RECORD_COLUMNS}
      FROM runs
      WHERE request_id = $1 AND user_id = $2
    `,
    [requestId, userId],
  );
  return result.rowCount === 0 ? null : mapRun(result.rows[0]);
}
