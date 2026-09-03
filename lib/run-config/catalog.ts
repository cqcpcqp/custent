import {
  ExecutionProfileCatalogSchema,
  ExecutionProfileIdSchema,
  RunExecutionConfigSchema,
  type CapturedRunExecutionConfig,
  type ExecutionProfileCatalog,
  type ExecutionProfileId,
} from "@/lib/contracts";
import type { AppEnv } from "@/lib/env";

type RunConfigurationEnvironment = Pick<
  AppEnv,
  | "OPENAI_PROVIDER"
  | "OPENAI_BASE_URL"
  | "OPENAI_MODEL"
  | "OPENAI_REASONING_MODE_ENABLED"
  | "RUN_RESERVATION_CREDITS"
  | "CREDITS_PER_1K_INPUT_TOKENS"
  | "CREDITS_PER_1K_OUTPUT_TOKENS"
  | "CREDITS_PER_WEB_SEARCH"
>;

const executionProfiles = [
  {
    id: "standard_research",
    label: "标准研究",
    description: "适合日常客户检索与快速核验",
    reasoningMode: "standard",
    reasoningEffort: "medium",
    maxAgentTurns: 8,
  },
  {
    id: "pro_research",
    label: "Pro 深度研究",
    description: "更深入地规划、检索并交叉核验复杂目标",
    reasoningMode: "pro",
    reasoningEffort: "high",
    maxAgentTurns: 16,
  },
] as const;

export const defaultExecutionProfileId: ExecutionProfileId =
  "standard_research";

export function getExecutionProfileCatalog(): ExecutionProfileCatalog {
  return ExecutionProfileCatalogSchema.parse({
    defaultId: defaultExecutionProfileId,
    options: executionProfiles.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  });
}

export function resolveRunExecutionConfig(
  rawProfileId: ExecutionProfileId,
  environment: RunConfigurationEnvironment,
): CapturedRunExecutionConfig {
  const profileId = ExecutionProfileIdSchema.parse(rawProfileId);
  const profile = executionProfiles.find(({ id }) => id === profileId);
  if (profile === undefined) {
    throw new TypeError(`Unknown execution profile ${profileId}`);
  }

  const parsed = RunExecutionConfigSchema.parse({
    provenance: "captured",
    snapshotVersion: 2,
    executionProfileId: profile.id,
    profileLabel: profile.label,
    provider: environment.OPENAI_PROVIDER,
    baseUrl: environment.OPENAI_BASE_URL,
    model: environment.OPENAI_MODEL,
    reasoningMode: profile.reasoningMode,
    reasoningModeEnabled: environment.OPENAI_REASONING_MODE_ENABLED,
    reasoningEffort: profile.reasoningEffort,
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
    maxAgentTurns: profile.maxAgentTurns,
    billing: {
      policyVersion: 1,
      reservationCredits: environment.RUN_RESERVATION_CREDITS,
      creditsPer1kInputTokens:
        environment.CREDITS_PER_1K_INPUT_TOKENS,
      creditsPer1kOutputTokens:
        environment.CREDITS_PER_1K_OUTPUT_TOKENS,
      creditsPerWebSearch: environment.CREDITS_PER_WEB_SEARCH,
    },
  });
  if (parsed.provenance !== "captured") {
    throw new TypeError("Resolved execution profile is not captured");
  }
  return parsed;
}
