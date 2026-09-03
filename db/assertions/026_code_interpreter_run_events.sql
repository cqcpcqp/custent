-- Repeatable PostgreSQL assertions for 026_code_interpreter_run_events.sql.
-- The assertion reads only catalog metadata and always rolls its transaction back.
BEGIN;

DO $$
DECLARE
  actual record;
BEGIN
  SELECT
    constraint_info.contype,
    constraint_info.convalidated,
    constraint_info.connoinherit,
    pg_get_constraintdef(constraint_info.oid, true) AS definition
  INTO actual
  FROM pg_constraint constraint_info
  JOIN pg_class table_catalog
    ON table_catalog.oid = constraint_info.conrelid
  JOIN pg_namespace table_namespace
    ON table_namespace.oid = table_catalog.relnamespace
  WHERE
    table_namespace.nspname = current_schema()
    AND table_catalog.relname = 'run_events'
    AND constraint_info.conname = 'run_events_event_type_check';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      '026 assertion: run_events_event_type_check is missing';
  END IF;

  IF
    actual.contype <> 'c'
    OR NOT actual.convalidated
    OR actual.connoinherit
    OR actual.definition IS DISTINCT FROM
      'CHECK (event_type = ANY (ARRAY[''status''::text, ''reasoning''::text, ''web_search''::text, ''code_interpreter_status''::text, ''code_interpreter_code''::text, ''code_interpreter_result''::text, ''tool_started''::text, ''tool_completed''::text, ''delta''::text, ''artifact''::text, ''attachment''::text, ''done''::text, ''error''::text]))'
  THEN
    RAISE EXCEPTION
      '026 assertion: run_events_event_type_check has an unexpected definition (type %, validated %, no inherit %, definition %)',
      actual.contype,
      actual.convalidated,
      actual.connoinherit,
      actual.definition;
  END IF;
END;
$$;

ROLLBACK;
