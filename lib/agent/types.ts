import type { AgentInputItem, Session } from "@openai/agents";

import type {
  GenericCsvArtifactRequest,
  GenericPdfArtifactRequest,
} from "@/lib/artifacts";
import type {
  ArtifactSummary,
  Citation,
  CodeInterpreterOutput,
  WebSearchAction,
} from "@/lib/contracts";
import type {
  RunExecutionConfig,
  RunWorkerCapability,
} from "@/lib/contracts";
import type {
  ResearchSnapshotSummary,
  SaveResearchInput,
} from "@/lib/domain/research";

export type AgentContext = {
  userId: string;
  conversationId: string;
  requestId: string;
  runId: string;
  assistantMessageId: string;
  leaseOwner: string;
  leaseToken: string;
};

export type ResearchToolServices = {
  listResearch(context: AgentContext): Promise<ResearchSnapshotSummary[]>;
  saveResearch(
    input: SaveResearchInput,
    context: AgentContext,
  ): Promise<ResearchSnapshotSummary>;
};

export type ArtifactToolInput = {
  snapshotId: string;
  fileName: string;
};

export type ArtifactToolServices = {
  createCsv(
    input: ArtifactToolInput,
    context: AgentContext,
  ): Promise<ArtifactSummary>;
  createPdf(
    input: ArtifactToolInput,
    context: AgentContext,
  ): Promise<ArtifactSummary>;
  createGenericCsv(
    input: GenericCsvArtifactRequest,
    context: AgentContext,
  ): Promise<ArtifactSummary>;
  createGenericPdf(
    input: GenericPdfArtifactRequest,
    context: AgentContext,
  ): Promise<ArtifactSummary>;
};

export type AgentToolServices = {
  research: ResearchToolServices;
  artifacts: ArtifactToolServices;
};

export type ConversationCustomInstructionsSnapshot = Readonly<{
  content: string;
  revision: number;
}>;

export type AgentRunUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AgentStatusPhase =
  | "thinking"
  | "searching"
  | "coding"
  | "saving"
  | "rendering";

export type AgentRuntimeEvent =
  | {
      type: "status";
      phase: AgentStatusPhase;
      message: string;
    }
  | {
      type: "reasoning_delta";
      itemId: string;
      summaryIndex: number;
      delta: string;
      providerSequence: number;
    }
  | {
      type: "web_search_status";
      callId: string;
      phase: "in_progress" | "searching" | "completed" | "failed";
      outputIndex: number;
      providerSequence: number;
      action: WebSearchAction | null;
    }
  | {
      type: "code_interpreter_status";
      callId: string;
      phase: "in_progress" | "interpreting" | "completed";
      outputIndex: number;
      providerSequence: number;
    }
  | {
      type: "code_interpreter_code_delta";
      callId: string;
      delta: string;
      outputIndex: number;
      providerSequence: number;
    }
  | {
      type: "code_interpreter_code_done";
      callId: string;
      code: string;
      outputIndex: number;
      providerSequence: number;
    }
  | {
      type: "code_interpreter_result";
      callId: string;
      phase:
        | "in_progress"
        | "interpreting"
        | "completed"
        | "incomplete"
        | "failed";
      outputIndex: number;
      providerSequence: number;
      containerId: string;
      code: string | null;
      outputs: CodeInterpreterOutput[] | null;
    }
  | {
      type: "tool_called";
      callId: string;
      toolName: "list_research";
      input: Record<string, never>;
    }
  | {
      type: "tool_called";
      callId: string;
      toolName: "save_research_results";
      input: SaveResearchInput;
    }
  | {
      type: "tool_called";
      callId: string;
      toolName: "create_csv" | "create_pdf";
      input: ArtifactToolInput;
    }
  | {
      type: "tool_called";
      callId: string;
      toolName: "create_csv_file";
      input: GenericCsvArtifactRequest;
    }
  | {
      type: "tool_called";
      callId: string;
      toolName: "create_pdf_file";
      input: GenericPdfArtifactRequest;
    }
  | {
      type: "tool_output";
      callId: string;
      toolName: "list_research";
      output: ResearchSnapshotSummary[];
    }
  | {
      type: "tool_output";
      callId: string;
      toolName: "save_research_results";
      output: ResearchSnapshotSummary;
    }
  | {
      type: "tool_output";
      callId: string;
      toolName: "create_csv" | "create_pdf";
      output: ArtifactSummary;
    }
  | {
      type: "tool_output";
      callId: string;
      toolName: "create_csv_file" | "create_pdf_file";
      output: ArtifactSummary;
    }
  | {
      type: "delta";
      text: string;
    }
  | {
      type: "artifact";
      artifact: ArtifactSummary;
    }
  | {
      type: "complete";
      content: string;
      citations: Citation[];
      artifacts: ArtifactSummary[];
      usage: AgentRunUsage;
      webSearches: number;
    };

export type AgentRunOptions = {
  context: AgentContext;
  session: Session;
  signal?: AbortSignal;
};

export type AgentRuntimeLike = {
  run(
    input: AgentRuntimeInput,
    options: AgentRunOptions,
  ): AsyncGenerator<AgentRuntimeEvent>;
};

export type AgentRuntimeFactory = {
  capability: RunWorkerCapability;
  forRun(
    config: RunExecutionConfig,
    customInstructionsSnapshot: ConversationCustomInstructionsSnapshot | null,
  ): AgentRuntimeLike;
};

export type AgentRuntimeInput = string | AgentInputItem[];
