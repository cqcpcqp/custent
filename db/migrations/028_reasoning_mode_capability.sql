LOCK TABLE runs IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE run_execution_configs IN SHARE ROW EXCLUSIVE MODE;

-- Version 1 snapshots predate explicit provider capability modeling and always
-- sent reasoning.mode. Preserve that exact behavior instead of inferring a new
-- value from the deployment environment. Version 2 snapshots persist whether
-- reasoning.mode is part of the provider request.
ALTER TABLE run_execution_configs
  DISABLE TRIGGER run_execution_configs_immutable_trigger;

ALTER TABLE run_execution_configs
  ADD COLUMN reasoning_mode_enabled boolean;

UPDATE run_execution_configs
SET reasoning_mode_enabled = TRUE
WHERE provenance = 'captured';

ALTER TABLE run_execution_configs
  DROP CONSTRAINT run_execution_configs_shape_check;

ALTER TABLE run_execution_configs
  ADD CONSTRAINT run_execution_configs_shape_check CHECK (
    (
      provenance = 'captured'
      AND snapshot_version IS NOT NULL
      AND snapshot_version IN (1, 2)
      AND execution_profile_id IS NOT NULL
      AND execution_profile_id IN ('standard_research', 'pro_research')
      AND profile_label IS NOT NULL
      AND length(profile_label) BETWEEN 1 AND 80
      AND profile_label = btrim(profile_label)
      AND provider IS NOT NULL
      AND provider IN ('openai', 'sharesub')
      AND base_url IS NOT NULL
      AND length(base_url) BETWEEN 1 AND 2048
      AND base_url = btrim(base_url)
      AND base_url ~ '^https?://[^[:space:]]+$'
      AND model IS NOT NULL
      AND length(model) BETWEEN 1 AND 200
      AND model = btrim(model)
      AND reasoning_mode IS NOT NULL
      AND reasoning_mode IN ('standard', 'pro')
      AND reasoning_mode_enabled IS NOT NULL
      AND (
        snapshot_version = 2
        OR reasoning_mode_enabled IS TRUE
      )
      AND reasoning_effort IS NOT NULL
      AND reasoning_effort IN (
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max'
      )
      AND reasoning_summary IS NOT NULL
      AND reasoning_summary = 'auto'
      AND web_search_enabled IS NOT NULL
      AND web_search_enabled IS TRUE
      AND code_interpreter_enabled IS NOT NULL
      AND code_interpreter_enabled IS FALSE
      AND list_research_enabled IS NOT NULL
      AND list_research_enabled IS TRUE
      AND save_research_results_enabled IS NOT NULL
      AND save_research_results_enabled IS TRUE
      AND create_csv_enabled IS NOT NULL
      AND create_csv_enabled IS TRUE
      AND create_pdf_enabled IS NOT NULL
      AND create_pdf_enabled IS TRUE
      AND create_csv_file_enabled IS NOT NULL
      AND create_csv_file_enabled IS TRUE
      AND create_pdf_file_enabled IS NOT NULL
      AND create_pdf_file_enabled IS TRUE
      AND max_agent_turns IS NOT NULL
      AND max_agent_turns BETWEEN 1 AND 32
      AND billing_policy_version IS NOT NULL
      AND billing_policy_version = 1
      AND reservation_credits IS NOT NULL
      AND reservation_credits > 0
      AND credits_per_1k_input_tokens IS NOT NULL
      AND credits_per_1k_input_tokens >= 0
      AND credits_per_1k_output_tokens IS NOT NULL
      AND credits_per_1k_output_tokens >= 0
      AND credits_per_web_search IS NOT NULL
      AND credits_per_web_search >= 0
    )
    OR
    (
      provenance = 'legacy_unknown'
      AND snapshot_version IS NULL
      AND execution_profile_id IS NULL
      AND profile_label IS NULL
      AND provider IS NULL
      AND base_url IS NULL
      AND model IS NULL
      AND reasoning_mode IS NULL
      AND reasoning_mode_enabled IS NULL
      AND reasoning_effort IS NULL
      AND reasoning_summary IS NULL
      AND web_search_enabled IS NULL
      AND code_interpreter_enabled IS NULL
      AND list_research_enabled IS NULL
      AND save_research_results_enabled IS NULL
      AND create_csv_enabled IS NULL
      AND create_pdf_enabled IS NULL
      AND create_csv_file_enabled IS NULL
      AND create_pdf_file_enabled IS NULL
      AND max_agent_turns IS NULL
      AND billing_policy_version IS NULL
      AND reservation_credits IS NULL
      AND credits_per_1k_input_tokens IS NULL
      AND credits_per_1k_output_tokens IS NULL
      AND credits_per_web_search IS NULL
    )
  );

CREATE OR REPLACE FUNCTION assert_run_execution_config_integrity(target_run_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_run runs%ROWTYPE;
  current_config run_execution_configs%ROWTYPE;
  source_config run_execution_configs%ROWTYPE;
BEGIN
  SELECT *
  INTO current_run
  FROM runs
  WHERE id = target_run_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT *
  INTO current_config
  FROM run_execution_configs
  WHERE run_id = current_run.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Run % requires exactly one execution configuration',
      current_run.id
      USING ERRCODE = '23514';
  END IF;

  IF
    current_run.status IN ('waiting', 'queued', 'running')
    AND current_config.provenance <> 'captured'
  THEN
    RAISE EXCEPTION
      'outstanding Run % requires a captured execution configuration',
      current_run.id
      USING ERRCODE = '23514';
  END IF;

  IF
    current_config.provenance = 'captured'
    AND current_config.reservation_credits IS DISTINCT FROM current_run.reservation_credits
  THEN
    RAISE EXCEPTION
      'Run reservation and execution configuration reservation differ (run %)',
      current_run.id
      USING ERRCODE = '23514';
  END IF;

  IF
    current_config.provenance = 'legacy_unknown'
    AND current_run.status NOT IN (
      'completed',
      'failed',
      'cancelled',
      'reconciliation_required'
    )
  THEN
    RAISE EXCEPTION
      'legacy_unknown execution configuration requires a terminal Run (run %)',
      current_run.id
      USING ERRCODE = '23514';
  END IF;

  IF
    current_run.retry_of_run_id IS NOT NULL
    OR current_run.regenerate_of_run_id IS NOT NULL
  THEN
    SELECT source.*
    INTO source_config
    FROM run_execution_configs source
    WHERE source.run_id = COALESCE(
      current_run.retry_of_run_id,
      current_run.regenerate_of_run_id
    );

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'attempt source execution configuration is missing (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      current_config.provenance = 'captured'
      AND (
        source_config.provenance <> 'captured'
        OR ROW(
          current_config.snapshot_version,
          current_config.execution_profile_id,
          current_config.profile_label,
          current_config.provider,
          current_config.base_url,
          current_config.model,
          current_config.reasoning_mode,
          current_config.reasoning_mode_enabled,
          current_config.reasoning_effort,
          current_config.reasoning_summary,
          current_config.web_search_enabled,
          current_config.code_interpreter_enabled,
          current_config.list_research_enabled,
          current_config.save_research_results_enabled,
          current_config.create_csv_enabled,
          current_config.create_pdf_enabled,
          current_config.create_csv_file_enabled,
          current_config.create_pdf_file_enabled,
          current_config.max_agent_turns,
          current_config.billing_policy_version,
          current_config.reservation_credits,
          current_config.credits_per_1k_input_tokens,
          current_config.credits_per_1k_output_tokens,
          current_config.credits_per_web_search
        ) IS DISTINCT FROM ROW(
          source_config.snapshot_version,
          source_config.execution_profile_id,
          source_config.profile_label,
          source_config.provider,
          source_config.base_url,
          source_config.model,
          source_config.reasoning_mode,
          source_config.reasoning_mode_enabled,
          source_config.reasoning_effort,
          source_config.reasoning_summary,
          source_config.web_search_enabled,
          source_config.code_interpreter_enabled,
          source_config.list_research_enabled,
          source_config.save_research_results_enabled,
          source_config.create_csv_enabled,
          source_config.create_pdf_enabled,
          source_config.create_csv_file_enabled,
          source_config.create_pdf_file_enabled,
          source_config.max_agent_turns,
          source_config.billing_policy_version,
          source_config.reservation_credits,
          source_config.credits_per_1k_input_tokens,
          source_config.credits_per_1k_output_tokens,
          source_config.credits_per_web_search
        )
      )
    THEN
      RAISE EXCEPTION
        'retry/regenerate Run must preserve its source execution configuration (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

ALTER TABLE run_execution_configs
  ENABLE TRIGGER run_execution_configs_immutable_trigger;

DO $$
DECLARE
  existing_run record;
BEGIN
  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_execution_config_integrity(existing_run.id);
  END LOOP;
END;
$$;

COMMENT ON COLUMN run_execution_configs.reasoning_mode_enabled IS
  'Whether this immutable Run sends reasoning.mode; version 1 is always true, version 2 is provider-capability gated, and legacy_unknown is NULL.';
