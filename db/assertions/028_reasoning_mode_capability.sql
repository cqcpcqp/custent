-- Repeatable PostgreSQL assertions for 028_reasoning_mode_capability.sql.
-- Catalog and durable rows are inspected without changing committed state.
BEGIN;

DO $$
DECLARE
  existing_run record;
  integrity_definition text;
  invalid_runs text;
  shape_check_definition text;
BEGIN
  IF to_regclass('run_execution_configs') IS NULL THEN
    RAISE EXCEPTION '028 assertion: run_execution_configs is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns column_info
    WHERE
      column_info.table_schema = current_schema()
      AND column_info.table_name = 'run_execution_configs'
      AND column_info.column_name = 'reasoning_mode_enabled'
      AND column_info.ordinal_position = 27
      AND column_info.data_type = 'boolean'
      AND column_info.is_nullable = 'YES'
      AND column_info.column_default IS NULL
  ) THEN
    RAISE EXCEPTION '028 assertion: reasoning_mode_enabled column is missing or malformed'
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
    AND constraint_info.conname = 'run_execution_configs_shape_check'
    AND constraint_info.contype = 'c'
    AND constraint_info.convalidated;

  IF shape_check_definition IS NULL THEN
    RAISE EXCEPTION '028 assertion: execution configuration shape check is missing or unvalidated'
      USING ERRCODE = '23514';
  END IF;
  IF position(
    'reasoning_mode_enabled IS NOT NULL'
    IN shape_check_definition
  ) = 0 THEN
    RAISE EXCEPTION '028 assertion: captured reasoning mode capability does not reject NULL'
      USING ERRCODE = '23514';
  END IF;
  IF position(
    'reasoning_mode_enabled IS TRUE'
    IN shape_check_definition
  ) = 0 THEN
    RAISE EXCEPTION '028 assertion: version 1 reasoning mode capability is not fixed true'
      USING ERRCODE = '23514';
  END IF;
  IF position(
    'reasoning_mode_enabled IS NULL'
    IN shape_check_definition
  ) = 0 THEN
    RAISE EXCEPTION '028 assertion: legacy reasoning mode capability is not fixed NULL'
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_get_functiondef(
    to_regprocedure('assert_run_execution_config_integrity(uuid)')
  )
  INTO integrity_definition;
  IF integrity_definition IS NULL THEN
    RAISE EXCEPTION '028 assertion: execution configuration integrity function is missing'
      USING ERRCODE = '23514';
  END IF;
  IF position('current_config.reasoning_mode_enabled' IN integrity_definition) = 0
    OR position('source_config.reasoning_mode_enabled' IN integrity_definition) = 0
  THEN
    RAISE EXCEPTION '028 assertion: retry/regenerate integrity omits reasoning mode capability'
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
      AND trigger_info.tgenabled = 'O'
      AND trigger_info.tgtype = 27
      AND trigger_info.tgfoid = to_regprocedure(
        'reject_run_execution_config_mutation()'
      )
  ) THEN
    RAISE EXCEPTION '028 assertion: immutable execution configuration trigger is not enabled'
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  LEFT JOIN run_execution_configs config ON config.run_id = run.id
  WHERE
    config.run_id IS NULL
    OR (
      config.provenance = 'captured'
      AND (
        config.snapshot_version NOT IN (1, 2)
        OR config.reasoning_mode_enabled IS NULL
        OR (
          config.snapshot_version = 1
          AND config.reasoning_mode_enabled IS NOT TRUE
        )
      )
    )
    OR (
      config.provenance = 'legacy_unknown'
      AND config.reasoning_mode_enabled IS NOT NULL
    );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '028 assertion: reasoning mode capability is inconsistent for Runs: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_execution_config_integrity(existing_run.id);
  END LOOP;
END;
$$;

ROLLBACK;
