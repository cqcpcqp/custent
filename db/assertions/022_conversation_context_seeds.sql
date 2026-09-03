BEGIN;

DO $$
DECLARE
  existing_seed record;
BEGIN
  IF to_regclass('conversation_context_seeds') IS NULL THEN
    RAISE EXCEPTION '022 assertion: conversation_context_seeds is missing'
      USING ERRCODE = '23514';
  END IF;

  IF to_regclass('conversation_context_seed_items') IS NULL THEN
    RAISE EXCEPTION '022 assertion: conversation_context_seed_items is missing'
      USING ERRCODE = '23514';
  END IF;

  IF to_regclass('conversation_branch_requests') IS NULL THEN
    RAISE EXCEPTION '022 assertion: conversation_branch_requests is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'assert_conversation_context_seed_integrity'
  ) THEN
    RAISE EXCEPTION '022 assertion: seed integrity function is missing'
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
