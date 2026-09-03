import {
  codeInterpreterTool,
  type RunContext,
  type Tool,
  tool,
  webSearchTool,
} from "@openai/agents";
import { z } from "zod";

import {
  GenericCsvArtifactRequestSchema,
  GenericPdfArtifactRequestSchema,
  RequestedArtifactFileNameSchema,
} from "@/lib/artifacts";
import { SaveResearchInputSchema } from "@/lib/domain/research";

import type {
  AgentContext,
  AgentToolServices,
  ArtifactToolInput,
} from "./types";

export const AGENT_TOOL_NAMES = {
  webSearch: "web_search",
  webSearchCall: "web_search_call",
  codeInterpreter: "code_interpreter",
  codeInterpreterCall: "code_interpreter_call",
  listResearch: "list_research",
  saveResearch: "save_research_results",
  createCsv: "create_csv",
  createPdf: "create_pdf",
  createGenericCsv: "create_csv_file",
  createGenericPdf: "create_pdf_file",
} as const;

export const EmptyParametersSchema = z.object({}).strict();

export const ArtifactParametersSchema = z.object({
  snapshotId: z.string().uuid(),
  fileName: RequestedArtifactFileNameSchema,
});

export type AgentToolCapabilities = {
  codeInterpreterEnabled: boolean;
};

function requireAgentContext(
  runContext: RunContext<AgentContext> | undefined,
): AgentContext {
  if (runContext === undefined) {
    throw new Error("Agent tool execution requires a run context");
  }

  return runContext.context;
}

async function runAbortable<T>(
  details: { signal?: AbortSignal } | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  details?.signal?.throwIfAborted();
  const result = await operation();
  details?.signal?.throwIfAborted();
  return result;
}

export function createAgentTools(
  services: AgentToolServices,
  capabilities: AgentToolCapabilities,
): Tool<AgentContext>[] {
  const listResearch = tool<
    typeof EmptyParametersSchema,
    AgentContext,
    Awaited<ReturnType<AgentToolServices["research"]["listResearch"]>>
  >({
    name: AGENT_TOOL_NAMES.listResearch,
    description:
      "列出当前会话已经保存的研究快照。用户要求导出或继续已有研究、但没有给出快照 ID 时先调用。",
    parameters: EmptyParametersSchema,
    strict: true,
    errorFunction: null,
    execute: (_input, runContext, details) =>
      runAbortable(details, () =>
        services.research.listResearch(requireAgentContext(runContext)),
      ),
  });

  const saveResearch = tool<
    typeof SaveResearchInputSchema,
    AgentContext,
    Awaited<ReturnType<AgentToolServices["research"]["saveResearch"]>>
  >({
    name: AGENT_TOOL_NAMES.saveResearch,
    description:
      "把已核验的公司、公开联系人和逐条证据保存为结构化研究快照。研究完成后必须调用一次，禁止保存猜测的信息。",
    parameters: SaveResearchInputSchema,
    strict: true,
    errorFunction: null,
    execute: (input, runContext, details) =>
      runAbortable(details, () =>
        services.research.saveResearch(input, requireAgentContext(runContext)),
      ),
  });

  const createCsv = tool<
    typeof ArtifactParametersSchema,
    AgentContext,
    Awaited<ReturnType<AgentToolServices["artifacts"]["createCsv"]>>
  >({
    name: AGENT_TOOL_NAMES.createCsv,
    description:
      "从一个已经保存的研究快照生成 CSV。只能使用真实 snapshotId，fileName 是用户下载时看到的文件名。",
    parameters: ArtifactParametersSchema,
    strict: true,
    errorFunction: null,
    execute: (input, runContext, details) =>
      runAbortable(details, () =>
        services.artifacts.createCsv(input, requireAgentContext(runContext)),
      ),
    customDataExtractor: ({ output }) => ({ artifact: output }),
  });

  const createPdf = tool<
    typeof ArtifactParametersSchema,
    AgentContext,
    Awaited<ReturnType<AgentToolServices["artifacts"]["createPdf"]>>
  >({
    name: AGENT_TOOL_NAMES.createPdf,
    description:
      "从一个已经保存的研究快照生成 PDF。只能使用真实 snapshotId，fileName 是用户下载时看到的文件名。",
    parameters: ArtifactParametersSchema,
    strict: true,
    errorFunction: null,
    execute: (input, runContext, details) =>
      runAbortable(details, () =>
        services.artifacts.createPdf(input, requireAgentContext(runContext)),
      ),
    customDataExtractor: ({ output }) => ({ artifact: output }),
  });

  const createGenericCsv = tool<
    typeof GenericCsvArtifactRequestSchema,
    AgentContext,
    Awaited<ReturnType<AgentToolServices["artifacts"]["createGenericCsv"]>>
  >({
    name: AGENT_TOOL_NAMES.createGenericCsv,
    description:
      "把当前对话中已经明确的任意表格直接生成 CSV，不需要研究快照。columns 是唯一列名；每个 rows 元素的单元格数量必须与 columns 完全相同；所有值都使用字符串。",
    parameters: GenericCsvArtifactRequestSchema,
    strict: true,
    errorFunction: null,
    execute: (input, runContext, details) =>
      runAbortable(details, () =>
        services.artifacts.createGenericCsv(
          input,
          requireAgentContext(runContext),
        ),
      ),
    customDataExtractor: ({ output }) => ({ artifact: output }),
  });

  const createGenericPdf = tool<
    typeof GenericPdfArtifactRequestSchema,
    AgentContext,
    Awaited<ReturnType<AgentToolServices["artifacts"]["createGenericPdf"]>>
  >({
    name: AGENT_TOOL_NAMES.createGenericPdf,
    description:
      "把当前对话中已经明确的任意文字内容直接生成 PDF，不需要研究快照。按 sections 组织正文；某段不需要小标题时 heading 传空字符串。",
    parameters: GenericPdfArtifactRequestSchema,
    strict: true,
    errorFunction: null,
    execute: (input, runContext, details) =>
      runAbortable(details, () =>
        services.artifacts.createGenericPdf(
          input,
          requireAgentContext(runContext),
        ),
      ),
    customDataExtractor: ({ output }) => ({ artifact: output }),
  });

  const hostedTools: Tool<AgentContext>[] = [webSearchTool()];
  if (capabilities.codeInterpreterEnabled) {
    hostedTools.push(codeInterpreterTool({ includeOutputs: true }));
  }

  return [
    ...hostedTools,
    listResearch,
    saveResearch,
    createCsv,
    createPdf,
    createGenericCsv,
    createGenericPdf,
  ];
}

export type { ArtifactToolInput };
