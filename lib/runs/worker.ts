import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { MemorySession, type AgentInputItem } from "@openai/agents";
import type { Pool } from "pg";

import type {
  AgentRuntimeFactory,
  AgentRuntimeEvent,
  AgentRunOptions,
} from "@/lib/agent";
import {
  dehydrateAttachmentData,
  hydrateAttachmentRunInput,
  type AttachmentDehydrationPlan,
  type LoadedAttachment,
} from "@/lib/agent/attachment-session";
import type { LocalAgentToolName, RunEventPayload } from "@/lib/contracts";
import { getPool } from "@/lib/db";
import { getEnv } from "@/lib/env";
import {
  getConversationBoundInputAttachmentRecord,
  getMessageBoundInputAttachmentRecord,
  resolveStoredInputAttachmentPath,
  toInputAttachmentSummary,
  type InputAttachmentRecord,
  type MessageInputAttachmentRecord,
} from "@/lib/input-attachments";

import {
  RunLeaseLostError,
  appendRunEvent,
  claimNextRun,
  completeClaimedRun,
  failClaimedRun,
  markRunModelStarted,
  recoverAbandonedRuns,
  renewRunLease,
} from "./repository";
import { readConversationContextSeedItems } from "./conversation-context-seeds";
import { materializeRetrySourcePreRunContext } from "./pre-run-context";
import {
  readRunSessionSnapshot,
  writeRunSessionSnapshot,
} from "./session-snapshots";
import type { ClaimedAgentRun, LeaseHeartbeat, RunLease } from "./types";
import {
  createCurrentUserInput,
  verifyLoadedInputAttachment,
} from "./worker-attachment-input";

type CompleteEvent = Extract<AgentRuntimeEvent, { type: "complete" }>;
type PreparedAttachmentRunInput = {
  initialItems: AgentInputItem[];
  currentInput: AgentInputItem[];
  dehydrationPlan: AttachmentDehydrationPlan;
  currentAttachments: MessageInputAttachmentRecord[];
};

type LoadedAttachmentRecord = {
  record: InputAttachmentRecord;
  attachment: LoadedAttachment;
};

type LeaseRenewalOutcome =
  | { kind: "renewed"; heartbeat: LeaseHeartbeat }
  | { kind: "failed"; error: unknown }
  | { kind: "deadline" }
  | { kind: "stopped" };

type SafeWorkerErrorEvent = Readonly<{
  event:
    | "agent_run_execution_failed"
    | "agent_run_finalization_failed"
    | "run_lease_renewal_failed"
    | "worker_loop_failed";
  errorName: "AbortError" | "Error" | "RangeError" | "RunLeaseLostError" | "TypeError" | "UnknownError";
  runId?: string;
}>;

export type AgentRunWorkerOptions = {
  runtimeFactory: AgentRuntimeFactory;
  database?: Pool;
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  recoverAbandoned?: boolean;
  logger?: Pick<Console, "error">;
};

const toolTitles: Record<LocalAgentToolName, string> = {
  list_research: "读取已保存的研究",
  save_research_results: "保存研究结果",
  create_csv: "生成 CSV 文件",
  create_pdf: "生成 PDF 文件",
  create_csv_file: "生成通用 CSV 文件",
  create_pdf_file: "生成通用 PDF 文件",
};

function safeWorkerErrorName(
  error: unknown,
): SafeWorkerErrorEvent["errorName"] {
  if (error instanceof RunLeaseLostError) {
    return "RunLeaseLostError";
  }
  if (error instanceof TypeError) {
    return "TypeError";
  }
  if (error instanceof RangeError) {
    return "RangeError";
  }
  if (error instanceof Error) {
    return error.name === "AbortError" ? "AbortError" : "Error";
  }
  return "UnknownError";
}

function safeWorkerErrorEvent(
  event: SafeWorkerErrorEvent["event"],
  error: unknown,
  runId?: string,
): SafeWorkerErrorEvent {
  return {
    event,
    errorName: safeWorkerErrorName(error),
    ...(runId === undefined ? {} : { runId }),
  };
}

function positiveInteger(value: number, description: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${description} must be a positive safe integer`);
  }
  return value;
}

function serializeActivityValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Tool activity value is not JSON serializable");
  }
  return serialized;
}

function eventPayload(
  event: Exclude<AgentRuntimeEvent, CompleteEvent>,
): RunEventPayload {
  switch (event.type) {
    case "status":
    case "delta":
    case "artifact":
      return event;
    case "reasoning_delta":
      return {
        type: "reasoning",
        itemId: event.itemId,
        summaryIndex: event.summaryIndex,
        providerSequence: event.providerSequence,
        text: event.delta,
      };
    case "web_search_status":
      return {
        type: "web_search",
        callId: event.callId,
        phase: event.phase,
        outputIndex: event.outputIndex,
        providerSequence: event.providerSequence,
        action: event.action,
      };
    case "code_interpreter_status":
      return {
        type: "code_interpreter_status",
        callId: event.callId,
        phase: event.phase,
        outputIndex: event.outputIndex,
        providerSequence: event.providerSequence,
      };
    case "code_interpreter_code_delta":
      return {
        type: "code_interpreter_code",
        callId: event.callId,
        update: "delta",
        code: event.delta,
        outputIndex: event.outputIndex,
        providerSequence: event.providerSequence,
      };
    case "code_interpreter_code_done":
      return {
        type: "code_interpreter_code",
        callId: event.callId,
        update: "done",
        code: event.code,
        outputIndex: event.outputIndex,
        providerSequence: event.providerSequence,
      };
    case "code_interpreter_result":
      return {
        type: "code_interpreter_result",
        callId: event.callId,
        phase: event.phase,
        outputIndex: event.outputIndex,
        providerSequence: event.providerSequence,
        containerId: event.containerId,
        code: event.code,
        outputs: event.outputs,
      };
    case "tool_called":
      return {
        type: "tool_started",
        callId: event.callId,
        toolName: event.toolName,
        title: toolTitles[event.toolName],
        input: serializeActivityValue(event.input),
      };
    case "tool_output":
      return {
        type: "tool_completed",
        callId: event.callId,
        toolName: event.toolName,
        title: toolTitles[event.toolName],
        output: serializeActivityValue(event.output),
      };
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function waitForLeaseRenewal(
  renewal: Promise<LeaseHeartbeat>,
  leaseDeadline: number,
  signal: AbortSignal,
): Promise<LeaseRenewalOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (outcome: LeaseRenewalOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      signal.removeEventListener("abort", stop);
      resolve(outcome);
    };
    const stop = () => finish({ kind: "stopped" });

    void renewal.then(
      (heartbeat) => finish({ kind: "renewed", heartbeat }),
      (error: unknown) => finish({ kind: "failed", error }),
    );

    if (signal.aborted) {
      finish({ kind: "stopped" });
      return;
    }
    signal.addEventListener("abort", stop, { once: true });
    timeout = setTimeout(
      () => finish({ kind: "deadline" }),
      Math.max(0, leaseDeadline - Date.now()),
    );
  });
}

function runLease(claim: ClaimedAgentRun): RunLease {
  return {
    runId: claim.run.id,
    leaseOwner: claim.leaseOwner,
    leaseToken: claim.leaseToken,
  };
}

async function loadBaseSessionItems(
  claim: ClaimedAgentRun,
  database: Pool,
): Promise<AgentInputItem[]> {
  if (claim.run.retryOfRunId !== null) {
    const context = await materializeRetrySourcePreRunContext(
      {
        userId: claim.userId,
        conversationId: claim.run.conversationId,
        sourceRunId: claim.run.retryOfRunId,
        allowDeferredPredecessor: false,
      },
      database,
    );
    if (context.kind !== "available") {
      throw new Error(
        `Run context source ${claim.run.retryOfRunId} is still waiting for its predecessor`,
      );
    }
    return context.items;
  }

  const sourceRunId =
    claim.run.regenerateOfRunId ?? claim.run.predecessorRunId;
  if (sourceRunId === null) {
    return (
      (await readConversationContextSeedItems(
        claim.run.conversationId,
        database,
      )) ?? []
    );
  }

  const phase = claim.run.regenerateOfRunId !== null ? "pre" : "post";

  const sourceSnapshot = await readRunSessionSnapshot(
    sourceRunId,
    phase,
    database,
  );
  if (sourceSnapshot === null) {
    throw new Error(
      `Run context source ${sourceRunId} is missing its ${phase}-session snapshot`,
    );
  }
  return sourceSnapshot.items;
}

async function prepareAttachmentRunInput(
  claim: ClaimedAgentRun,
  persistedItems: readonly AgentInputItem[],
  database: Pool,
): Promise<PreparedAttachmentRunInput> {
  const storageDirectory = getEnv().INPUT_ATTACHMENT_DIR;
  const loadedById = new Map<string, Promise<LoadedAttachmentRecord>>();

  const readRecord = async (
    record: InputAttachmentRecord,
  ): Promise<LoadedAttachmentRecord> => {
    if (record.userId !== claim.userId) {
      throw new TypeError(
        `Conversation attachment ${record.id} record identity is inconsistent`,
      );
    }
    const bytes = await readFile(
      resolveStoredInputAttachmentPath(storageDirectory, record.storagePath),
    );
    return {
      record,
      attachment: verifyLoadedInputAttachment(record, bytes),
    };
  };

  const loadRecord = (
    record: InputAttachmentRecord,
  ): Promise<LoadedAttachmentRecord> => {
    const existing = loadedById.get(record.id);
    if (existing !== undefined) {
      return existing;
    }
    const pending = readRecord(record);
    loadedById.set(record.id, pending);
    return pending;
  };

  const load = (attachmentId: string): Promise<LoadedAttachmentRecord> => {
    const existing = loadedById.get(attachmentId);
    if (existing !== undefined) {
      return existing;
    }
    const pending = (async () => {
      const record = await getConversationBoundInputAttachmentRecord(
        {
          userId: claim.userId,
          conversationId: claim.run.conversationId,
          attachmentId,
        },
        database,
      );
      if (record === null) {
        throw new Error(
          `Conversation attachment ${attachmentId} is missing or inaccessible`,
        );
      }
      if (record.id !== attachmentId) {
        throw new TypeError(
          `Conversation attachment ${attachmentId} record identity is inconsistent`,
        );
      }
      return readRecord(record);
    })();
    loadedById.set(attachmentId, pending);
    return pending;
  };

  const currentAttachments = await Promise.all(
    claim.inputAttachmentIds.map(
      async (attachmentId) => {
        const record = await getMessageBoundInputAttachmentRecord(
          {
            userId: claim.userId,
            conversationId: claim.run.conversationId,
            messageId: claim.run.inputMessageId,
            attachmentId,
          },
          database,
        );
        if (record === null) {
          throw new Error(
            `Current message attachment ${attachmentId} is missing or inaccessible`,
          );
        }
        if (record.id !== attachmentId || record.userId !== claim.userId) {
          throw new TypeError(
            `Current message attachment ${attachmentId} record identity is inconsistent`,
          );
        }
        await loadRecord(record);
        return record;
      },
    ),
  );
  const currentInput = createCurrentUserInput({
    messageId: claim.run.inputMessageId,
    text: claim.input,
    attachmentIds: claim.inputAttachmentIds,
    attachments: currentAttachments,
  });
  const hydrated = await hydrateAttachmentRunInput(
    persistedItems,
    currentInput[0],
    async (attachmentId) => (await load(attachmentId)).attachment,
  );
  return {
    initialItems: hydrated.initialItems,
    currentInput: hydrated.currentInput,
    dehydrationPlan: hydrated.plan,
    currentAttachments,
  };
}

export class AgentRunWorker {
  private readonly runtimeFactory: AgentRuntimeFactory;
  private readonly database: Pool;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly recoverAbandoned: boolean;
  private readonly logger: Pick<Console, "error">;

  constructor(options: AgentRunWorkerOptions) {
    this.runtimeFactory = options.runtimeFactory;
    this.database = options.database ?? getPool();
    this.workerId = options.workerId ?? randomUUID();
    this.concurrency = positiveInteger(options.concurrency ?? 2, "concurrency");
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? 250,
      "pollIntervalMs",
    );
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? 30_000,
      "leaseDurationMs",
    );
    this.recoverAbandoned = options.recoverAbandoned ?? true;
    this.logger = options.logger ?? console;
  }

  async runOnce(): Promise<boolean> {
    if (this.recoverAbandoned) {
      await recoverAbandonedRuns({ maxRuns: 10 }, this.database);
    }
    const claimStartedAt = Date.now();
    const claim = await claimNextRun(
      {
        workerId: this.workerId,
        leaseDurationMs: this.leaseDurationMs,
        capability: this.runtimeFactory.capability,
      },
      this.database,
    );
    if (claim === null) {
      return false;
    }
    await this.processClaim(
      claim,
      claimStartedAt + this.leaseDurationMs,
    );
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all(
      Array.from({ length: this.concurrency }, () => this.runLoop(signal)),
    );
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const worked = await this.runOnce();
        if (!worked) {
          await delay(this.pollIntervalMs, signal);
        }
      } catch (error) {
        this.logger.error(safeWorkerErrorEvent("worker_loop_failed", error));
        await delay(this.pollIntervalMs, signal);
      }
    }
  }

  private async processClaim(
    claim: ClaimedAgentRun,
    initialLeaseDeadline: number,
  ): Promise<void> {
    const lease = runLease(claim);
    const execution = new AbortController();
    const monitor = new AbortController();
    let cancellationRequested = false;
    const monitorPromise = this.monitorLease(
      lease,
      execution,
      monitor.signal,
      initialLeaseDeadline,
      () => {
        cancellationRequested = true;
      },
    );

    try {
      const runtime = this.runtimeFactory.forRun(
        claim.executionConfig,
        claim.customInstructionsSnapshot,
      );
      const persistedItems = await loadBaseSessionItems(claim, this.database);
      await writeRunSessionSnapshot(
        claim.run.id,
        "pre",
        persistedItems,
        this.database,
      );
      const preparedInput = await prepareAttachmentRunInput(
        claim,
        persistedItems,
        this.database,
      );
      const session = new MemorySession({
        sessionId: claim.run.conversationId,
        initialItems: preparedInput.initialItems,
      });
      for (const attachment of preparedInput.currentAttachments) {
        await appendRunEvent(
          lease,
          {
            type: "attachment",
            attachment: toInputAttachmentSummary(attachment),
          },
          this.database,
        );
      }
      await markRunModelStarted(lease, this.database);

      let completion: CompleteEvent | null = null;
      const options: AgentRunOptions = {
        context: {
          userId: claim.userId,
          conversationId: claim.run.conversationId,
          requestId: claim.run.requestId,
          runId: claim.run.id,
          assistantMessageId: claim.run.assistantMessageId,
          leaseOwner: claim.leaseOwner,
          leaseToken: claim.leaseToken,
        },
        session,
        signal: execution.signal,
      };
      for await (const event of runtime.run(
        preparedInput.currentInput,
        options,
      )) {
        if (event.type === "complete") {
          if (completion !== null) {
            throw new Error("Agent runtime emitted more than one complete event");
          }
          completion = event;
          continue;
        }
        await appendRunEvent(lease, eventPayload(event), this.database);
      }
      if (completion === null) {
        throw new Error("Agent runtime ended without a complete event");
      }

      const sessionItems = dehydrateAttachmentData(
        await session.getItems(),
        preparedInput.dehydrationPlan,
      );

      await completeClaimedRun(
        {
          lease,
          userId: claim.userId,
          conversationId: claim.run.conversationId,
          assistantMessageId: claim.run.assistantMessageId,
          content: completion.content,
          citations: completion.citations,
          usage: {
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
            webSearches: completion.webSearches,
          },
          sessionItems,
        },
        this.database,
      );
    } catch (error) {
      const leaseWasLost =
        error instanceof RunLeaseLostError ||
        execution.signal.reason instanceof RunLeaseLostError;
      this.logger.error(
        safeWorkerErrorEvent(
          "agent_run_execution_failed",
          leaseWasLost ? execution.signal.reason : error,
          claim.run.id,
        ),
      );
      if (!leaseWasLost) {
        try {
          await failClaimedRun(
            {
              lease,
              errorName: safeWorkerErrorName(error),
              ...(cancellationRequested
                ? {
                    eventCode: "RUN_CANCELLED",
                    eventMessage:
                      "运行已停止，相关预扣积分已进入待对账状态。",
                  }
                : {}),
            },
            this.database,
          );
        } catch (finalizationError) {
          if (!(finalizationError instanceof RunLeaseLostError)) {
            this.logger.error(
              safeWorkerErrorEvent(
                "agent_run_finalization_failed",
                finalizationError,
                claim.run.id,
              ),
            );
          }
        }
      }
    } finally {
      monitor.abort();
      await monitorPromise;
    }
  }

  private async monitorLease(
    lease: RunLease,
    execution: AbortController,
    signal: AbortSignal,
    initialLeaseDeadline: number,
    onCancellation: () => void,
  ): Promise<void> {
    const interval = Math.max(
      1,
      Math.min(1_000, Math.floor(this.leaseDurationMs / 3)),
    );
    let leaseDeadline = initialLeaseDeadline;
    while (!signal.aborted) {
      const remainingLeaseMs = leaseDeadline - Date.now();
      if (remainingLeaseMs <= 0) {
        execution.abort(new RunLeaseLostError(lease.runId));
        return;
      }
      await delay(Math.min(interval, remainingLeaseMs), signal);
      if (signal.aborted) {
        return;
      }
      if (Date.now() >= leaseDeadline) {
        execution.abort(new RunLeaseLostError(lease.runId));
        return;
      }
      const renewalStartedAt = Date.now();
      const outcome = await waitForLeaseRenewal(
        renewRunLease(
          lease,
          this.leaseDurationMs,
          this.database,
        ),
        leaseDeadline,
        signal,
      );
      switch (outcome.kind) {
        case "stopped":
          return;
        case "deadline":
          execution.abort(new RunLeaseLostError(lease.runId));
          return;
        case "failed":
          this.logger.error(
            safeWorkerErrorEvent(
              "run_lease_renewal_failed",
              outcome.error,
              lease.runId,
            ),
          );
          continue;
        case "renewed":
          break;
      }
      const heartbeat = outcome.heartbeat;
      if (!heartbeat.owned) {
        execution.abort(new RunLeaseLostError(lease.runId));
        return;
      }
      const renewedLeaseDeadline =
        renewalStartedAt + this.leaseDurationMs;
      if (Date.now() >= renewedLeaseDeadline) {
        execution.abort(new RunLeaseLostError(lease.runId));
        return;
      }
      leaseDeadline = renewedLeaseDeadline;
      if (heartbeat.cancelRequested) {
        onCancellation();
        execution.abort(new Error("Run cancellation was requested"));
        return;
      }
    }
  }
}
