LOCK TABLE runs IN SHARE ROW EXCLUSIVE MODE;

-- An outstanding Run may still be executed after this migration. Its effective
-- model, reasoning, tool, and billing configuration was never persisted, so
-- upgrading it would require guessing from the deployment environment.
DO $$
DECLARE
  outstanding_runs text;
BEGIN
  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO outstanding_runs
  FROM runs run
  WHERE run.status IN ('waiting', 'queued', 'running');

  IF outstanding_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '027 cannot recover execution configuration for outstanding legacy Runs: %',
      outstanding_runs
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TABLE run_execution_configs (
  run_id uuid PRIMARY KEY,
  provenance text NOT NULL CHECK (provenance IN ('captured', 'legacy_unknown')),
  snapshot_version smallint,
  execution_profile_id text,
  profile_label text,
  provider text,
  base_url text,
  model text,
  reasoning_mode text,
  reasoning_effort text,
  reasoning_summary text,
  web_search_enabled boolean,
  code_interpreter_enabled boolean,
  list_research_enabled boolean,
  save_research_results_enabled boolean,
  create_csv_enabled boolean,
  create_pdf_enabled boolean,
  create_csv_file_enabled boolean,
  create_pdf_file_enabled boolean,
  max_agent_turns smallint,
  billing_policy_version smallint,
  reservation_credits integer,
  credits_per_1k_input_tokens integer,
  credits_per_1k_output_tokens integer,
  credits_per_web_search integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_execution_configs_run_fk
    FOREIGN KEY (run_id)
    REFERENCES runs(id)
    ON DELETE CASCADE,
  CONSTRAINT run_execution_configs_shape_check CHECK (
    (
      provenance = 'captured'
      AND snapshot_version IS NOT NULL
      AND snapshot_version = 1
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
  )
);

-- Terminal Runs remain readable without inventing facts that the historical
-- schema did not persist. This provenance is migration-only and cannot be used
-- for a future executable Run.
INSERT INTO run_execution_configs (run_id, provenance)
SELECT run.id, 'legacy_unknown'
FROM runs run;

CREATE FUNCTION reject_future_legacy_run_execution_config()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provenance = 'legacy_unknown' THEN
    RAISE EXCEPTION 'legacy_unknown execution configuration is migration-only'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER run_execution_configs_reject_future_legacy_trigger
BEFORE INSERT ON run_execution_configs
FOR EACH ROW
EXECUTE FUNCTION reject_future_legacy_run_execution_config();

CREATE FUNCTION reject_run_execution_config_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- The snapshot cannot be edited or removed independently. Allow only the
  -- nested DELETE issued by its parent Run's ON DELETE CASCADE foreign key.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Run execution configurations are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER run_execution_configs_immutable_trigger
BEFORE UPDATE OR DELETE ON run_execution_configs
FOR EACH ROW
EXECUTE FUNCTION reject_run_execution_config_mutation();

CREATE FUNCTION assert_run_execution_config_integrity(target_run_id uuid)
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

    -- Historical terminal attempts are backfilled as legacy_unknown together
    -- with their sources. They remain readable without inventing an execution
    -- configuration. Only a captured attempt represents a newly executable
    -- Run and therefore requires an exactly matching captured source.
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

CREATE FUNCTION enforce_run_execution_config_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_run_execution_config_integrity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER runs_execution_config_integrity_insert_trigger
AFTER INSERT ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_execution_config_integrity();

CREATE CONSTRAINT TRIGGER runs_execution_config_integrity_update_trigger
AFTER UPDATE OF
  status,
  reservation_credits,
  retry_of_run_id,
  regenerate_of_run_id
ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_execution_config_integrity();

CREATE FUNCTION enforce_execution_config_run_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_run_execution_config_integrity(NEW.run_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER run_execution_configs_integrity_insert_trigger
AFTER INSERT ON run_execution_configs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_execution_config_run_integrity();

DO $$
DECLARE
  existing_run record;
BEGIN
  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_execution_config_integrity(existing_run.id);
  END LOOP;
END;
$$;

COMMENT ON TABLE run_execution_configs IS
  'Immutable effective model, reasoning, tool, and billing configuration captured for exactly one Run; legacy_unknown rows preserve terminal history without inventing configuration.';
