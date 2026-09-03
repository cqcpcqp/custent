import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentInputItem } from "@openai/agents";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentRunOptions,
  AgentRuntimeEvent,
  AgentRuntimeInput,
} from "@/lib/agent";
import { formatAttachmentReference } from "@/lib/agent/attachment-session";
import type { InputAttachmentMimeType } from "@/lib/contracts";
import type { MessageInputAttachmentRecord } from "@/lib/input-attachments";
import {
  TEST_CAPTURED_RUN_EXECUTION_CONFIG,
  TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
  TEST_RUN_WORKER_CAPABILITY,
} from "@/tests/fixtures/run-config";

import type { ClaimedAgentRun, LeaseHeartbeat } from "./types";

const mocks = vi.hoisted(() => ({
  inputAttachmentDirectory: "",
  persistedItems: [] as AgentInputItem[],
  getSessionItems: vi.fn(),
  getConversationBoundInputAttachmentRecord: vi.fn(),
  getMessageBoundInputAttachmentRecord: vi.fn(),
  readConversationContextSeedItems: vi.fn(),
  readRunSessionSnapshot: vi.fn(),
  materializeRetrySourcePreRunContext: vi.fn(),
  writeRunSessionSnapshot: vi.fn(),
  recoverAbandonedRuns: vi.fn(),
  claimNextRun: vi.fn(),
  appendRunEvent: vi.fn(),
  completeClaimedRun: vi.fn(),
  failClaimedRun: vi.fn(),
  markRunModelStarted: vi.fn(),
  renewRunLease: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  AgentSessionStore: class {
    async getItems(): Promise<AgentInputItem[]> {
      return mocks.getSessionItems();
    }
  },
  getPool: () => ({}),
}));

vi.mock("./session-snapshots", () => ({
  readRunSessionSnapshot: mocks.readRunSessionSnapshot,
  writeRunSessionSnapshot: mocks.writeRunSessionSnapshot,
}));

vi.mock("./conversation-context-seeds", () => ({
  readConversationContextSeedItems: mocks.readConversationContextSeedItems,
}));

vi.mock("./pre-run-context", () => ({
  materializeRetrySourcePreRunContext:
    mocks.materializeRetrySourcePreRunContext,
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    INPUT_ATTACHMENT_DIR: mocks.inputAttachmentDirectory,
  }),
}));

vi.mock("@/lib/input-attachments", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/input-attachments")
  >();
  return {
    ...actual,
    getConversationBoundInputAttachmentRecord:
      mocks.getConversationBoundInputAttachmentRecord,
    getMessageBoundInputAttachmentRecord:
      mocks.getMessageBoundInputAttachmentRecord,
  };
});

vi.mock("./repository", () => {
  class MockRunLeaseLostError extends Error {}
  return {
    RunLeaseLostError: MockRunLeaseLostError,
    appendRunEvent: mocks.appendRunEvent,
    claimNextRun: mocks.claimNextRun,
    completeClaimedRun: mocks.completeClaimedRun,
    failClaimedRun: mocks.failClaimedRun,
    markRunModelStarted: mocks.markRunModelStarted,
    recoverAbandonedRuns: mocks.recoverAbandonedRuns,
    renewRunLease: mocks.renewRunLease,
  };
});

import { RunLeaseLostError } from "./repository";
import { AgentRunWorker } from "./worker";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const CONVERSATION_ID = "30000000-0000-4000-8000-000000000001";
const INPUT_MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const ASSISTANT_MESSAGE_ID = "50000000-0000-4000-8000-000000000001";
const CURRENT_FILE_ID = "60000000-0000-4000-8000-000000000001";
const HISTORY_IMAGE_ID = "70000000-0000-4000-8000-000000000001";
const SOURCE_RUN_ID = "a0000000-0000-4000-8000-000000000001";

function completeEvent(content: string): AgentRuntimeEvent {
  return {
    type: "complete",
    content,
    citations: [],
    artifacts: [],
    usage: {
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    webSearches: 0,
  };
}

function claim(overrides: Partial<ClaimedAgentRun> = {}): ClaimedAgentRun {
  return {
    run: {
      id: RUN_ID,
      requestId: "80000000-0000-4000-8000-000000000001",
      conversationId: CONVERSATION_ID,
      inputMessageId: INPUT_MESSAGE_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      status: "running",
      conversationTurn: "1",
      attemptIndex: 1,
      predecessorRunId: null,
      retryOfRunId: null,
      regenerateOfRunId: null,
      executionConfig: TEST_CAPTURED_RUN_EXECUTION_SUMMARY,
      failure: null,
      createdAt: "2026-08-25T00:00:00.000Z",
      startedAt: "2026-08-25T00:00:01.000Z",
      finishedAt: null,
      cancelRequestedAt: null,
    },
    executionConfig: TEST_CAPTURED_RUN_EXECUTION_CONFIG,
    userId: USER_ID,
    input: "分析当前附件",
    inputAttachmentIds: [],
    customInstructionsSnapshot: null,
    leaseOwner: "90000000-0000-4000-8000-000000000001",
    leaseToken: "1",
    ...overrides,
  };
}

function attachment(input: {
  id: string;
  messageId: string;
  position: number;
  bytes: Buffer;
  kind?: "file" | "image";
  mimeType?: InputAttachmentMimeType;
  originalName?: string;
}): MessageInputAttachmentRecord {
  const kind = input.kind ?? "file";
  return {
    id: input.id,
    userId: USER_ID,
    messageId: input.messageId,
    position: input.position,
    kind,
    originalName:
      input.originalName ?? (kind === "file" ? "buyers.txt" : "factory.png"),
    mimeType:
      input.mimeType ?? (kind === "file" ? "text/plain" : "image/png"),
    sizeBytes: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    storagePath: input.id,
    createdAt: "2026-08-25T00:00:00.000Z",
    attachedAt: "2026-08-25T00:00:01.000Z",
    expiresAt: null,
  };
}

function worker(runtime: {
  run(
    input: AgentRuntimeInput,
    options: AgentRunOptions,
  ): AsyncGenerator<AgentRuntimeEvent>;
}, logger: Pick<Console, "error"> = { error: vi.fn() }): AgentRunWorker {
  return new AgentRunWorker({
    runtimeFactory: {
      capability: TEST_RUN_WORKER_CAPABILITY,
      forRun: vi.fn(() => runtime),
    },
    database: {} as Pool,
    workerId: randomUUID(),
    concurrency: 1,
    pollIntervalMs: 5,
    leaseDurationMs: 10_000,
    recoverAbandoned: false,
    logger,
  });
}

function runtimeWaitingForAbort(input: {
  onStarted: (signal: AbortSignal) => void;
}): {
  run(
    input: AgentRuntimeInput,
    options: AgentRunOptions,
  ): AsyncGenerator<AgentRuntimeEvent>;
} {
  return {
    async *run(_input, options) {
      if (options.signal === undefined) {
        throw new Error("Worker runtime is missing its abort signal");
      }
      input.onStarted(options.signal);
      if (options.signal.aborted) {
        throw options.signal.reason;
      }
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    },
  };
}

function runtimeTranslatingAbort(input: {
  onStarted: (signal: AbortSignal) => void;
}): {
  run(
    input: AgentRuntimeInput,
    options: AgentRunOptions,
  ): AsyncGenerator<AgentRuntimeEvent>;
} {
  return {
    async *run(_input, options) {
      if (options.signal === undefined) {
        throw new Error("Worker runtime is missing its abort signal");
      }
      input.onStarted(options.signal);
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    },
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("AgentRunWorker attachment lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.persistedItems = [];
    mocks.getSessionItems.mockImplementation(async () =>
      structuredClone(mocks.persistedItems),
    );
    mocks.readConversationContextSeedItems.mockResolvedValue(null);
    mocks.readRunSessionSnapshot.mockResolvedValue(null);
    mocks.materializeRetrySourcePreRunContext.mockImplementation(async () => ({
      kind: "available" as const,
      items: structuredClone(mocks.persistedItems),
    }));
    mocks.writeRunSessionSnapshot.mockImplementation(
      async (runId: string, phase: "pre" | "post", items: AgentInputItem[]) => ({
        runId,
        phase,
        items: structuredClone(items),
        createdAt: "2026-08-25T00:00:02.000Z",
      }),
    );
    mocks.inputAttachmentDirectory = await mkdtemp(
      path.join(os.tmpdir(), "custent-worker-attachments-"),
    );
    mocks.completeClaimedRun.mockResolvedValue({ kind: "completed" });
    mocks.failClaimedRun.mockResolvedValue({ status: "failed" });
    mocks.renewRunLease.mockResolvedValue({
      owned: true,
      cancelRequested: false,
    });
  });

  afterEach(async () => {
    await rm(mocks.inputAttachmentDirectory, { recursive: true, force: true });
  });

  it("passes the queued conversation custom-instruction snapshot exactly to the runtime factory", async () => {
    const customInstructionsSnapshot = {
      content: "回答保持简洁，并优先研究德国市场。",
      revision: 9,
    } as const;
    mocks.claimNextRun.mockResolvedValueOnce(
      claim({ customInstructionsSnapshot }),
    );
    const runtime = {
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        yield completeEvent("完成");
      },
    };
    const forRun = vi.fn(() => runtime);
    const runWorker = new AgentRunWorker({
      runtimeFactory: {
        capability: TEST_RUN_WORKER_CAPABILITY,
        forRun,
      },
      database: {} as Pool,
      workerId: randomUUID(),
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 10_000,
      recoverAbandoned: false,
      logger: { error: vi.fn() },
    });

    await expect(runWorker.runOnce()).resolves.toBe(true);

    expect(forRun).toHaveBeenCalledOnce();
    expect(forRun).toHaveBeenCalledWith(
      TEST_CAPTURED_RUN_EXECUTION_CONFIG,
      customInstructionsSnapshot,
    );
  });

  it("uses the copied custom-instruction snapshot for both retry and regeneration claims", async () => {
    const copiedSnapshot = {
      content: "公司清单按国家分组。",
      revision: 6,
    } as const;
    const retryClaim = claim({
      customInstructionsSnapshot: { ...copiedSnapshot },
      run: {
        ...claim().run,
        retryOfRunId: SOURCE_RUN_ID,
      },
    });
    const regenerateClaim = claim({
      customInstructionsSnapshot: { ...copiedSnapshot },
      run: {
        ...claim().run,
        id: "b0000000-0000-4000-8000-000000000001",
        regenerateOfRunId: SOURCE_RUN_ID,
      },
    });
    mocks.claimNextRun
      .mockResolvedValueOnce(retryClaim)
      .mockResolvedValueOnce(regenerateClaim);
    mocks.readRunSessionSnapshot.mockResolvedValue({
      runId: SOURCE_RUN_ID,
      phase: "pre",
      items: [],
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    const runtime = {
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        yield completeEvent("完成");
      },
    };
    const forRun = vi.fn(() => runtime);
    const runWorker = new AgentRunWorker({
      runtimeFactory: {
        capability: TEST_RUN_WORKER_CAPABILITY,
        forRun,
      },
      database: {} as Pool,
      workerId: randomUUID(),
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 10_000,
      recoverAbandoned: false,
      logger: { error: vi.fn() },
    });

    await expect(runWorker.runOnce()).resolves.toBe(true);
    await expect(runWorker.runOnce()).resolves.toBe(true);

    expect(forRun).toHaveBeenCalledTimes(2);
    expect(forRun).toHaveBeenNthCalledWith(
      1,
      retryClaim.executionConfig,
      retryClaim.customInstructionsSnapshot,
    );
    expect(forRun).toHaveBeenNthCalledWith(
      2,
      regenerateClaim.executionConfig,
      regenerateClaim.customInstructionsSnapshot,
    );
  });

  it("persists the exact Code Interpreter lifecycle emitted by the runtime", async () => {
    mocks.claimNextRun.mockResolvedValueOnce(claim());
    mocks.appendRunEvent.mockResolvedValue(undefined);
    mocks.markRunModelStarted.mockResolvedValue(undefined);
    const runtime = {
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        yield {
          type: "code_interpreter_status",
          callId: "python-1",
          phase: "interpreting",
          outputIndex: 1,
          providerSequence: 3,
        };
        yield {
          type: "code_interpreter_code_delta",
          callId: "python-1",
          delta: "print(6)",
          outputIndex: 1,
          providerSequence: 4,
        };
        yield {
          type: "code_interpreter_code_done",
          callId: "python-1",
          code: "print(6)",
          outputIndex: 1,
          providerSequence: 5,
        };
        yield {
          type: "code_interpreter_result",
          callId: "python-1",
          phase: "completed",
          outputIndex: 1,
          providerSequence: 6,
          containerId: "container-1",
          code: "print(6)",
          outputs: [{ type: "logs", logs: "6" }],
        };
        yield completeEvent("计算完成");
      },
    };

    await expect(worker(runtime).runOnce()).resolves.toBe(true);

    expect(
      mocks.appendRunEvent.mock.calls.map((call) => call[1]),
    ).toEqual([
      {
        type: "code_interpreter_status",
        callId: "python-1",
        phase: "interpreting",
        outputIndex: 1,
        providerSequence: 3,
      },
      {
        type: "code_interpreter_code",
        callId: "python-1",
        update: "delta",
        code: "print(6)",
        outputIndex: 1,
        providerSequence: 4,
      },
      {
        type: "code_interpreter_code",
        callId: "python-1",
        update: "done",
        code: "print(6)",
        outputIndex: 1,
        providerSequence: 5,
      },
      {
        type: "code_interpreter_result",
        callId: "python-1",
        phase: "completed",
        outputIndex: 1,
        providerSequence: 6,
        containerId: "container-1",
        code: "print(6)",
        outputs: [{ type: "logs", logs: "6" }],
      },
    ]);
  });

  it("hydrates history and current input, persists attachment activity before model start, then dehydrates the Session", async () => {
    const sequence: string[] = [];
    const currentBytes = Buffer.from("current buyers", "utf8");
    const historyBytes = Buffer.from("historical png bytes", "utf8");
    const current = attachment({
      id: CURRENT_FILE_ID,
      messageId: INPUT_MESSAGE_ID,
      position: 0,
      bytes: currentBytes,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      originalName: "buyers.docx",
    });
    const historical = attachment({
      id: HISTORY_IMAGE_ID,
      messageId: "a0000000-0000-4000-8000-000000000001",
      position: 0,
      bytes: historyBytes,
      kind: "image",
      mimeType: "image/jpeg",
      originalName: "factory.jpeg",
    });
    await Promise.all([
      writeFile(
        path.join(mocks.inputAttachmentDirectory, current.storagePath),
        currentBytes,
      ),
      writeFile(
        path.join(mocks.inputAttachmentDirectory, historical.storagePath),
        historyBytes,
      ),
    ]);
    mocks.persistedItems = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "之前的图片" },
          {
            type: "input_image",
            image: formatAttachmentReference(HISTORY_IMAGE_ID),
            detail: "low",
          },
        ],
      },
    ];
    mocks.readRunSessionSnapshot.mockResolvedValue({
      runId: SOURCE_RUN_ID,
      phase: "post",
      items: structuredClone(mocks.persistedItems),
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    const records = new Map([
      [current.id, current],
      [historical.id, historical],
    ]);
    mocks.getMessageBoundInputAttachmentRecord.mockImplementation(
      async ({ attachmentId, messageId }: { attachmentId: string; messageId: string }) =>
        messageId === INPUT_MESSAGE_ID && attachmentId === CURRENT_FILE_ID
          ? current
          : null,
    );
    mocks.getConversationBoundInputAttachmentRecord.mockImplementation(
      async ({ attachmentId }: { attachmentId: string }) =>
        records.get(attachmentId) ?? null,
    );
    mocks.claimNextRun.mockResolvedValueOnce(
      claim({
        inputAttachmentIds: [CURRENT_FILE_ID],
        run: {
          ...claim().run,
          predecessorRunId: SOURCE_RUN_ID,
          conversationTurn: "2",
        },
      }),
    );
    mocks.appendRunEvent.mockImplementation(async (_lease, payload) => {
      sequence.push(`append:${payload.type}`);
    });
    mocks.markRunModelStarted.mockImplementation(async () => {
      sequence.push("model_started");
    });
    mocks.writeRunSessionSnapshot.mockImplementation(
      async (runId: string, phase: "pre" | "post", items: AgentInputItem[]) => {
        sequence.push(`snapshot:${phase}`);
        return {
          runId,
          phase,
          items: structuredClone(items),
          createdAt: "2026-08-25T00:00:02.000Z",
        };
      },
    );

    const runtime = {
      async *run(
        input: AgentRuntimeInput,
        options: AgentRunOptions,
      ): AsyncGenerator<AgentRuntimeEvent> {
        sequence.push("runtime");
        if (!Array.isArray(input)) {
          throw new TypeError("Worker did not provide AgentInputItem[]");
        }
        await options.session.addItems([
          ...input,
          {
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "完成" }],
          },
        ]);
        yield completeEvent("完成");
      },
    };

    await expect(worker(runtime).runOnce()).resolves.toBe(true);

    expect(sequence).toEqual([
      "snapshot:pre",
      "append:attachment",
      "model_started",
      "runtime",
    ]);
    expect(
      mocks.getMessageBoundInputAttachmentRecord,
    ).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        messageId: INPUT_MESSAGE_ID,
        attachmentId: CURRENT_FILE_ID,
      },
      expect.anything(),
    );
    expect(
      mocks.getConversationBoundInputAttachmentRecord,
    ).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        attachmentId: HISTORY_IMAGE_ID,
      },
      expect.anything(),
    );
    expect(
      mocks.getConversationBoundInputAttachmentRecord,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ attachmentId: CURRENT_FILE_ID }),
      expect.anything(),
    );
    expect(mocks.readRunSessionSnapshot).toHaveBeenCalledWith(
      SOURCE_RUN_ID,
      "post",
      expect.anything(),
    );
    expect(mocks.writeRunSessionSnapshot).toHaveBeenCalledWith(
      RUN_ID,
      "pre",
      mocks.persistedItems,
      expect.anything(),
    );
    expect(mocks.appendRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN_ID }),
      {
        type: "attachment",
        attachment: {
          id: CURRENT_FILE_ID,
          kind: "file",
          name: "buyers.docx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: currentBytes.byteLength,
          downloadUrl: `/api/input-attachments/${CURRENT_FILE_ID}/content`,
          createdAt: current.createdAt,
        },
      },
      expect.anything(),
    );
    expect(mocks.completeClaimedRun).toHaveBeenCalledOnce();
    const completionInput = mocks.completeClaimedRun.mock.calls[0][0];
    expect(JSON.stringify(completionInput.sessionItems)).not.toContain("data:");
    expect(completionInput.sessionItems).toEqual([
      ...mocks.persistedItems,
      {
        role: "user",
        content: [
          { type: "input_text", text: "分析当前附件" },
          {
            type: "input_file",
            file: formatAttachmentReference(CURRENT_FILE_ID),
            filename: "buyers.docx",
          },
        ],
      },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "完成" }],
      },
    ]);
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
  });

  it.each(["missing", "corrupt"] as const)(
    "fails a %s historical attachment before model_started",
    async (failure) => {
      const historicalBytes = Buffer.from("historical bytes", "utf8");
      const historical = attachment({
        id: HISTORY_IMAGE_ID,
        messageId: "a0000000-0000-4000-8000-000000000001",
        position: 0,
        bytes: historicalBytes,
        kind: "image",
      });
      mocks.persistedItems = [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image: formatAttachmentReference(HISTORY_IMAGE_ID),
              detail: "low",
            },
          ],
        },
      ];
      mocks.readRunSessionSnapshot.mockResolvedValue({
        runId: SOURCE_RUN_ID,
        phase: "post",
        items: structuredClone(mocks.persistedItems),
        createdAt: "2026-08-25T00:00:00.000Z",
      });
      mocks.claimNextRun.mockResolvedValueOnce(
        claim({
          run: {
            ...claim().run,
            predecessorRunId: SOURCE_RUN_ID,
            conversationTurn: "2",
          },
        }),
      );

      if (failure === "missing") {
        mocks.getConversationBoundInputAttachmentRecord.mockResolvedValue(null);
      } else {
        mocks.getConversationBoundInputAttachmentRecord.mockResolvedValue(
          historical,
        );
        await writeFile(
          path.join(mocks.inputAttachmentDirectory, historical.storagePath),
          Buffer.from("corrupted bytes!", "utf8"),
        );
      }
      const runtime = {
        async *run(): AsyncGenerator<AgentRuntimeEvent> {
          throw new Error("Runtime must not start");
        },
      };

      await expect(worker(runtime).runOnce()).resolves.toBe(true);

      expect(mocks.writeRunSessionSnapshot).toHaveBeenCalledWith(
        RUN_ID,
        "pre",
        mocks.persistedItems,
        expect.anything(),
      );
      expect(mocks.markRunModelStarted).not.toHaveBeenCalled();
      expect(mocks.appendRunEvent).not.toHaveBeenCalled();
      expect(mocks.completeClaimedRun).not.toHaveBeenCalled();
      expect(mocks.failClaimedRun).toHaveBeenCalledWith(
        {
          lease: expect.objectContaining({ runId: RUN_ID }),
          errorName: "Error",
        },
        expect.anything(),
      );
    },
  );

  it("uses an immutable conversation context seed for a branched root Run", async () => {
    const seedItems: AgentInputItem[] = [
      { role: "user", content: "original question" },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "original answer" }],
      },
    ];
    mocks.readConversationContextSeedItems.mockResolvedValue(
      structuredClone(seedItems),
    );
    mocks.claimNextRun.mockResolvedValueOnce(claim());
    const runtime = {
      async *run(
        _input: AgentRuntimeInput,
        options: AgentRunOptions,
      ): AsyncGenerator<AgentRuntimeEvent> {
        expect(await options.session.getItems()).toEqual(seedItems);
        yield completeEvent("continued answer");
      },
    };

    await expect(worker(runtime).runOnce()).resolves.toBe(true);

    expect(mocks.readConversationContextSeedItems).toHaveBeenCalledWith(
      CONVERSATION_ID,
      expect.anything(),
    );
    expect(mocks.readRunSessionSnapshot).not.toHaveBeenCalled();
    expect(mocks.writeRunSessionSnapshot).toHaveBeenCalledWith(
      RUN_ID,
      "pre",
      seedItems,
      expect.anything(),
    );
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
  });

  it("uses the strictly resolved failed source pre snapshot for retry", async () => {
    const linearItems: AgentInputItem[] = [
      { role: "user", content: "linear base" },
    ];
    mocks.persistedItems = linearItems;
    mocks.materializeRetrySourcePreRunContext.mockResolvedValue({
      kind: "available",
      items: structuredClone(linearItems),
    });
    const retryClaim = claim();
    retryClaim.run.retryOfRunId = SOURCE_RUN_ID;
    mocks.claimNextRun.mockResolvedValueOnce(retryClaim);
    const runtime = {
      async *run(
        _input: AgentRuntimeInput,
        options: AgentRunOptions,
      ): AsyncGenerator<AgentRuntimeEvent> {
        expect(await options.session.getItems()).toEqual(linearItems);
        yield completeEvent("重试完成");
      },
    };

    await expect(worker(runtime).runOnce()).resolves.toBe(true);

    expect(mocks.getSessionItems).not.toHaveBeenCalled();
    expect(mocks.materializeRetrySourcePreRunContext).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        conversationId: CONVERSATION_ID,
        sourceRunId: SOURCE_RUN_ID,
        allowDeferredPredecessor: false,
      },
      expect.anything(),
    );
    expect(mocks.readRunSessionSnapshot).not.toHaveBeenCalled();
    expect(mocks.writeRunSessionSnapshot).toHaveBeenCalledWith(
      RUN_ID,
      "pre",
      linearItems,
      expect.anything(),
    );
    expect(mocks.markRunModelStarted).toHaveBeenCalledOnce();
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
  });

  it("uses the source pre-session snapshot for regeneration and snapshots the same base before model_started", async () => {
    const sequence: string[] = [];
    const globalItems: AgentInputItem[] = [
      { role: "user", content: "unrelated linear session" },
    ];
    const sourceItems: AgentInputItem[] = [
      { role: "user", content: "branch base" },
      {
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "previous branch answer" }],
      },
    ];
    mocks.persistedItems = globalItems;
    mocks.readRunSessionSnapshot.mockResolvedValue({
      runId: SOURCE_RUN_ID,
      phase: "pre",
      items: structuredClone(sourceItems),
      createdAt: "2026-08-25T00:00:00.000Z",
    });
    const regeneratedClaim = claim();
    regeneratedClaim.run.regenerateOfRunId = SOURCE_RUN_ID;
    mocks.claimNextRun.mockResolvedValueOnce(regeneratedClaim);
    mocks.writeRunSessionSnapshot.mockImplementation(
      async (runId: string, phase: "pre" | "post", items: AgentInputItem[]) => {
        sequence.push(`snapshot:${phase}`);
        return {
          runId,
          phase,
          items: structuredClone(items),
          createdAt: "2026-08-25T00:00:02.000Z",
        };
      },
    );
    mocks.markRunModelStarted.mockImplementation(async () => {
      sequence.push("model_started");
    });
    const runtime = {
      async *run(
        _input: AgentRuntimeInput,
        options: AgentRunOptions,
      ): AsyncGenerator<AgentRuntimeEvent> {
        sequence.push("runtime");
        expect(await options.session.getItems()).toEqual(sourceItems);
        yield completeEvent("重新生成完成");
      },
    };

    await expect(worker(runtime).runOnce()).resolves.toBe(true);

    expect(mocks.readRunSessionSnapshot).toHaveBeenCalledWith(
      SOURCE_RUN_ID,
      "pre",
      expect.anything(),
    );
    expect(mocks.getSessionItems).not.toHaveBeenCalled();
    expect(mocks.writeRunSessionSnapshot).toHaveBeenCalledWith(
      RUN_ID,
      "pre",
      sourceItems,
      expect.anything(),
    );
    expect(sequence).toEqual(["snapshot:pre", "model_started", "runtime"]);
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
  });

  it("fails regeneration closed when the source pre-session snapshot is missing", async () => {
    const regeneratedClaim = claim();
    regeneratedClaim.run.regenerateOfRunId = SOURCE_RUN_ID;
    mocks.claimNextRun.mockResolvedValueOnce(regeneratedClaim);
    mocks.readRunSessionSnapshot.mockResolvedValue(null);
    const runtime = {
      run: vi.fn(async function* (): AsyncGenerator<AgentRuntimeEvent> {
        yield completeEvent("must not run");
      }),
    };

    await expect(worker(runtime).runOnce()).resolves.toBe(true);

    expect(mocks.readRunSessionSnapshot).toHaveBeenCalledWith(
      SOURCE_RUN_ID,
      "pre",
      expect.anything(),
    );
    expect(mocks.getSessionItems).not.toHaveBeenCalled();
    expect(mocks.writeRunSessionSnapshot).not.toHaveBeenCalled();
    expect(mocks.markRunModelStarted).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
    expect(mocks.completeClaimedRun).not.toHaveBeenCalled();
    expect(mocks.failClaimedRun).toHaveBeenCalledWith(
      {
        lease: expect.objectContaining({ runId: RUN_ID }),
        errorName: "Error",
      },
      expect.anything(),
    );
  });

  it("redacts exception messages, API keys, prompts, and request bodies from logs", async () => {
    const apiKey = "sk-sensitive-worker-key";
    const prompt = "sensitive buyer research prompt";
    const requestBody = '{"input":"sensitive request body"}';
    const customInstruction = "sensitive custom instruction: call only Alice";
    const logger = { error: vi.fn() };
    mocks.claimNextRun.mockResolvedValueOnce(
      claim({
        customInstructionsSnapshot: {
          content: customInstruction,
          revision: 14,
        },
      }),
    );
    mocks.markRunModelStarted.mockResolvedValue(undefined);
    const runtime = {
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        throw new Error(`${apiKey} ${prompt} ${requestBody}`);
      },
    };

    await expect(worker(runtime, logger).runOnce()).resolves.toBe(true);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith({
      event: "agent_run_execution_failed",
      errorName: "Error",
      runId: RUN_ID,
    });
    const serializedLogs = JSON.stringify(logger.error.mock.calls);
    expect(serializedLogs).not.toContain(apiKey);
    expect(serializedLogs).not.toContain(prompt);
    expect(serializedLogs).not.toContain(requestBody);
    expect(mocks.failClaimedRun).toHaveBeenCalledWith(
      {
        lease: expect.objectContaining({ runId: RUN_ID }),
        errorName: "Error",
      },
      expect.anything(),
    );
    const serializedPersistenceSinks = JSON.stringify({
      events: mocks.appendRunEvent.mock.calls,
      failures: mocks.failClaimedRun.mock.calls,
      completions: mocks.completeClaimedRun.mock.calls,
      sessionSnapshots: mocks.writeRunSessionSnapshot.mock.calls,
      logs: logger.error.mock.calls,
    });
    expect(serializedPersistenceSinks).not.toContain(customInstruction);
  });
});

describe("AgentRunWorker lease heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistedItems = [];
    mocks.getSessionItems.mockResolvedValue([]);
    mocks.readConversationContextSeedItems.mockResolvedValue(null);
    mocks.readRunSessionSnapshot.mockResolvedValue(null);
    mocks.writeRunSessionSnapshot.mockResolvedValue({
      runId: RUN_ID,
      phase: "pre",
      items: [],
      createdAt: "2026-08-25T00:00:02.000Z",
    });
    mocks.claimNextRun.mockResolvedValueOnce(claim());
    mocks.appendRunEvent.mockResolvedValue(undefined);
    mocks.completeClaimedRun.mockResolvedValue({ kind: "completed" });
    mocks.failClaimedRun.mockResolvedValue({ status: "failed" });
    mocks.markRunModelStarted.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts the runtime at the local lease deadline after consecutive renewal failures", async () => {
    vi.useFakeTimers();
    const heartbeatError = new Error("database unavailable");
    const logger = { error: vi.fn() };
    mocks.renewRunLease.mockRejectedValue(heartbeatError);
    const runtimeStarted = deferred<AbortSignal>();
    const runtime = runtimeWaitingForAbort({
      onStarted(signal) {
        runtimeStarted.resolve(signal);
      },
    });
    const leaseWorker = new AgentRunWorker({
      runtimeFactory: {
        capability: TEST_RUN_WORKER_CAPABILITY,
        forRun: vi.fn(() => runtime),
      },
      database: {} as Pool,
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 3_000,
      recoverAbandoned: false,
      logger,
    });
    const runPromise = leaseWorker.runOnce();

    const runtimeSignal = await runtimeStarted.promise;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(runtimeSignal?.aborted).toBe(false);
    expect(mocks.renewRunLease).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await expect(runPromise).resolves.toBe(true);
    expect(runtimeSignal?.aborted).toBe(true);
    expect(runtimeSignal?.reason).toBeInstanceOf(RunLeaseLostError);
    expect(mocks.renewRunLease).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenNthCalledWith(1, {
      event: "run_lease_renewal_failed",
      errorName: "Error",
      runId: RUN_ID,
    });
    expect(logger.error).toHaveBeenNthCalledWith(2, {
      event: "run_lease_renewal_failed",
      errorName: "Error",
      runId: RUN_ID,
    });
    expect(logger.error).toHaveBeenNthCalledWith(3, {
      event: "agent_run_execution_failed",
      errorName: "RunLeaseLostError",
      runId: RUN_ID,
    });
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
    expect(mocks.completeClaimedRun).not.toHaveBeenCalled();
  });

  it("does not abort after one transient renewal failure followed by successful renewals", async () => {
    vi.useFakeTimers();
    const heartbeatError = new Error("temporary database timeout");
    const logger = { error: vi.fn() };
    mocks.renewRunLease
      .mockRejectedValueOnce(heartbeatError)
      .mockResolvedValue({ owned: true, cancelRequested: false });
    const runtimeStarted = deferred<AbortSignal>();
    const runtimeCanFinish = deferred<void>();
    const runtime = {
      async *run(
        _input: AgentRuntimeInput,
        options: AgentRunOptions,
      ): AsyncGenerator<AgentRuntimeEvent> {
        if (options.signal === undefined) {
          throw new Error("Worker runtime is missing its abort signal");
        }
        runtimeStarted.resolve(options.signal);
        await runtimeCanFinish.promise;
        yield completeEvent("完成");
      },
    };
    const leaseWorker = new AgentRunWorker({
      runtimeFactory: {
        capability: TEST_RUN_WORKER_CAPABILITY,
        forRun: vi.fn(() => runtime),
      },
      database: {} as Pool,
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 3_000,
      recoverAbandoned: false,
      logger,
    });
    const runPromise = leaseWorker.runOnce();
    const runtimeSignal = await runtimeStarted.promise;

    await vi.advanceTimersByTimeAsync(4_000);
    expect(runtimeSignal?.aborted).toBe(false);
    expect(mocks.renewRunLease.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith({
      event: "run_lease_renewal_failed",
      errorName: "Error",
      runId: RUN_ID,
    });

    runtimeCanFinish.resolve(undefined);
    await expect(runPromise).resolves.toBe(true);
    expect(runtimeSignal?.aborted).toBe(false);
    expect(mocks.completeClaimedRun).toHaveBeenCalledOnce();
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
  });

  it("aborts at the lease deadline even while the renewal query remains pending", async () => {
    vi.useFakeTimers();
    const pendingRenewal = deferred<LeaseHeartbeat>();
    mocks.renewRunLease.mockReturnValue(pendingRenewal.promise);
    const runtimeStarted = deferred<AbortSignal>();
    const runtime = runtimeWaitingForAbort({
      onStarted(signal) {
        runtimeStarted.resolve(signal);
      },
    });
    const leaseWorker = new AgentRunWorker({
      runtimeFactory: {
        capability: TEST_RUN_WORKER_CAPABILITY,
        forRun: vi.fn(() => runtime),
      },
      database: {} as Pool,
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 3_000,
      recoverAbandoned: false,
      logger: { error: vi.fn() },
    });
    const runPromise = leaseWorker.runOnce();
    const runtimeSignal = await runtimeStarted.promise;

    await vi.advanceTimersByTimeAsync(2_999);
    expect(mocks.renewRunLease).toHaveBeenCalledOnce();
    expect(runtimeSignal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(runPromise).resolves.toBe(true);
    expect(runtimeSignal.aborted).toBe(true);
    expect(runtimeSignal.reason).toBeInstanceOf(RunLeaseLostError);
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
    expect(mocks.completeClaimedRun).not.toHaveBeenCalled();

    pendingRenewal.resolve({ owned: true, cancelRequested: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
  });

  it("does not finalize a lost lease when the runtime translates the abort reason", async () => {
    vi.useFakeTimers();
    mocks.renewRunLease.mockRejectedValue(new Error("database unavailable"));
    const runtimeStarted = deferred<AbortSignal>();
    const runtime = runtimeTranslatingAbort({
      onStarted(signal) {
        runtimeStarted.resolve(signal);
      },
    });
    const leaseWorker = new AgentRunWorker({
      runtimeFactory: {
        capability: TEST_RUN_WORKER_CAPABILITY,
        forRun: vi.fn(() => runtime),
      },
      database: {} as Pool,
      concurrency: 1,
      pollIntervalMs: 5,
      leaseDurationMs: 3_000,
      recoverAbandoned: false,
      logger: { error: vi.fn() },
    });
    const runPromise = leaseWorker.runOnce();
    await runtimeStarted.promise;

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(runPromise).resolves.toBe(true);
    expect(mocks.failClaimedRun).not.toHaveBeenCalled();
    expect(mocks.completeClaimedRun).not.toHaveBeenCalled();
  });
});
