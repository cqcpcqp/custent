import {
  getLogger,
  MemorySession,
  OpenAIResponsesModel,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  RunToolCallOutputItem,
  Runner,
  Usage,
  type AgentInputItem,
  type AgentOutputItem,
  type ModelResponse,
  type ModelRequest,
  type RunStreamEvent,
} from "@openai/agents";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from "@openai/agents/testing";
import { describe, expect, it, vi } from "vitest";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

import type {
  ArtifactSummary,
  CapturedRunExecutionConfig,
} from "@/lib/contracts";
import { TEST_CAPTURED_RUN_EXECUTION_CONFIG } from "@/tests/fixtures/run-config";

import { createForeignTradeAgent } from "./agent";
import {
  AgentRuntime,
  countWebSearches,
  createAgentRuntime,
  createAgentRuntimeCacheKey,
  createAgentRuntimeFactory,
  extractCitations,
  MAX_CACHED_AGENT_RUNTIMES,
} from "./runtime";
import { AGENT_TOOL_NAMES } from "./tools";
import { createSilentOpenAIClient } from "./sharesub-client";
import type {
  AgentContext,
  AgentRuntimeLike,
  AgentRuntimeInput,
  AgentRuntimeEvent,
  AgentToolServices,
} from "./types";

function runtimeInstructionText(runtime: AgentRuntimeLike): string {
  const agent = (runtime as unknown as {
    agent: { instructions: unknown };
  }).agent;
  if (typeof agent.instructions !== "string") {
    throw new TypeError("Agent runtime instructions must be static text");
  }
  return agent.instructions;
}

const context: AgentContext = {
  userId: "user-1",
  conversationId: "conversation-1",
  requestId: "request-1",
  runId: "run-1",
  assistantMessageId: "message-1",
  leaseOwner: "worker-1",
  leaseToken: "1",
};

const artifact: ArtifactSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "buyers.csv",
  mimeType: "text/csv",
  sizeBytes: 128,
  downloadUrl: "/api/artifacts/33333333-3333-4333-8333-333333333333/download",
  createdAt: "2026-08-24T08:01:00.000Z",
};

function createServices(): AgentToolServices {
  return {
    research: {
      listResearch: vi.fn(async () => []),
      saveResearch: vi.fn(async () => {
        throw new Error("not used in this test");
      }),
    },
    artifacts: {
      createCsv: vi.fn(async () => artifact),
      createPdf: vi.fn(async () => ({
        ...artifact,
        name: "buyers.pdf",
        mimeType: "application/pdf" as const,
      })),
      createGenericCsv: vi.fn(async () => artifact),
      createGenericPdf: vi.fn(async () => ({
        ...artifact,
        name: "summary.pdf",
        mimeType: "application/pdf" as const,
      })),
    },
  };
}

async function collect(
  events: AsyncIterable<AgentRuntimeEvent>,
): Promise<AgentRuntimeEvent[]> {
  const collected: AgentRuntimeEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function response(
  output: AgentOutputItem[],
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  },
): ModelResponse {
  return { output, usage: new Usage(usage) };
}

function rawResponsesEvent(event: ResponseStreamEvent): RunStreamEvent {
  return new RunRawModelStreamEvent({
    type: "model",
    event,
    providerData: { rawModelEventSource: "openai-responses" },
  });
}

function runtimeWithEvents(events: RunStreamEvent[]): AgentRuntime {
  const finalResponse = response([assistantMessage("完成。")], {
    requests: 1,
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  });
  const usage = new Usage({
    requests: 1,
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
  });
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
    completed: Promise.resolve(),
    finalOutput: "完成。",
    rawResponses: [finalResponse],
    runContext: { usage },
  };
  const runner = {
    run: vi.fn(async () => stream),
  } as unknown as Runner;

  return new AgentRuntime({
    agent: createForeignTradeAgent({
      model: new ScriptedModel([]),
      services: createServices(),
      codeInterpreterEnabled: false,
      customInstructionsSnapshot: null,
    }),
    runner,
  });
}

function functionToolOutputStreamEvent(
  status: "in_progress" | "completed" | "incomplete",
  output: unknown,
): RunStreamEvent {
  const agent = createForeignTradeAgent({
    model: new ScriptedModel([]),
    services: createServices(),
    codeInterpreterEnabled: false,
    customInstructionsSnapshot: null,
  });

  return new RunItemStreamEvent(
    "tool_output",
    new RunToolCallOutputItem(
      {
        type: "function_call_result",
        name: AGENT_TOOL_NAMES.createCsv,
        callId: "call-cancelled",
        status,
        output: { type: "text", text: String(output) },
      },
      agent,
      output,
    ),
  );
}

function modelRequest(
  modelSettings: ModelRequest["modelSettings"],
): ModelRequest {
  return {
    input: "test input",
    modelSettings,
    tools: [],
    toolsExplicitlyProvided: true,
    outputType: "text",
    handoffs: [],
    tracing: false,
  };
}

function successfulResponsesBody(): Record<string, unknown> {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "test-model",
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  };
}

class WireOpenAIResponsesModel extends OpenAIResponsesModel {
  fetchResponse(request: ModelRequest): Promise<unknown> {
    return this._fetchResponse(request, false);
  }
}

function createResponsesWireHarness(status: 200 | 400 = 200): {
  model: WireOpenAIResponsesModel;
  requestBodies: Record<string, unknown>[];
} {
  const requestBodies: Record<string, unknown>[] = [];
  const client = createSilentOpenAIClient({
    apiKey: "test-key",
    baseURL: "https://provider.example.com/v1",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/responses"
      ) {
        throw new Error(
          `Unexpected fake Responses request: ${request.method} ${request.url}`,
        );
      }
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new TypeError("Responses request body must be an object");
      }
      requestBodies.push(body as Record<string, unknown>);

      if (status === 400) {
        return new Response(
          JSON.stringify({
            error: {
              code: "unsupported_parameter",
              message: "reasoning.mode is not supported",
              param: "reasoning.mode",
              type: "invalid_request_error",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status,
          },
        );
      }
      return new Response(JSON.stringify(successfulResponsesBody()), {
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test",
        },
        status,
      });
    },
  });
  return {
    model: new WireOpenAIResponsesModel(client, "test-model"),
    requestBodies,
  };
}

describe("AgentRuntime", () => {
  it("forces Agents SDK model and tool data redaction", () => {
    const logger = getLogger("custent-agent-runtime-test");
    expect(logger.dontLogModelData).toBe(true);
    expect(logger.dontLogToolData).toBe(true);
  });

  it("isolates runtimes by the complete captured Run configuration", () => {
    const factory = createAgentRuntimeFactory({
      apiKey: "test-key",
      baseURL: TEST_CAPTURED_RUN_EXECUTION_CONFIG.baseUrl,
      provider: TEST_CAPTURED_RUN_EXECUTION_CONFIG.provider,
      reasoningModeCapabilityEnabled: false,
      codeInterpreterCapabilityEnabled: false,
      services: createServices(),
    });
    const proConfig: CapturedRunExecutionConfig = {
      ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
      executionProfileId: "pro_research",
      profileLabel: "Pro 深度研究",
      model: "gpt-5.2-pro",
      reasoningMode: "pro",
      reasoningEffort: "high",
      maxAgentTurns: 16,
    };

    const standardRuntime = factory.forRun(
      TEST_CAPTURED_RUN_EXECUTION_CONFIG,
      null,
    );
    expect(factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, null)).toBe(
      standardRuntime,
    );
    const proRuntime = factory.forRun(proConfig, null);
    expect(proRuntime).not.toBe(standardRuntime);
    expect(factory.forRun(proConfig, null)).toBe(proRuntime);
  });

  it("isolates cached runtimes by custom-instruction content and revision", () => {
    const factory = createAgentRuntimeFactory({
      apiKey: "test-key",
      baseURL: TEST_CAPTURED_RUN_EXECUTION_CONFIG.baseUrl,
      provider: TEST_CAPTURED_RUN_EXECUTION_CONFIG.provider,
      reasoningModeCapabilityEnabled: false,
      codeInterpreterCapabilityEnabled: false,
      services: createServices(),
    });
    const snapshot = { content: "回答保持简洁。", revision: 4 } as const;
    const runtime = factory.forRun(
      TEST_CAPTURED_RUN_EXECUTION_CONFIG,
      snapshot,
    );

    expect(
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, { ...snapshot }),
    ).toBe(runtime);
    expect(
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, {
        content: "回答提供更多细节。",
        revision: 4,
      }),
    ).not.toBe(runtime);
    expect(
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, {
        content: snapshot.content,
        revision: 5,
      }),
    ).not.toBe(runtime);
    expect(factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, null)).not.toBe(
      runtime,
    );
  });

  it("uses only the custom-instruction revision and SHA-256 digest in cache keys", () => {
    const privateMarker = "PRIVATE_CUSTOM_INSTRUCTION_MARKER_8f1c";
    const cacheKey = createAgentRuntimeCacheKey(
      TEST_CAPTURED_RUN_EXECUTION_CONFIG,
      {
        content: privateMarker,
        revision: 19,
      },
    );
    const parsedKey = JSON.parse(cacheKey) as [
      CapturedRunExecutionConfig,
      { contentSha256: string; revision: number },
    ];

    expect(cacheKey).not.toContain(privateMarker);
    expect(parsedKey[0]).toEqual(TEST_CAPTURED_RUN_EXECUTION_CONFIG);
    expect(parsedKey[1]).toEqual({
      revision: 19,
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(
      createAgentRuntimeCacheKey(TEST_CAPTURED_RUN_EXECUTION_CONFIG, {
        content: `${privateMarker}_different`,
        revision: 19,
      }),
    ).not.toBe(cacheKey);
  });

  it("evicts the least recently used runtime at the strict cache limit", () => {
    const factory = createAgentRuntimeFactory({
      apiKey: "test-key",
      baseURL: TEST_CAPTURED_RUN_EXECUTION_CONFIG.baseUrl,
      provider: TEST_CAPTURED_RUN_EXECUTION_CONFIG.provider,
      reasoningModeCapabilityEnabled: false,
      codeInterpreterCapabilityEnabled: false,
      services: createServices(),
    });
    const snapshots = Array.from(
      { length: MAX_CACHED_AGENT_RUNTIMES },
      (_, index) => ({
        content: `cache-entry-${index}`,
        revision: index + 1,
      }),
    );
    const runtimes = snapshots.map((snapshot) =>
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, snapshot),
    );

    expect(
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, snapshots[0]),
    ).toBe(runtimes[0]);

    const overflowSnapshot = {
      content: "cache-overflow-entry",
      revision: MAX_CACHED_AGENT_RUNTIMES + 1,
    };
    const overflowRuntime = factory.forRun(
      TEST_CAPTURED_RUN_EXECUTION_CONFIG,
      overflowSnapshot,
    );

    expect(
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, overflowSnapshot),
    ).toBe(overflowRuntime);
    expect(
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, snapshots[0]),
    ).toBe(runtimes[0]);
    expect(
      factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, snapshots[1]),
    ).not.toBe(runtimes[1]);
  });

  it("does not mix custom instructions across concurrently created runtimes", async () => {
    const factory = createAgentRuntimeFactory({
      apiKey: "test-key",
      baseURL: TEST_CAPTURED_RUN_EXECUTION_CONFIG.baseUrl,
      provider: TEST_CAPTURED_RUN_EXECUTION_CONFIG.provider,
      reasoningModeCapabilityEnabled: false,
      codeInterpreterCapabilityEnabled: false,
      services: createServices(),
    });
    const snapshots = [
      { content: "只研究德国市场。", revision: 10 },
      { content: "只研究法国市场。", revision: 11 },
      { content: "只研究巴西市场。", revision: 12 },
    ] as const;

    const runtimes = await Promise.all(
      snapshots.map(async (snapshot) =>
        factory.forRun(TEST_CAPTURED_RUN_EXECUTION_CONFIG, snapshot),
      ),
    );

    expect(new Set(runtimes).size).toBe(snapshots.length);
    for (const [index, runtime] of runtimes.entries()) {
      const instructions = runtimeInstructionText(runtime);
      expect(instructions).toContain(snapshots[index].content);
      for (const [otherIndex, otherSnapshot] of snapshots.entries()) {
        if (otherIndex !== index) {
          expect(instructions).not.toContain(otherSnapshot.content);
        }
      }
    }
  });

  it("rejects configurations outside the Worker's declared capability", () => {
    const factory = createAgentRuntimeFactory({
      apiKey: "test-key",
      baseURL: TEST_CAPTURED_RUN_EXECUTION_CONFIG.baseUrl,
      provider: TEST_CAPTURED_RUN_EXECUTION_CONFIG.provider,
      reasoningModeCapabilityEnabled: false,
      codeInterpreterCapabilityEnabled: false,
      services: createServices(),
    });

    expect(() =>
      factory.forRun(
        { provenance: "legacy_unknown", snapshotVersion: 0 },
        null,
      ),
    ).toThrow("Legacy Run execution configuration cannot run");
    expect(() =>
      factory.forRun(
        {
          ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
          baseUrl: "https://other-provider.example.com/v1",
        },
        null,
      ),
    ).toThrow("Run execution provider does not match this Worker capability");
    expect(() =>
      factory.forRun(
        {
          ...TEST_CAPTURED_RUN_EXECUTION_CONFIG,
          reasoningModeEnabled: true,
        },
        null,
      ),
    ).toThrow("Run requires reasoning.mode but this Worker cannot provide it");
  });

  it.each(["openai", "sharesub"] as const)(
    "constructs the %s provider with a valid, exclusive client configuration",
    (provider) => {
      expect(() =>
        createAgentRuntime({
          apiKey: "test-key",
          baseURL: "https://provider.example.com",
          model: "test-model",
          provider,
          reasoningModeEnabled: false,
          reasoningMode: "standard",
          codeInterpreterEnabled: false,
          customInstructionsSnapshot: null,
          services: createServices(),
        }),
      ).not.toThrow();
    },
  );

  const structuredRuntimeInput: AgentInputItem[] = [
    {
      role: "user",
      content: [
        { type: "input_text", text: "分析附件" },
        {
          type: "input_file",
          file: "data:text/plain;base64,Y29udGVudA==",
          filename: "buyers.txt",
        },
      ],
    },
  ];
  const runtimeInputs: Array<{
    label: string;
    input: AgentRuntimeInput;
  }> = [
    { label: "string", input: "查找客户" },
    { label: "structured", input: structuredRuntimeInput },
  ];

  it.each(runtimeInputs)(
    "passes $label input through to Runner unchanged",
    async ({ input }) => {
      const finalResponse = response([assistantMessage("完成。")], {
        requests: 1,
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      });
      const stream = {
        async *[Symbol.asyncIterator]() {},
        completed: Promise.resolve(),
        finalOutput: "完成。",
        rawResponses: [finalResponse],
        runContext: {
          usage: new Usage({
            requests: 1,
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 3,
          }),
        },
      };
      const receivedInputs: AgentRuntimeInput[] = [];
      const run = vi.fn(
        async (...runnerArguments: [unknown, AgentRuntimeInput]) => {
          receivedInputs.push(runnerArguments[1]);
          return stream;
        },
      );
      const agent = createForeignTradeAgent({
        model: new ScriptedModel([]),
        services: createServices(),
        codeInterpreterEnabled: false,
        customInstructionsSnapshot: null,
      });
      const runtime = new AgentRuntime({
        agent,
        runner: { run } as unknown as Runner,
      });

      await collect(
        runtime.run(input, {
          context,
          session: new MemorySession({ sessionId: "conversation-1" }),
        }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(receivedInputs[0]).toBe(input);
    },
  );

  it("requests exact web-search sources without enabling raw provider persistence", () => {
    const agent = createForeignTradeAgent({
      model: new ScriptedModel([]),
      services: createServices(),
      codeInterpreterEnabled: false,
      customInstructionsSnapshot: null,
    });

    expect(agent.modelSettings).toEqual({
      retry: { maxRetries: 0 },
      reasoning: { summary: "auto" },
      providerData: {
        include: ["web_search_call.action.sources"],
      },
    });
  });

  it("omits reasoning.mode from the wire when the provider capability is disabled", async () => {
    const agent = createForeignTradeAgent({
      model: new ScriptedModel([]),
      services: createServices(),
      codeInterpreterEnabled: false,
      customInstructionsSnapshot: null,
      reasoningEffort: "medium",
    });

    expect(agent.modelSettings.reasoning).toEqual({
      effort: "medium",
      summary: "auto",
    });
    expect(agent.modelSettings.reasoning).not.toHaveProperty("mode");
    const wire = createResponsesWireHarness();
    await wire.model.fetchResponse(modelRequest(agent.modelSettings));
    expect(wire.requestBodies).toHaveLength(1);
    expect(wire.requestBodies[0].reasoning).toEqual({
      effort: "medium",
      summary: "auto",
    });
    expect(wire.requestBodies[0].reasoning).not.toHaveProperty("mode");
  });

  it("sends the exact captured reasoning.mode on the wire when enabled", async () => {
    const agent = createForeignTradeAgent({
      model: new ScriptedModel([]),
      services: createServices(),
      codeInterpreterEnabled: false,
      customInstructionsSnapshot: null,
      reasoningMode: "pro",
      reasoningEffort: "high",
    });

    expect(agent.modelSettings.reasoning).toEqual({
      mode: "pro",
      effort: "high",
      summary: "auto",
    });
    const wire = createResponsesWireHarness();
    await wire.model.fetchResponse(modelRequest(agent.modelSettings));
    expect(wire.requestBodies).toHaveLength(1);
    expect(wire.requestBodies[0].reasoning).toEqual({
      mode: "pro",
      effort: "high",
      summary: "auto",
    });
  });

  it("does not retry or downgrade a rejected reasoning.mode request", async () => {
    const agent = createForeignTradeAgent({
      model: new ScriptedModel([]),
      services: createServices(),
      codeInterpreterEnabled: false,
      customInstructionsSnapshot: null,
      reasoningMode: "pro",
      reasoningEffort: "high",
    });
    const wire = createResponsesWireHarness(400);

    await expect(
      wire.model.fetchResponse(modelRequest(agent.modelSettings)),
    ).rejects.toMatchObject({ status: 400 });
    expect(wire.requestBodies).toHaveLength(1);
    expect(wire.requestBodies[0].reasoning).toEqual({
      mode: "pro",
      effort: "high",
      summary: "auto",
    });
  });

  it("streams status, text, artifact, and aggregate completion data", async () => {
    const services = createServices();
    const model = new ScriptedModel([
      response(
        [
          functionCall(
            AGENT_TOOL_NAMES.createCsv,
            {
              snapshotId: "11111111-1111-4111-8111-111111111111",
              fileName: "buyers.csv",
            },
            { callId: "call-csv" },
          ),
        ],
        {
          requests: 1,
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
        },
      ),
      response([assistantMessage("CSV 已生成。")], {
        requests: 1,
        inputTokens: 20,
        outputTokens: 6,
        totalTokens: 26,
      }),
    ]);
    const agent = createForeignTradeAgent({
      model,
      services,
      codeInterpreterEnabled: false,
      customInstructionsSnapshot: null,
    });
    const runtime = new AgentRuntime({
      agent,
      runner: new Runner({ tracingDisabled: true }),
    });

    const events = await collect(
      runtime.run("导出 CSV", {
        context,
        session: new MemorySession({ sessionId: "conversation-1" }),
      }),
    );

    expect(events).toContainEqual({
      type: "status",
      phase: "thinking",
      message: "正在理解需求并规划研究步骤…",
    });
    expect(events).toContainEqual({
      type: "status",
      phase: "rendering",
      message: "正在生成研究文件…",
    });
    expect(events).toContainEqual({
      type: "tool_called",
      callId: "call-csv",
      toolName: AGENT_TOOL_NAMES.createCsv,
      input: {
        snapshotId: "11111111-1111-4111-8111-111111111111",
        fileName: "buyers.csv",
      },
    });
    expect(events).toContainEqual({
      type: "tool_output",
      callId: "call-csv",
      toolName: AGENT_TOOL_NAMES.createCsv,
      output: artifact,
    });
    expect(events).toContainEqual({ type: "artifact", artifact });
    expect(events).toContainEqual({ type: "delta", text: "CSV 已生成。" });
    expect(events.at(-1)).toEqual({
      type: "complete",
      content: "CSV 已生成。",
      citations: [],
      artifacts: [artifact],
      usage: {
        requests: 2,
        inputTokens: 32,
        outputTokens: 10,
        totalTokens: 42,
      },
      webSearches: 0,
    });
    expect(services.artifacts.createCsv).toHaveBeenCalledWith(
      {
        snapshotId: "11111111-1111-4111-8111-111111111111",
        fileName: "buyers.csv",
      },
      context,
    );
    model.assertComplete();
  });

  it("streams strict generic CSV calls as visible activity and artifacts", async () => {
    const services = createServices();
    const input = {
      fileName: "current-table.csv",
      columns: ["company", "country"],
      rows: [["Acme", "Germany"]],
    };
    const model = new ScriptedModel([
      response(
        [
          functionCall(AGENT_TOOL_NAMES.createGenericCsv, input, {
            callId: "call-generic-csv",
          }),
        ],
        { requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ),
      response([assistantMessage("当前表格已生成 CSV。")], {
        requests: 1,
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
      }),
    ]);
    const runtime = new AgentRuntime({
      agent: createForeignTradeAgent({
        model,
        services,
        codeInterpreterEnabled: false,
        customInstructionsSnapshot: null,
      }),
      runner: new Runner({ tracingDisabled: true }),
    });

    const events = await collect(
      runtime.run("把刚才的表格生成 CSV", {
        context,
        session: new MemorySession({ sessionId: "conversation-1" }),
      }),
    );

    expect(events).toContainEqual({
      type: "tool_called",
      callId: "call-generic-csv",
      toolName: AGENT_TOOL_NAMES.createGenericCsv,
      input,
    });
    expect(events).toContainEqual({
      type: "tool_output",
      callId: "call-generic-csv",
      toolName: AGENT_TOOL_NAMES.createGenericCsv,
      output: artifact,
    });
    expect(events).toContainEqual({ type: "artifact", artifact });
    expect(services.artifacts.createGenericCsv).toHaveBeenCalledWith(
      input,
      context,
    );
    model.assertComplete();
  });

  it("maps only reasoning summaries and exact hosted web-search phases", async () => {
    const runtime = runtimeWithEvents([
      rawResponsesEvent({
        type: "response.reasoning_summary_text.delta",
        item_id: "reasoning-1",
        output_index: 0,
        summary_index: 1,
        delta: "正在比较渠道覆盖与集中风险。",
        sequence_number: 4,
      }),
      rawResponsesEvent({
        type: "response.reasoning_text.delta",
        item_id: "reasoning-1",
        output_index: 0,
        content_index: 0,
        delta: "不得公开的原始思维链",
        sequence_number: 5,
      }),
      rawResponsesEvent({
        type: "response.web_search_call.in_progress",
        item_id: "search-1",
        output_index: 1,
        sequence_number: 6,
      }),
      rawResponsesEvent({
        type: "response.web_search_call.searching",
        item_id: "search-1",
        output_index: 1,
        sequence_number: 7,
      }),
      rawResponsesEvent({
        type: "response.web_search_call.completed",
        item_id: "search-1",
        output_index: 1,
        sequence_number: 8,
      }),
      rawResponsesEvent({
        type: "response.output_item.done",
        output_index: 1,
        sequence_number: 9,
        item: {
          id: "search-1",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "search",
            query: "German industrial valve distributors",
            queries: ["German industrial valve distributors"],
            sources: [
              { type: "url", url: "https://example.com/distributors" },
            ],
          },
        },
      }),
      rawResponsesEvent({
        type: "response.output_item.done",
        output_index: 2,
        sequence_number: 10,
        item: {
          id: "search-2",
          type: "web_search_call",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://example.com/distributors",
          },
        },
      }),
      rawResponsesEvent({
        type: "response.output_item.done",
        output_index: 3,
        sequence_number: 11,
        item: {
          id: "search-3",
          type: "web_search_call",
          status: "failed",
          action: {
            type: "find_in_page",
            url: "https://example.com/distributors",
            pattern: "valve",
          },
        },
      }),
    ]);

    const events = await collect(
      runtime.run("查找客户", {
        context,
        session: new MemorySession({ sessionId: "conversation-1" }),
      }),
    );

    expect(events).toContainEqual({
      type: "reasoning_delta",
      itemId: "reasoning-1",
      summaryIndex: 1,
      delta: "正在比较渠道覆盖与集中风险。",
      providerSequence: 4,
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ delta: "不得公开的原始思维链" }),
    );
    expect(events).toContainEqual({
      type: "status",
      phase: "searching",
      message: "正在检索并核验公开来源…",
    });
    expect(
      events.filter((event) => event.type === "web_search_status"),
    ).toEqual([
      {
        type: "web_search_status",
        callId: "search-1",
        phase: "in_progress",
        outputIndex: 1,
        providerSequence: 6,
        action: null,
      },
      {
        type: "web_search_status",
        callId: "search-1",
        phase: "searching",
        outputIndex: 1,
        providerSequence: 7,
        action: null,
      },
      {
        type: "web_search_status",
        callId: "search-1",
        phase: "completed",
        outputIndex: 1,
        providerSequence: 8,
        action: null,
      },
      {
        type: "web_search_status",
        callId: "search-1",
        phase: "completed",
        outputIndex: 1,
        providerSequence: 9,
        action: {
          type: "search",
          query: "German industrial valve distributors",
          queries: ["German industrial valve distributors"],
          sources: [
            { type: "url", url: "https://example.com/distributors" },
          ],
        },
      },
      {
        type: "web_search_status",
        callId: "search-2",
        phase: "completed",
        outputIndex: 2,
        providerSequence: 10,
        action: {
          type: "open_page",
          url: "https://example.com/distributors",
        },
      },
      {
        type: "web_search_status",
        callId: "search-3",
        phase: "failed",
        outputIndex: 3,
        providerSequence: 11,
        action: {
          type: "find_in_page",
          url: "https://example.com/distributors",
          pattern: "valve",
        },
      },
    ]);
  });

  it("maps exact hosted Code Interpreter code, phases, logs, and images", async () => {
    const runtime = runtimeWithEvents([
      rawResponsesEvent({
        type: "response.code_interpreter_call.in_progress",
        item_id: "python-1",
        output_index: 2,
        sequence_number: 20,
      }),
      rawResponsesEvent({
        type: "response.code_interpreter_call_code.delta",
        item_id: "python-1",
        output_index: 2,
        sequence_number: 21,
        delta: "values = [1, 2, 3]\\n",
      }),
      rawResponsesEvent({
        type: "response.code_interpreter_call_code.done",
        item_id: "python-1",
        output_index: 2,
        sequence_number: 22,
        code: "values = [1, 2, 3]\\nprint(sum(values))",
      }),
      rawResponsesEvent({
        type: "response.code_interpreter_call.interpreting",
        item_id: "python-1",
        output_index: 2,
        sequence_number: 23,
      }),
      rawResponsesEvent({
        type: "response.code_interpreter_call.completed",
        item_id: "python-1",
        output_index: 2,
        sequence_number: 24,
      }),
      rawResponsesEvent({
        type: "response.output_item.done",
        output_index: 2,
        sequence_number: 25,
        item: {
          id: "python-1",
          type: "code_interpreter_call",
          code: "values = [1, 2, 3]\\nprint(sum(values))",
          container_id: "container-1",
          outputs: [
            { type: "logs", logs: "6" },
            { type: "image", url: "https://example.com/chart.png" },
          ],
          status: "completed",
        },
      }),
    ]);

    const events = await collect(
      runtime.run("计算并绘图", {
        context,
        session: new MemorySession({ sessionId: "conversation-1" }),
      }),
    );

    expect(events).toContainEqual({
      type: "status",
      phase: "coding",
      message: "正在运行 Python 并核验结果…",
    });
    expect(
      events.filter(
        (event) =>
          event.type === "code_interpreter_status" ||
          event.type === "code_interpreter_code_delta" ||
          event.type === "code_interpreter_code_done" ||
          event.type === "code_interpreter_result",
      ),
    ).toEqual([
      {
        type: "code_interpreter_status",
        callId: "python-1",
        phase: "in_progress",
        outputIndex: 2,
        providerSequence: 20,
      },
      {
        type: "code_interpreter_code_delta",
        callId: "python-1",
        delta: "values = [1, 2, 3]\\n",
        outputIndex: 2,
        providerSequence: 21,
      },
      {
        type: "code_interpreter_code_done",
        callId: "python-1",
        code: "values = [1, 2, 3]\\nprint(sum(values))",
        outputIndex: 2,
        providerSequence: 22,
      },
      {
        type: "code_interpreter_status",
        callId: "python-1",
        phase: "interpreting",
        outputIndex: 2,
        providerSequence: 23,
      },
      {
        type: "code_interpreter_status",
        callId: "python-1",
        phase: "completed",
        outputIndex: 2,
        providerSequence: 24,
      },
      {
        type: "code_interpreter_result",
        callId: "python-1",
        phase: "completed",
        outputIndex: 2,
        providerSequence: 25,
        containerId: "container-1",
        code: "values = [1, 2, 3]\\nprint(sum(values))",
        outputs: [
          { type: "logs", logs: "6" },
          { type: "image", url: "https://example.com/chart.png" },
        ],
      },
    ]);
  });

  it("does not parse an incomplete function-call result as business output", async () => {
    const events = await collect(
      runtimeWithEvents([
        functionToolOutputStreamEvent("incomplete", "aborted"),
      ]).run("取消导出", {
        context,
        session: new MemorySession({ sessionId: "conversation-1" }),
      }),
    );

    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "tool_output" }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "artifact" }),
    );
  });

  it("rejects an in-progress function result emitted as tool output", async () => {
    await expect(
      collect(
        runtimeWithEvents([
          functionToolOutputStreamEvent("in_progress", "pending"),
        ]).run("导出", {
          context,
          session: new MemorySession({ sessionId: "conversation-1" }),
        }),
      ),
    ).rejects.toThrow(
      "Function tool create_csv emitted an in-progress output",
    );
  });

  it("strictly maps list and save research tool inputs and outputs", async () => {
    const snapshot = {
      id: "44444444-4444-4444-8444-444444444444",
      title: "德国阀门经销商",
      querySummary: "德国工业阀门经销商",
      companyCount: 1,
      createdAt: "2026-08-24T09:00:00.000Z",
    };
    const saveInput = {
      title: snapshot.title,
      querySummary: snapshot.querySummary,
      limitations: "仅覆盖公开网页。",
      companies: [
        {
          name: "Example GmbH",
          websiteUrl: "https://example.com",
          country: "Germany",
          companyType: "distributor" as const,
          relevanceSummary: "公开页面显示其经销工业阀门。",
          contacts: [],
          evidence: [
            {
              claim: "该公司经销工业阀门。",
              sourceUrl: "https://example.com/valves",
              sourceTitle: "Industrial valves",
              supports: "business_fit" as const,
            },
          ],
        },
      ],
    };
    const services = createServices();
    services.research.listResearch = vi.fn(async () => [snapshot]);
    services.research.saveResearch = vi.fn(async () => snapshot);
    const model = new ScriptedModel([
      response(
        [
          functionCall(
            AGENT_TOOL_NAMES.listResearch,
            {},
            { callId: "call-list" },
          ),
        ],
        { requests: 1, inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      ),
      response(
        [
          functionCall(AGENT_TOOL_NAMES.saveResearch, saveInput, {
            callId: "call-save",
          }),
        ],
        { requests: 1, inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      ),
      response([assistantMessage("研究已保存。")], {
        requests: 1,
        inputTokens: 6,
        outputTokens: 3,
        totalTokens: 9,
      }),
    ]);
    const runtime = new AgentRuntime({
      agent: createForeignTradeAgent({
        model,
        services,
        codeInterpreterEnabled: false,
        customInstructionsSnapshot: null,
      }),
      runner: new Runner({ tracingDisabled: true }),
    });

    const events = await collect(
      runtime.run("保存研究", {
        context,
        session: new MemorySession({ sessionId: "conversation-1" }),
      }),
    );

    expect(events).toContainEqual({
      type: "tool_called",
      callId: "call-list",
      toolName: AGENT_TOOL_NAMES.listResearch,
      input: {},
    });
    expect(events).toContainEqual({
      type: "tool_output",
      callId: "call-list",
      toolName: AGENT_TOOL_NAMES.listResearch,
      output: [snapshot],
    });
    expect(events).toContainEqual({
      type: "tool_called",
      callId: "call-save",
      toolName: AGENT_TOOL_NAMES.saveResearch,
      input: saveInput,
    });
    expect(events).toContainEqual({
      type: "tool_output",
      callId: "call-save",
      toolName: AGENT_TOOL_NAMES.saveResearch,
      output: snapshot,
    });
    expect(services.research.listResearch).toHaveBeenCalledWith(context);
    expect(services.research.saveResearch).toHaveBeenCalledWith(
      saveInput,
      context,
    );
    model.assertComplete();
  });

  it("maps exact URL annotations from only the final response", async () => {
    const earlierMessage = assistantMessage("Earlier answer");
    earlierMessage.content[0].providerData = {
      annotations: [
        {
          type: "url_citation",
          url: "https://old.example.com",
          title: "Old source",
          start_index: 0,
          end_index: 7,
        },
      ],
    };
    const finalMessage = assistantMessage("Acme imports pumps");
    finalMessage.content[0].providerData = {
      annotations: [
        {
          type: "url_citation",
          url: "https://example.com/source",
          title: "Acme source",
          start_index: 0,
          end_index: 18,
        },
      ],
    };
    const responses = [
      response([earlierMessage], {
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
      response([finalMessage], {
        requests: 1,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
      }),
    ];

    expect(extractCitations(responses)).toEqual([
      {
        url: "https://example.com/source",
        title: "Acme source",
        startIndex: 0,
        endIndex: 18,
      },
    ]);
  });

  it("extracts final citations for a normalized hosted web search", async () => {
    const finalMessage = assistantMessage("Acme imports pumps");
    finalMessage.content[0].providerData = {
      annotations: [
        {
          type: "url_citation",
          url: "https://example.com/source",
          title: "Acme source",
          start_index: 0,
          end_index: 18,
        },
      ],
    };
    const model = new ScriptedModel([
      response(
        [
          {
            type: "hosted_tool_call",
            name: AGENT_TOOL_NAMES.webSearchCall,
            id: "search-1",
            status: "completed",
            providerData: { type: "web_search_call" },
          },
          finalMessage,
        ],
        {
          requests: 1,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      ),
    ]);
    const runtime = new AgentRuntime({
      agent: createForeignTradeAgent({
        model,
        services: createServices(),
        codeInterpreterEnabled: false,
        customInstructionsSnapshot: null,
      }),
      runner: new Runner({ tracingDisabled: true }),
    });

    const events = await collect(
      runtime.run("查找买家", {
        context,
        session: new MemorySession({ sessionId: "conversation-1" }),
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "complete",
      content: "Acme imports pumps",
      citations: [
        {
          url: "https://example.com/source",
          title: "Acme source",
          startIndex: 0,
          endIndex: 18,
        },
      ],
      webSearches: 1,
    });
    model.assertComplete();
  });

  it("counts each normalized web search call across all model responses", () => {
    const searchCall: AgentOutputItem = {
      type: "hosted_tool_call",
      name: AGENT_TOOL_NAMES.webSearchCall,
      id: "search-1",
      status: "completed",
      providerData: { type: "web_search_call" },
    };
    const otherHostedCall: AgentOutputItem = {
      type: "hosted_tool_call",
      name: "file_search_call",
      id: "search-2",
      status: "completed",
    };

    expect(
      countWebSearches([
        response([searchCall, otherHostedCall], {
          requests: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
        response([{ ...searchCall, id: "search-3" }], {
          requests: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        }),
      ]),
    ).toBe(2);
  });
});
