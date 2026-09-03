-- Repeatable PostgreSQL assertions for 027_run_execution_configs.sql.
-- Catalog and durable rows are inspected without changing committed state.
BEGIN;

DO $$
DECLARE
  actual_columns text[];
  actual_index record;
  existing_run record;
  expected_trigger record;
  invalid_runs text;
  required_captured_column text;
  shape_check_definition text;
BEGIN
  IF to_regclass('run_execution_configs') IS NULL THEN
    RAISE EXCEPTION '027 assertion: run_execution_configs is missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(column_info.column_name ORDER BY column_info.ordinal_position)
  INTO actual_columns
  FROM information_schema.columns column_info
  WHERE
    column_info.table_schema = current_schema()
    AND column_info.table_name = 'run_execution_configs';

  IF actual_columns IS DISTINCT FROM ARRAY[
    'run_id',
    'provenance',
    'snapshot_version',
    'execution_profile_id',
    'profile_label',
    'provider',
    'base_url',
    'model',
    'reasoning_mode',
    'reasoning_effort',
    'reasoning_summary',
    'web_search_enabled',
    'code_interpreter_enabled',
    'list_research_enabled',
    'save_research_results_enabled',
    'create_csv_enabled',
    'create_pdf_enabled',
    'create_csv_file_enabled',
    'create_pdf_file_enabled',
    'max_agent_turns',
    'billing_policy_version',
    'reservation_credits',
    'credits_per_1k_input_tokens',
    'credits_per_1k_output_tokens',
    'credits_per_web_search',
    'created_at'
  ]::text[] THEN
    RAISE EXCEPTION
      '027 assertion: run_execution_configs columns are unexpected: %',
      actual_columns
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('run_id', 'uuid', 'NO'),
        ('provenance', 'text', 'NO'),
        ('snapshot_version', 'smallint', 'YES'),
        ('execution_profile_id', 'text', 'YES'),
        ('profile_label', 'text', 'YES'),
        ('provider', 'text', 'YES'),
        ('base_url', 'text', 'YES'),
        ('model', 'text', 'YES'),
        ('reasoning_mode', 'text', 'YES'),
        ('reasoning_effort', 'text', 'YES'),
        ('reasoning_summary', 'text', 'YES'),
        ('web_search_enabled', 'boolean', 'YES'),
        ('code_interpreter_enabled', 'boolean', 'YES'),
        ('list_research_enabled', 'boolean', 'YES'),
        ('save_research_results_enabled', 'boolean', 'YES'),
        ('create_csv_enabled', 'boolean', 'YES'),
        ('create_pdf_enabled', 'boolean', 'YES'),
        ('create_csv_file_enabled', 'boolean', 'YES'),
        ('create_pdf_file_enabled', 'boolean', 'YES'),
        ('max_agent_turns', 'smallint', 'YES'),
        ('billing_policy_version', 'smallint', 'YES'),
        ('reservation_credits', 'integer', 'YES'),
        ('credits_per_1k_input_tokens', 'integer', 'YES'),
        ('credits_per_1k_output_tokens', 'integer', 'YES'),
        ('credits_per_web_search', 'integer', 'YES'),
        ('created_at', 'timestamp with time zone', 'NO')
    ) expected(column_name, data_type, is_nullable)
    LEFT JOIN information_schema.columns actual
      ON actual.table_schema = current_schema()
      AND actual.table_name = 'run_execution_configs'
      AND actual.column_name = expected.column_name
    WHERE
      actual.column_name IS NULL
      OR actual.data_type IS DISTINCT FROM expected.data_type
      OR actual.is_nullable IS DISTINCT FROM expected.is_nullable
  ) THEN
    RAISE EXCEPTION '027 assertion: one or more execution configuration column types/nullability are malformed'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT column_info.column_default
    FROM information_schema.columns column_info
    WHERE
      column_info.table_schema = current_schema()
      AND column_info.table_name = 'run_execution_configs'
      AND column_info.column_name = 'created_at'
  ) IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION '027 assertion: created_at default is missing or malformed'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    JOIN pg_class table_info
      ON table_info.oid = constraint_info.conrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_info.relnamespace
    WHERE
      table_namespace.nspname = current_schema()
      AND table_info.relname = 'run_execution_configs'
      AND constraint_info.conname = 'run_execution_configs_pkey'
      AND constraint_info.contype = 'p'
      AND constraint_info.convalidated
      AND pg_get_constraintdef(constraint_info.oid, true) =
        'PRIMARY KEY (run_id)'
  ) THEN
    RAISE EXCEPTION '027 assertion: run_execution_configs primary key is missing or malformed'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    JOIN pg_class table_info
      ON table_info.oid = constraint_info.conrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_info.relnamespace
    WHERE
      table_namespace.nspname = current_schema()
      AND table_info.relname = 'run_execution_configs'
      AND constraint_info.conname = 'run_execution_configs_run_fk'
      AND constraint_info.contype = 'f'
      AND constraint_info.convalidated
      AND constraint_info.confdeltype = 'c'
      AND pg_get_constraintdef(constraint_info.oid, true) =
        'FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE'
  ) THEN
    RAISE EXCEPTION '027 assertion: Run foreign key is missing or malformed'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    JOIN pg_class table_info
      ON table_info.oid = constraint_info.conrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_info.relnamespace
    WHERE
      table_namespace.nspname = current_schema()
      AND table_info.relname = 'run_execution_configs'
      AND constraint_info.conname = 'run_execution_configs_shape_check'
      AND constraint_info.contype = 'c'
      AND constraint_info.convalidated
      AND NOT constraint_info.connoinherit
  ) THEN
    RAISE EXCEPTION '027 assertion: execution configuration shape check is missing or unvalidated'
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_get_constraintdef(constraint_info.oid, true)
  INTO shape_check_definition
  FROM pg_constraint constraint_info
  JOIN pg_class table_info
    ON table_info.oid = constraint_info.conrelid
  JOIN pg_namespace table_namespace
    ON table_namespace.oid = table_info.relnamespace
  WHERE
    table_namespace.nspname = current_schema()
    AND table_info.relname = 'run_execution_configs'
    AND constraint_info.conname = 'run_execution_configs_shape_check';

  FOREACH required_captured_column IN ARRAY ARRAY[
    'snapshot_version',
    'execution_profile_id',
    'profile_label',
    'provider',
    'base_url',
    'model',
    'reasoning_mode',
    'reasoning_effort',
    'reasoning_summary',
    'web_search_enabled',
    'code_interpreter_enabled',
    'list_research_enabled',
    'save_research_results_enabled',
    'create_csv_enabled',
    'create_pdf_enabled',
    'create_csv_file_enabled',
    'create_pdf_file_enabled',
    'max_agent_turns',
    'billing_policy_version',
    'reservation_credits',
    'credits_per_1k_input_tokens',
    'credits_per_1k_output_tokens',
    'credits_per_web_search'
  ]::text[]
  LOOP
    IF position(
      format('%I IS NOT NULL', required_captured_column)
      IN shape_check_definition
    ) = 0 THEN
      RAISE EXCEPTION
        '027 assertion: captured column % lacks an explicit NULL rejection',
        required_captured_column
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF
    to_regprocedure('assert_run_execution_config_integrity(uuid)') IS NULL
    OR to_regprocedure('enforce_run_execution_config_integrity()') IS NULL
    OR to_regprocedure('enforce_execution_config_run_integrity()') IS NULL
    OR to_regprocedure('reject_future_legacy_run_execution_config()') IS NULL
    OR to_regprocedure('reject_run_execution_config_mutation()') IS NULL
  THEN
    RAISE EXCEPTION '027 assertion: one or more permanent integrity functions are missing'
      USING ERRCODE = '23514';
  END IF;

  FOR expected_trigger IN
    SELECT *
    FROM (
      VALUES
        (
          'runs_execution_config_integrity_insert_trigger',
          'runs',
          'enforce_run_execution_config_integrity()',
          5::smallint
        ),
        (
          'runs_execution_config_integrity_update_trigger',
          'runs',
          'enforce_run_execution_config_integrity()',
          17::smallint
        ),
        (
          'run_execution_configs_integrity_insert_trigger',
          'run_execution_configs',
          'enforce_execution_config_run_integrity()',
          5::smallint
        )
    ) expected(trigger_name, table_name, function_name, trigger_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger trigger_info
      JOIN pg_class table_info ON table_info.oid = trigger_info.tgrelid
      JOIN pg_namespace table_namespace
        ON table_namespace.oid = table_info.relnamespace
      WHERE
        table_namespace.nspname = current_schema()
        AND table_info.relname = expected_trigger.table_name
        AND trigger_info.tgname = expected_trigger.trigger_name
        AND NOT trigger_info.tgisinternal
        AND trigger_info.tgfoid = to_regprocedure(
          expected_trigger.function_name
        )
        AND trigger_info.tgtype = expected_trigger.trigger_type
        AND trigger_info.tgenabled <> 'D'
        AND trigger_info.tgdeferrable
        AND trigger_info.tginitdeferred
    ) THEN
      RAISE EXCEPTION
        '027 assertion: deferred integrity trigger % is disabled or malformed',
        expected_trigger.trigger_name
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_info
    JOIN pg_class table_info ON table_info.oid = trigger_info.tgrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_info.relnamespace
    WHERE
      table_namespace.nspname = current_schema()
      AND table_info.relname = 'run_execution_configs'
      AND trigger_info.tgname =
        'run_execution_configs_reject_future_legacy_trigger'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgenabled <> 'D'
      AND NOT trigger_info.tgdeferrable
      AND NOT trigger_info.tginitdeferred
      AND trigger_info.tgtype = 7
      AND trigger_info.tgfoid = to_regprocedure(
        'reject_future_legacy_run_execution_config()'
      )
  ) THEN
    RAISE EXCEPTION '027 assertion: migration-only legacy guard is missing or malformed'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_info
    JOIN pg_class table_info ON table_info.oid = trigger_info.tgrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_info.relnamespace
    WHERE
      table_namespace.nspname = current_schema()
      AND table_info.relname = 'run_execution_configs'
      AND trigger_info.tgname = 'run_execution_configs_immutable_trigger'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgenabled <> 'D'
      AND NOT trigger_info.tgdeferrable
      AND NOT trigger_info.tginitdeferred
      AND trigger_info.tgtype = 27
      AND trigger_info.tgfoid = to_regprocedure(
        'reject_run_execution_config_mutation()'
      )
  ) THEN
    RAISE EXCEPTION '027 assertion: immutable UPDATE/DELETE guard is missing or malformed'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO actual_index
  FROM pg_indexes index_info
  WHERE
    index_info.schemaname = current_schema()
    AND index_info.tablename = 'run_execution_configs'
    AND index_info.indexname <> 'run_execution_configs_pkey'
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      '027 assertion: unexpected execution configuration index %',
      actual_index.indexname
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  LEFT JOIN run_execution_configs config ON config.run_id = run.id
  WHERE config.run_id IS NULL;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '027 assertion: Runs without execution configuration: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  JOIN run_execution_configs config ON config.run_id = run.id
  WHERE
    (run.status IN ('waiting', 'queued', 'running') AND config.provenance <> 'captured')
    OR
    (
      config.provenance = 'legacy_unknown'
      AND run.status NOT IN (
        'completed',
        'failed',
        'cancelled',
        'reconciliation_required'
      )
    )
    OR
    (
      config.provenance = 'captured'
      AND config.reservation_credits IS DISTINCT FROM run.reservation_credits
    );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '027 assertion: execution configuration state is inconsistent for Runs: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_execution_config_integrity(existing_run.id);
  END LOOP;
END;
$$;

ROLLBACK;
