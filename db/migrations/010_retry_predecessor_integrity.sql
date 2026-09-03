CREATE OR REPLACE FUNCTION assert_run_turn_queue_integrity(target_run_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_run runs%ROWTYPE;
  run_conversation conversations%ROWTYPE;
  run_input_message messages%ROWTYPE;
  predecessor_run runs%ROWTYPE;
  retry_source_run runs%ROWTYPE;
BEGIN
  SELECT *
  INTO current_run
  FROM runs
  WHERE id = target_run_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT *
  INTO run_conversation
  FROM conversations
  WHERE id = current_run.conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'conversation % does not exist (run %)',
      current_run.conversation_id,
      current_run.id
      USING ERRCODE = '23503';
  END IF;

  IF run_conversation.user_id IS DISTINCT FROM current_run.user_id THEN
    RAISE EXCEPTION
      'Run user must own its conversation (run %)',
      current_run.id
      USING ERRCODE = '23514';
  END IF;

  IF current_run.conversation_turn = 1 THEN
    IF current_run.predecessor_run_id IS NOT NULL THEN
      RAISE EXCEPTION
        'first conversation turn cannot have a predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  ELSIF current_run.predecessor_run_id IS NULL THEN
    RAISE EXCEPTION
      'conversation turn % requires a predecessor (run %)',
      current_run.conversation_turn,
      current_run.id
      USING ERRCODE = '23514';
  END IF;

  IF current_run.input_message_id IS NOT NULL THEN
    SELECT *
    INTO run_input_message
    FROM messages
    WHERE id = current_run.input_message_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'input message % does not exist (run %)',
        current_run.input_message_id,
        current_run.id
        USING ERRCODE = '23503';
    END IF;

    IF
      run_input_message.conversation_id IS DISTINCT FROM current_run.conversation_id
      OR run_input_message.role <> 'user'
    THEN
      RAISE EXCEPTION
        'input message must be a user message from the same conversation (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF current_run.predecessor_run_id IS NOT NULL THEN
    SELECT *
    INTO predecessor_run
    FROM runs
    WHERE id = current_run.predecessor_run_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'predecessor Run % does not exist (run %)',
        current_run.predecessor_run_id,
        current_run.id
        USING ERRCODE = '23503';
    END IF;

    IF
      predecessor_run.user_id IS DISTINCT FROM current_run.user_id
      OR predecessor_run.conversation_id IS DISTINCT FROM current_run.conversation_id
    THEN
      RAISE EXCEPTION
        'predecessor Run must belong to the same user and conversation (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF predecessor_run.conversation_turn <> current_run.conversation_turn - 1 THEN
      RAISE EXCEPTION
        'predecessor Run must be from the immediately preceding conversation turn (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM runs newer_attempt
      WHERE
        newer_attempt.conversation_id = predecessor_run.conversation_id
        AND newer_attempt.conversation_turn = predecessor_run.conversation_turn
        AND newer_attempt.attempt_index > predecessor_run.attempt_index
    ) THEN
      RAISE EXCEPTION
        'Run must depend on the latest predecessor attempt (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF current_run.status = 'waiting' AND predecessor_run.status = 'completed' THEN
      RAISE EXCEPTION
        'waiting Run has an already completed predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      current_run.status IN ('queued', 'running')
      AND predecessor_run.status NOT IN (
        'completed',
        'failed',
        'cancelled',
        'reconciliation_required'
      )
    THEN
      RAISE EXCEPTION
        'executable Run requires a terminal predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF current_run.retry_of_run_id IS NOT NULL THEN
    SELECT *
    INTO retry_source_run
    FROM runs
    WHERE id = current_run.retry_of_run_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'retry source Run % does not exist (run %)',
        current_run.retry_of_run_id,
        current_run.id
        USING ERRCODE = '23503';
    END IF;

    IF
      retry_source_run.user_id IS DISTINCT FROM current_run.user_id
      OR retry_source_run.conversation_id IS DISTINCT FROM current_run.conversation_id
      OR retry_source_run.conversation_turn IS DISTINCT FROM current_run.conversation_turn
    THEN
      RAISE EXCEPTION
        'retry source must belong to the same user, conversation, and turn (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF current_run.attempt_index <> retry_source_run.attempt_index + 1 THEN
      RAISE EXCEPTION
        'retry attempt must immediately follow its source attempt (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF retry_source_run.status NOT IN ('failed', 'cancelled') THEN
      RAISE EXCEPTION
        'only failed or cancelled Runs can be retried (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM runs direct_successor
      WHERE
        direct_successor.predecessor_run_id = retry_source_run.id
        AND direct_successor.status <> 'waiting'
    ) THEN
      RAISE EXCEPTION
        'Run cannot be retried after a non-waiting successor has started (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      current_run.input_message_id IS NULL
      OR retry_source_run.input_message_id IS NULL
      OR current_run.input_message_id IS DISTINCT FROM retry_source_run.input_message_id
    THEN
      RAISE EXCEPTION
        'retry Run must reuse its source input message (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      current_run.predecessor_run_id IS DISTINCT FROM retry_source_run.predecessor_run_id
    THEN
      RAISE EXCEPTION
        'retry Run must preserve its source predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      current_run.status IN ('queued', 'running')
      AND current_run.predecessor_run_id IS NOT NULL
      AND predecessor_run.status <> 'completed'
    THEN
      RAISE EXCEPTION
        'executable retry requires a completed predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

-- The 009 version of this function did not include the executable-retry guard.
-- Validate existing rows now so the new invariant applies to upgrades and fresh
-- databases equally.
DO $$
DECLARE
  existing_run record;
BEGIN
  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_turn_queue_integrity(existing_run.id);
  END LOOP;
END;
$$;
