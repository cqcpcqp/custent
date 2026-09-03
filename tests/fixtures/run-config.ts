import type {
  CapturedRunExecutionConfig,
  ExecutionProfileCatalog,
  RunExecutionSummary,
  RunWorkerCapability,
} from "@/lib/contracts";

export const TEST_EXECUTION_PROFILE_CATALOG = {
  defaultId: "standard_research",
  options: [
    {
      id: "standard_research",
      label: "标准研究",
      description: "适合日常客户检索与快速核验",
    },
    {
      id: "pro_research",
      label: "Pro 深度研究",
      description: "更深入地规划、检索并交叉核验复杂目标",
    },
  ],
} as const satisfies ExecutionProfileCatalog;

export const TEST_CAPTURED_RUN_EXECUTION_CONFIG = {
  provenance: "captured",
  snapshotVersion: 2,
  executionProfileId: "standard_research",
  profileLabel: "标准研究",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.2",
  reasoningMode: "standard",
  reasoningModeEnabled: false,
  reasoningEffort: "medium",
  reasoningSummary: "auto",
  tools: {
    webSearch: true,
    codeInterpreter: false,
    listResearch: true,
    saveResearchResults: true,
    createCsv: true,
    createPdf: true,
    createCsvFile: true,
    createPdfFile: true,
  },
  maxAgentTurns: 8,
  billing: {
    policyVersion: 1,
    reservationCredits: 100,
    creditsPer1kInputTokens: 1,
    creditsPer1kOutputTokens: 5,
    creditsPerWebSearch: 10,
  },
} as const satisfies CapturedRunExecutionConfig;

export const TEST_CAPTURED_RUN_EXECUTION_SUMMARY = {
  provenance: "captured",
  snapshotVersion: 2,
  executionProfileId: "standard_research",
  profileLabel: "标准研究",
  fingerprint:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const satisfies RunExecutionSummary;

export const TEST_RUN_WORKER_CAPABILITY = {
  provider: TEST_CAPTURED_RUN_EXECUTION_CONFIG.provider,
  baseUrl: TEST_CAPTURED_RUN_EXECUTION_CONFIG.baseUrl,
  reasoningMode: false,
  codeInterpreter: false,
} as const satisfies RunWorkerCapability;
