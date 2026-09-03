-- Repeatable PostgreSQL assertions for
-- 023_conversation_context_seed_creation_state.sql.
BEGIN;

DO $$
DECLARE
  existing_seed record;
BEGIN
  IF to_regprocedure(
    'assert_conversation_context_seed_integrity(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION
      '023 assertion: permanent seed integrity function is missing'
      USING ERRCODE = '23514';
  END IF;

  IF to_regprocedure(
    'assert_conversation_context_seed_creation_state(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION
      '023 assertion: seed creation-state function is missing'
      USING ERRCODE = '23514';
  END IF;

  IF to_regprocedure(
    'enforce_conversation_context_seed_creation_state()'
  ) IS NULL THEN
    RAISE EXCEPTION
      '023 assertion: seed creation-state trigger function is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_record
    JOIN pg_class table_record
      ON table_record.oid = trigger_record.tgrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_record.relnamespace
    WHERE
      table_namespace.nspname = current_schema()
      AND table_record.relname = 'conversation_context_seeds'
      AND trigger_record.tgname =
        'conversation_context_seeds_creation_state_trigger'
      AND NOT trigger_record.tgisinternal
      AND trigger_record.tgfoid = to_regprocedure(
        'enforce_conversation_context_seed_creation_state()'
      )
      AND trigger_record.tgtype = 7
      AND trigger_record.tgenabled <> 'D'
      AND NOT trigger_record.tgdeferrable
      AND NOT trigger_record.tginitdeferred
  ) THEN
    RAISE EXCEPTION
      '023 assertion: enabled row-level BEFORE INSERT seed creation-state trigger is missing or malformed'
      USING ERRCODE = '23514';
  END IF;

  FOR existing_seed IN
    SELECT conversation_id FROM conversation_context_seeds
  LOOP
    PERFORM assert_conversation_context_seed_integrity(
      existing_seed.conversation_id
    );
  END LOOP;
END;
$$;

ROLLBACK;
