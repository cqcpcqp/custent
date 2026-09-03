import { createHash } from "node:crypto";

import {
  type Agent,
  isOpenAIResponsesRawModelStreamEvent,
  type ModelResponse,
  OpenAIProvider,
  type RunToolCallItem,
  type RunToolCallOutputItem,
  Runner,
  setSensitiveDataLoggingEnabled,
} from "@openai/agents";
import { z } from "zod";

import {
  ArtifactSummarySchema,
  CitationSchema,
  CodeInterpreterOutputSchema,
  type ArtifactSummary,
  type Citation,
  type WebSearchAction,
} from "@/lib/contracts";
import {
  RunExecutionConfigSchema,
  RunWorkerCapabilitySchema,
  type CapturedRunExecutionConfig,
} from "@/lib/contracts";
import {
  GenericCsvArtifactRequestSchema,
  GenericPdfArtifactRequestSchema,
} from "@/lib/artifacts";
import {
  ResearchSnapshotSummarySchema,
  SaveResearchInputSchema,
} from "@/lib/domain/research";

import { createForeignTradeAgent } from "./agent";
import {
  createShareSubOpenAIClient,
  createSilentOpenAIClient,
} from "./sharesub-client";
import {
  AGENT_TOOL_NAMES,
  ArtifactParametersSchema,
  EmptyParametersSchema,
} from "./tools";
import type {
  AgentContext,
  AgentRunOptions,
  AgentRuntimeInput,
  AgentRuntimeEvent,
  AgentStatusPhase,
  AgentToolServices,
  AgentRuntimeFactory,
  ConversationCustomInstructionsSnapshot,
} from "./types";

setSensitiveDataLoggingEnabled(false);

const UrlCitationAnnotationSchema = z.object({
  type: z.literal("url_citation"),
  url: z.string().url(),
  title: z.string(),
  start_index: z.number().int().nonnegative(),
  end_index: z.number().int().nonnegative(),
});

const OpenAIWebSearchSourceSchema = z
  .object({
    type: z.literal("url"),
    url: z.string().url(),
  })
  .strict();

const OpenAIWebSearchActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("search"),
      query: z.string().optional(),
      queries: z.array(z.string()).optional(),
      sources: z.array(OpenAIWebSearchSourceSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("open_page"),
      url: z.string().url().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("find_in_page"),
      url: z.string().url(),
      pattern: z.string(),
    })
    .strict(),
]);

const OpenAICompletedWebSearchItemSchema = z
  .object({
    id: z.string(),
    type: z.literal("web_search_call"),
    status: z.enum(["completed", "failed"]),
    action: OpenAIWebSearchActionSchema,
  })
  .strict();

const OpenAICodeInterpreterItemSchema = z
  .object({
    id: z.string(),
    type: z.literal("code_interpreter_call"),
    code: z.string().nullable(),
    container_id: z.string(),
    outputs: z.array(CodeInterpreterOutputSchema).nullable(),
    status: z.enum([
      "in_progress",
      "completed",
      "incomplete",
      "interpreting",
      "failed",
    ]),
  })
  .strict();

function normalizeWebSearchAction(
  action: z.infer<typeof OpenAIWebSearchActionSchema>,
): WebSearchAction {
  switch (action.type) {
    case "search":
      return {
        type: "search",
        query: action.query ?? null,
        queries: action.queries ?? [],
        sources: action.sources ?? [],
      };
    case "open_page":
      return {
        type: "open_page",
        url: action.url ?? null,
      };
    case "find_in_page":
      return action;
  }
}

const STATUS_MESSAGES: Record<AgentStatusPhase, string> = {
  thinking: "正在理解需求并规划研究步骤…",
  searching: "正在检索并核验公开来源…",
  coding: "正在运行 Python 并核验结果…",
  saving: "正在保存结构化研究结果…",
  rendering: "正在生成研究文件…",
};

export const MAX_AGENT_TURNS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusEvent(phase: AgentStatusPhase): AgentRuntimeEvent {
  return {
    type: "status",
    phase,
    message: STATUS_MESSAGES[phase],
  };
}

function phaseForToolCall(item: RunToolCallItem): AgentStatusPhase | undefined {
  switch (item.toolName) {
    case AGENT_TOOL_NAMES.saveResearch:
      return "saving";
    case AGENT_TOOL_NAMES.createCsv:
    case AGENT_TOOL_NAMES.createPdf:
    case AGENT_TOOL_NAMES.createGenericCsv:
    case AGENT_TOOL_NAMES.createGenericPdf:
      return "rendering";
    default:
      return undefined;
  }
}

function toolCalledEvent(
  item: RunToolCallItem,
): Extract<AgentRuntimeEvent, { type: "tool_called" }> | undefined {
  if (item.rawItem.type !== "function_call") {
    return undefined;
  }

  const base = { type: "tool_called" as const, callId: item.rawItem.callId };
  const input: unknown = JSON.parse(item.rawItem.arguments);

  switch (item.rawItem.name) {
    case AGENT_TOOL_NAMES.listResearch:
      return {
        ...base,
        toolName: AGENT_TOOL_NAMES.listResearch,
        input: EmptyParametersSchema.parse(input),
      };
    case AGENT_TOOL_NAMES.saveResearch:
      return {
        ...base,
        toolName: AGENT_TOOL_NAMES.saveResearch,
        input: SaveResearchInputSchema.parse(input),
      };
    case AGENT_TOOL_NAMES.createCsv:
    case AGENT_TOOL_NAMES.createPdf:
      return {
        ...base,
        toolName: item.rawItem.name,
        input: ArtifactParametersSchema.parse(input),
      };
    case AGENT_TOOL_NAMES.createGenericCsv:
      return {
        ...base,
        toolName: item.rawItem.name,
        input: GenericCsvArtifactRequestSchema.parse(input),
      };
    case AGENT_TOOL_NAMES.createGenericPdf:
      return {
        ...base,
        toolName: item.rawItem.name,
        input: GenericPdfArtifactRequestSchema.parse(input),
      };
    default:
      throw new Error(`Unexpected function tool ${item.rawItem.name}`);
  }
}

function toolOutputEvent(
  item: RunToolCallOutputItem,
): Extract<AgentRuntimeEvent, { type: "tool_output" }> | undefined {
  if (item.rawItem.type !== "function_call_result") {
    return undefined;
  }

  switch (item.rawItem.status) {
    case "incomplete":
      return undefined;
    case "in_progress":
      throw new TypeError(
        `Function tool ${item.rawItem.name} emitted an in-progress output`,
      );
    case "completed":
      break;
  }

  const base = {
    type: "tool_output" as const,
    callId: item.rawItem.callId,
  };

  switch (item.rawItem.name) {
    case AGENT_TOOL_NAMES.listResearch:
      return {
        ...base,
        toolName: AGENT_TOOL_NAMES.listResearch,
        output: z.array(ResearchSnapshotSummarySchema).parse(item.output),
      };
    case AGENT_TOOL_NAMES.saveResearch:
      return {
        ...base,
        toolName: AGENT_TOOL_NAMES.saveResearch,
        output: ResearchSnapshotSummarySchema.parse(item.output),
      };
    case AGENT_TOOL_NAMES.createCsv:
    case AGENT_TOOL_NAMES.createPdf:
    case AGENT_TOOL_NAMES.createGenericCsv:
    case AGENT_TOOL_NAMES.createGenericPdf:
      return {
        ...base,
        toolName: item.rawItem.name,
        output: ArtifactSummarySchema.parse(item.output),
      };
    default:
      throw new Error(`Unexpected function tool ${item.rawItem.name}`);
  }
}

export function countWebSearches(responses: readonly ModelResponse[]): number {
  let count = 0;

  for (const response of responses) {
    for (const item of response.output) {
      if (
        item.type === "hosted_tool_call" &&
        item.name === AGENT_TOOL_NAMES.webSearchCall
      ) {
        count += 1;
      }
    }
  }

  return count;
}

export function extractCitations(
  responses: readonly ModelResponse[],
): Citation[] {
  const lastResponse = responses.at(-1);
  if (lastResponse === undefined) {
    return [];
  }

  const citations: Citation[] = [];
  for (const item of lastResponse.output) {
    if (item.type !== "message" || item.role !== "assistant") {
      continue;
    }

    for (const content of item.content) {
      if (content.type !== "output_text") {
        continue;
      }

      const annotations = content.providerData?.annotations;
      if (annotations === undefined) {
        continue;
      }
      if (!Array.isArray(annotations)) {
        throw new TypeError("output_text annotations must be an array");
      }

      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation") {
          continue;
        }

        const parsed = UrlCitationAnnotationSchema.parse(annotation);
        citations.push(
          CitationSchema.parse({
            url: parsed.url,
            title: parsed.title,
            startIndex: parsed.start_index,
            endIndex: parsed.end_index,
          }),
        );
      }
    }
  }

  return citations;
}

export type AgentRuntimeDependencies = {
  agent: Agent<AgentContext>;
  runner: Runner;
  maxTurns?: number;
};

export class AgentRuntime {
  private readonly agent: Agent<AgentContext>;
  private readonly runner: Runner;
  private readonly maxTurns: number;

  constructor({ agent, runner, maxTurns = MAX_AGENT_TURNS }: AgentRuntimeDependencies) {
    this.agent = agent;
    this.runner = runner;
    this.maxTurns = maxTurns;
  }

  async *run(
    input: AgentRuntimeInput,
    options: AgentRunOptions,
  ): AsyncGenerator<AgentRuntimeEvent> {
    yield statusEvent("thinking");

    const stream = await this.runner.run(this.agent, input, {
      stream: true,
      context: options.context,
      session: options.session,
      signal: options.signal,
      maxTurns: this.maxTurns,
    });
    const artifacts: ArtifactSummary[] = [];

    for await (const event of stream) {
      if (isOpenAIResponsesRawModelStreamEvent(event)) {
        const responseEvent = event.data.event;

        switch (responseEvent.type) {
          case "response.reasoning_summary_text.delta":
            yield {
              type: "reasoning_delta",
              itemId: responseEvent.item_id,
              summaryIndex: responseEvent.summary_index,
              delta: responseEvent.delta,
              providerSequence: responseEvent.sequence_number,
            };
            continue;
          case "response.web_search_call.in_progress":
            yield statusEvent("searching");
            yield {
              type: "web_search_status",
              callId: responseEvent.item_id,
              phase: "in_progress",
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
              action: null,
            };
            continue;
          case "response.web_search_call.searching":
            yield {
              type: "web_search_status",
              callId: responseEvent.item_id,
              phase: "searching",
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
              action: null,
            };
            continue;
          case "response.web_search_call.completed":
            yield {
              type: "web_search_status",
              callId: responseEvent.item_id,
              phase: "completed",
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
              action: null,
            };
            continue;
          case "response.code_interpreter_call.in_progress":
            yield statusEvent("coding");
            yield {
              type: "code_interpreter_status",
              callId: responseEvent.item_id,
              phase: "in_progress",
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
            };
            continue;
          case "response.code_interpreter_call_code.delta":
            yield {
              type: "code_interpreter_code_delta",
              callId: responseEvent.item_id,
              delta: responseEvent.delta,
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
            };
            continue;
          case "response.code_interpreter_call_code.done":
            yield {
              type: "code_interpreter_code_done",
              callId: responseEvent.item_id,
              code: responseEvent.code,
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
            };
            continue;
          case "response.code_interpreter_call.interpreting":
            yield {
              type: "code_interpreter_status",
              callId: responseEvent.item_id,
              phase: "interpreting",
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
            };
            continue;
          case "response.code_interpreter_call.completed":
            yield {
              type: "code_interpreter_status",
              callId: responseEvent.item_id,
              phase: "completed",
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
            };
            continue;
          case "response.output_item.done": {
            if (responseEvent.item.type === "code_interpreter_call") {
              const item = OpenAICodeInterpreterItemSchema.parse(
                responseEvent.item,
              );
              yield {
                type: "code_interpreter_result",
                callId: item.id,
                phase: item.status,
                outputIndex: responseEvent.output_index,
                providerSequence: responseEvent.sequence_number,
                containerId: item.container_id,
                code: item.code,
                outputs: item.outputs,
              };
              continue;
            }
            if (responseEvent.item.type !== "web_search_call") {
              break;
            }
            const item = OpenAICompletedWebSearchItemSchema.parse(
              responseEvent.item,
            );
            yield {
              type: "web_search_status",
              callId: item.id,
              phase: item.status,
              outputIndex: responseEvent.output_index,
              providerSequence: responseEvent.sequence_number,
              action: normalizeWebSearchAction(item.action),
            };
            continue;
          }
        }
      }

      if (
        event.type === "raw_model_stream_event" &&
        event.data.type === "output_text_delta"
      ) {
        yield { type: "delta", text: event.data.delta };
        continue;
      }

      if (event.type !== "run_item_stream_event") {
        continue;
      }

      if (event.name === "tool_called" && event.item.type === "tool_call_item") {
        const phase = phaseForToolCall(event.item);
        if (phase !== undefined) {
          yield statusEvent(phase);
        }
        const toolEvent = toolCalledEvent(event.item);
        if (toolEvent !== undefined) {
          yield toolEvent;
        }
        continue;
      }

      if (
        event.name === "tool_output" &&
        event.item.type === "tool_call_output_item"
      ) {
        const toolEvent = toolOutputEvent(event.item);
        if (toolEvent !== undefined) {
          yield toolEvent;
        }
        if (
          toolEvent?.toolName === AGENT_TOOL_NAMES.createCsv ||
          toolEvent?.toolName === AGENT_TOOL_NAMES.createPdf ||
          toolEvent?.toolName === AGENT_TOOL_NAMES.createGenericCsv ||
          toolEvent?.toolName === AGENT_TOOL_NAMES.createGenericPdf
        ) {
          const artifact = toolEvent.output;
          artifacts.push(artifact);
          yield { type: "artifact", artifact };
        }
      }
    }

    await stream.completed;

    if (typeof stream.finalOutput !== "string") {
      throw new TypeError("Agent run completed without a text final output");
    }

    const usage = stream.runContext.usage;
    yield {
      type: "complete",
      content: stream.finalOutput,
      citations: extractCitations(stream.rawResponses),
      artifacts,
      usage: {
        requests: usage.requests,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      },
      webSearches: countWebSearches(stream.rawResponses),
    };
  }
}

export type CreateAgentRuntimeOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  provider: "openai" | "sharesub";
  reasoningModeEnabled: boolean;
  codeInterpreterEnabled: boolean;
  services: AgentToolServices;
  customInstructionsSnapshot: ConversationCustomInstructionsSnapshot | null;
  reasoningMode: CapturedRunExecutionConfig["reasoningMode"];
  reasoningEffort?: CapturedRunExecutionConfig["reasoningEffort"];
  maxTurns?: number;
};

export function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): AgentRuntime {
  const modelProvider = new OpenAIProvider(
    options.provider === "sharesub"
      ? {
          openAIClient: createShareSubOpenAIClient({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
          }),
          useResponses: true,
          strictFeatureValidation: true,
        }
      : {
          openAIClient: createSilentOpenAIClient({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
          }),
          useResponses: true,
          strictFeatureValidation: true,
        },
  );
  const runner = new Runner({
    modelProvider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: "Foreign Trade Customer Research",
  });
  const agent = createForeignTradeAgent({
    model: options.model,
    services: options.services,
    codeInterpreterEnabled: options.codeInterpreterEnabled,
    customInstructionsSnapshot: options.customInstructionsSnapshot,
    reasoningMode: options.reasoningModeEnabled
      ? options.reasoningMode
      : undefined,
    reasoningEffort: options.reasoningEffort,
  });

  return new AgentRuntime({
    agent,
    runner,
    ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
  });
}

export type CreateAgentRuntimeFactoryOptions = Pick<
  CreateAgentRuntimeOptions,
  "apiKey" | "baseURL" | "provider" | "services"
> & {
  reasoningModeCapabilityEnabled: boolean;
  codeInterpreterCapabilityEnabled: boolean;
};

export const MAX_CACHED_AGENT_RUNTIMES = 32;

export function createAgentRuntimeCacheKey(
  config: CapturedRunExecutionConfig,
  customInstructionsSnapshot: ConversationCustomInstructionsSnapshot | null,
): string {
  return JSON.stringify([
    config,
    customInstructionsSnapshot === null
      ? null
      : {
          revision: customInstructionsSnapshot.revision,
          contentSha256: createHash("sha256")
            .update(customInstructionsSnapshot.content, "utf8")
            .digest("hex"),
        },
  ]);
}

export function createAgentRuntimeFactory(
  options: CreateAgentRuntimeFactoryOptions,
): AgentRuntimeFactory {
  const runtimes = new Map<string, AgentRuntime>();
  const capability = RunWorkerCapabilitySchema.parse({
    provider: options.provider,
    baseUrl: options.baseURL,
    reasoningMode: options.reasoningModeCapabilityEnabled,
    codeInterpreter: options.codeInterpreterCapabilityEnabled,
  });

  return {
    capability,
    forRun(rawConfig, customInstructionsSnapshot) {
      const config = RunExecutionConfigSchema.parse(rawConfig);
      if (config.provenance !== "captured") {
        throw new TypeError("Legacy Run execution configuration cannot run");
      }
      if (
        config.provider !== capability.provider ||
        config.baseUrl !== capability.baseUrl
      ) {
        throw new TypeError(
          "Run execution provider does not match this Worker capability",
        );
      }
      if (
        config.reasoningModeEnabled &&
        !capability.reasoningMode
      ) {
        throw new TypeError(
          "Run requires reasoning.mode but this Worker cannot provide it",
        );
      }
      if (
        config.tools.codeInterpreter &&
        !capability.codeInterpreter
      ) {
        throw new TypeError(
          "Run requires Code Interpreter but this Worker cannot provide it",
        );
      }

      const cacheKey = createAgentRuntimeCacheKey(
        config,
        customInstructionsSnapshot,
      );
      const existing = runtimes.get(cacheKey);
      if (existing !== undefined) {
        runtimes.delete(cacheKey);
        runtimes.set(cacheKey, existing);
        return existing;
      }
      const runtime = createAgentRuntime({
        apiKey: options.apiKey,
        baseURL: capability.baseUrl,
        provider: capability.provider,
        services: options.services,
        customInstructionsSnapshot,
        model: config.model,
        reasoningModeEnabled: config.reasoningModeEnabled,
        codeInterpreterEnabled: config.tools.codeInterpreter,
        reasoningMode: config.reasoningMode,
        reasoningEffort: config.reasoningEffort,
        maxTurns: config.maxAgentTurns,
      });
      if (runtimes.size >= MAX_CACHED_AGENT_RUNTIMES) {
        const leastRecentlyUsedKey = runtimes.keys().next().value;
        if (leastRecentlyUsedKey === undefined) {
          throw new TypeError("Agent Runtime cache size is inconsistent");
        }
        runtimes.delete(leastRecentlyUsedKey);
      }
      runtimes.set(cacheKey, runtime);
      return runtime;
    },
  };
}
