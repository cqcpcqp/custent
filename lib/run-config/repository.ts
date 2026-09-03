import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  RunExecutionSummarySchema,
  RunExecutionConfigSchema,
  type CapturedRunExecutionConfig,
  type RunExecutionConfig,
  type RunExecutionSummary,
} from "@/lib/contracts";
import type { CreditBillingPolicy } from "@/lib/credits/types";

export const RUN_EXECUTION_CONFIG_JSON_SQL = `
  (
    SELECT CASE config.provenance
      WHEN 'legacy_unknown' THEN jsonb_build_object(
        'provenance', 'legacy_unknown',
        'snapshotVersion', 0
      )
      WHEN 'captured' THEN jsonb_build_object(
        'provenance', 'captured',
        'snapshotVersion', config.snapshot_version,
        'executionProfileId', config.execution_profile_id,
        'profileLabel', config.profile_label,
        'provider', config.provider,
        'baseUrl', config.base_url,
        'model', config.model,
        'reasoningMode', config.reasoning_mode,
        'reasoningModeEnabled', config.reasoning_mode_enabled,
        'reasoningEffort', config.reasoning_effort,
        'reasoningSummary', config.reasoning_summary,
        'tools', jsonb_build_object(
          'webSearch', config.web_search_enabled,
          'codeInterpreter', config.code_interpreter_enabled,
          'listResearch', config.list_research_enabled,
          'saveResearchResults', config.save_research_results_enabled,
          'createCsv', config.create_csv_enabled,
          'createPdf', config.create_pdf_enabled,
          'createCsvFile', config.create_csv_file_enabled,
          'createPdfFile', config.create_pdf_file_enabled
        ),
        'maxAgentTurns', config.max_agent_turns,
        'billing', jsonb_build_object(
          'policyVersion', config.billing_policy_version,
          'reservationCredits', config.reservation_credits,
          'creditsPer1kInputTokens', config.credits_per_1k_input_tokens,
          'creditsPer1kOutputTokens', config.credits_per_1k_output_tokens,
          'creditsPerWebSearch', config.credits_per_web_search
        )
      )
      ELSE NULL
    END
    FROM run_execution_configs config
    WHERE config.run_id = run.id
  ) AS execution_config
`;

function capturedConfigValues(
  runId: string,
  config: CapturedRunExecutionConfig,
): unknown[] {
  return [
    runId,
    config.snapshotVersion,
    config.executionProfileId,
    config.profileLabel,
    config.provider,
    config.baseUrl,
    config.model,
    config.reasoningMode,
    config.reasoningModeEnabled,
    config.reasoningEffort,
    config.reasoningSummary,
    config.tools.webSearch,
    config.tools.codeInterpreter,
    config.tools.listResearch,
    config.tools.saveResearchResults,
    config.tools.createCsv,
    config.tools.createPdf,
    config.tools.createCsvFile,
    config.tools.createPdfFile,
    config.maxAgentTurns,
    config.billing.policyVersion,
    config.billing.reservationCredits,
    config.billing.creditsPer1kInputTokens,
    config.billing.creditsPer1kOutputTokens,
    config.billing.creditsPerWebSearch,
  ];
}

export async function insertCapturedRunExecutionConfig(
  runId: string,
  rawConfig: CapturedRunExecutionConfig,
  client: PoolClient,
): Promise<void> {
  const config = RunExecutionConfigSchema.parse(rawConfig);
  if (config.provenance !== "captured") {
    throw new TypeError("A new Run requires a captured execution config");
  }
  const result = await client.query<{ run_id: string }>(
    `
      INSERT INTO run_execution_configs (
        run_id,
        provenance,
        snapshot_version,
        execution_profile_id,
        profile_label,
        provider,
        base_url,
        model,
        reasoning_mode,
        reasoning_mode_enabled,
        reasoning_effort,
        reasoning_summary,
        web_search_enabled,
        code_interpreter_enabled,
        list_research_enabled,
        save_research_results_enabled,
        create_csv_enabled,
        create_pdf_enabled,
        create_csv_file_enabled,
        create_pdf_file_enabled,
        max_agent_turns,
        billing_policy_version,
        reservation_credits,
        credits_per_1k_input_tokens,
        credits_per_1k_output_tokens,
        credits_per_web_search
      )
      VALUES (
        $1, 'captured', $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24, $25
      )
      RETURNING run_id
    `,
    capturedConfigValues(runId, config),
  );
  if (result.rowCount !== 1 || result.rows[0].run_id !== runId) {
    throw new TypeError("Run execution config was not inserted");
  }
}

export async function copyCapturedRunExecutionConfig(
  sourceRunId: string,
  targetRunId: string,
  client: PoolClient,
): Promise<CapturedRunExecutionConfig> {
  const inserted = await client.query<{ run_id: string }>(
    `
      INSERT INTO run_execution_configs (
        run_id,
        provenance,
        snapshot_version,
        execution_profile_id,
        profile_label,
        provider,
        base_url,
        model,
        reasoning_mode,
        reasoning_mode_enabled,
        reasoning_effort,
        reasoning_summary,
        web_search_enabled,
        code_interpreter_enabled,
        list_research_enabled,
        save_research_results_enabled,
        create_csv_enabled,
        create_pdf_enabled,
        create_csv_file_enabled,
        create_pdf_file_enabled,
        max_agent_turns,
        billing_policy_version,
        reservation_credits,
        credits_per_1k_input_tokens,
        credits_per_1k_output_tokens,
        credits_per_web_search
      )
      SELECT
        $2,
        source.provenance,
        source.snapshot_version,
        source.execution_profile_id,
        source.profile_label,
        source.provider,
        source.base_url,
        source.model,
        source.reasoning_mode,
        source.reasoning_mode_enabled,
        source.reasoning_effort,
        source.reasoning_summary,
        source.web_search_enabled,
        source.code_interpreter_enabled,
        source.list_research_enabled,
        source.save_research_results_enabled,
        source.create_csv_enabled,
        source.create_pdf_enabled,
        source.create_csv_file_enabled,
        source.create_pdf_file_enabled,
        source.max_agent_turns,
        source.billing_policy_version,
        source.reservation_credits,
        source.credits_per_1k_input_tokens,
        source.credits_per_1k_output_tokens,
        source.credits_per_web_search
      FROM run_execution_configs source
      WHERE source.run_id = $1 AND source.provenance = 'captured'
      RETURNING run_id
    `,
    [sourceRunId, targetRunId],
  );
  if (inserted.rowCount !== 1 || inserted.rows[0].run_id !== targetRunId) {
    throw new TypeError("Source Run does not have a captured execution config");
  }
  const result = await client.query<{ execution_config: unknown }>(
    `
      SELECT ${RUN_EXECUTION_CONFIG_JSON_SQL}
      FROM runs run
      WHERE run.id = $1
    `,
    [targetRunId],
  );
  if (result.rowCount !== 1) {
    throw new TypeError("Copied Run execution config is missing its Run");
  }
  const parsed = RunExecutionConfigSchema.parse(
    result.rows[0].execution_config,
  );
  if (parsed.provenance !== "captured") {
    throw new TypeError("Copied Run execution config is not captured");
  }
  return parsed;
}

export function parseRunExecutionConfig(value: unknown): RunExecutionConfig {
  return RunExecutionConfigSchema.parse(value);
}

export function capturedRunExecutionConfigFingerprintPayload(
  config: CapturedRunExecutionConfig,
): CapturedRunExecutionConfig | Omit<
  CapturedRunExecutionConfig,
  "reasoningModeEnabled"
> {
  if (config.snapshotVersion === 2) {
    return config;
  }
  const versionOneConfig = { ...config };
  delete (versionOneConfig as Partial<CapturedRunExecutionConfig>)
    .reasoningModeEnabled;
  return versionOneConfig;
}

export function summarizeRunExecutionConfig(
  value: unknown,
): RunExecutionSummary {
  const config = parseRunExecutionConfig(value);
  if (config.provenance === "legacy_unknown") {
    return RunExecutionSummarySchema.parse(config);
  }
  return RunExecutionSummarySchema.parse({
    provenance: "captured",
    snapshotVersion: config.snapshotVersion,
    executionProfileId: config.executionProfileId,
    profileLabel: config.profileLabel,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify(capturedRunExecutionConfigFingerprintPayload(config)),
        "utf8",
      )
      .digest("hex"),
  });
}

export async function readCapturedRunBillingPolicy(
  runId: string,
  client: PoolClient,
): Promise<CreditBillingPolicy> {
  const result = await client.query<{
    billing_policy_version: number | null;
    credits_per_1k_input_tokens: number | null;
    credits_per_1k_output_tokens: number | null;
    credits_per_web_search: number | null;
  }>(
    `
      SELECT
        billing_policy_version,
        credits_per_1k_input_tokens,
        credits_per_1k_output_tokens,
        credits_per_web_search
      FROM run_execution_configs
      WHERE run_id = $1 AND provenance = 'captured'
    `,
    [runId],
  );
  if (result.rowCount !== 1) {
    throw new TypeError("Run does not have captured billing rates");
  }
  const row = result.rows[0];
  if (
    row.billing_policy_version !== 1 ||
    row.credits_per_1k_input_tokens === null ||
    row.credits_per_1k_output_tokens === null ||
    row.credits_per_web_search === null
  ) {
    throw new TypeError("Run captured billing rates are incomplete");
  }
  return {
    policyVersion: row.billing_policy_version,
    creditsPer1kInputTokens: row.credits_per_1k_input_tokens,
    creditsPer1kOutputTokens: row.credits_per_1k_output_tokens,
    creditsPerWebSearch: row.credits_per_web_search,
  };
}
