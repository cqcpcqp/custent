CREATE OR REPLACE FUNCTION assert_run_session_snapshot_integrity(
  target_run_id uuid,
  target_phase text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_record run_session_snapshots%ROWTYPE;
  snapshot_run runs%ROWTYPE;
  actual_item_count integer;
  first_position integer;
  last_position integer;
BEGIN
  SELECT *
  INTO snapshot_record
  FROM run_session_snapshots snapshot
  WHERE
    snapshot.run_id = target_run_id
    AND snapshot.phase = target_phase;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT *
  INTO snapshot_run
  FROM runs
  WHERE id = snapshot_record.run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Run % does not exist for its % session snapshot',
      snapshot_record.run_id,
      snapshot_record.phase
      USING ERRCODE = '23503';
  END IF;

  IF snapshot_record.phase = 'post' AND snapshot_run.status NOT IN ('completed', 'cancelled', 'reconciliation_required') THEN
    RAISE EXCEPTION
      'post session snapshot requires a completed or interrupted Run (run %)',
      snapshot_record.run_id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    count(*)::integer,
    min(snapshot_item.position),
    max(snapshot_item.position)
  INTO actual_item_count, first_position, last_position
  FROM run_session_snapshot_items snapshot_item
  WHERE
    snapshot_item.run_id = snapshot_record.run_id
    AND snapshot_item.phase = snapshot_record.phase;

  IF
    actual_item_count IS DISTINCT FROM snapshot_record.item_count
    OR (
      actual_item_count = 0
      AND (first_position IS NOT NULL OR last_position IS NOT NULL)
    )
    OR (
      actual_item_count > 0
      AND (
        first_position IS DISTINCT FROM 1
        OR last_position IS DISTINCT FROM actual_item_count
      )
    )
  THEN
    RAISE EXCEPTION
      'session snapshot item positions/count are inconsistent (run %, phase %, expected %, actual %, first %, last %)',
      snapshot_record.run_id,
      snapshot_record.phase,
      snapshot_record.item_count,
      actual_item_count,
      first_position,
      last_position
      USING ERRCODE = '23514';
  END IF;
END;
$$;

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
  regenerate_source_run runs%ROWTYPE;
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

    IF current_run.status = 'waiting' AND predecessor_run.status = 'completed' THEN
      RAISE EXCEPTION
        'waiting Run has an already completed predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      current_run.status IN ('queued', 'running')
      AND NOT (
        predecessor_run.status = 'completed'
        OR (
          predecessor_run.status IN ('cancelled', 'reconciliation_required')
          AND EXISTS (
            SELECT 1 FROM run_session_snapshots snapshot
            WHERE snapshot.run_id = predecessor_run.id AND snapshot.phase = 'post'
          )
        )
      )
    THEN
      RAISE EXCEPTION
        'executable Run requires a completed predecessor or an interrupted continuation snapshot (run %)',
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

    IF current_run.predecessor_run_id IS DISTINCT FROM retry_source_run.predecessor_run_id THEN
      RAISE EXCEPTION
        'retry Run must preserve its source predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF current_run.regenerate_of_run_id IS NOT NULL THEN
    SELECT *
    INTO regenerate_source_run
    FROM runs
    WHERE id = current_run.regenerate_of_run_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'regenerate source Run % does not exist (run %)',
        current_run.regenerate_of_run_id,
        current_run.id
        USING ERRCODE = '23503';
    END IF;

    IF
      regenerate_source_run.user_id IS DISTINCT FROM current_run.user_id
      OR regenerate_source_run.conversation_id IS DISTINCT FROM current_run.conversation_id
      OR regenerate_source_run.conversation_turn IS DISTINCT FROM current_run.conversation_turn
    THEN
      RAISE EXCEPTION
        'regenerate source must belong to the same user, conversation, and turn (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF current_run.attempt_index <> regenerate_source_run.attempt_index + 1 THEN
      RAISE EXCEPTION
        'regenerate attempt must immediately follow its source attempt (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF regenerate_source_run.status <> 'completed' THEN
      RAISE EXCEPTION
        'only a completed Run can be regenerated (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      regenerate_source_run.assistant_message_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM messages source_message
        WHERE
          source_message.id = regenerate_source_run.assistant_message_id
          AND source_message.conversation_id = regenerate_source_run.conversation_id
          AND source_message.run_id = regenerate_source_run.id
          AND source_message.role = 'assistant'
      )
    THEN
      RAISE EXCEPTION
        'regenerate source must have its completed assistant message (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF
      current_run.input_message_id IS NULL
      OR regenerate_source_run.input_message_id IS NULL
      OR current_run.input_message_id IS DISTINCT FROM regenerate_source_run.input_message_id
    THEN
      RAISE EXCEPTION
        'regenerate Run must reuse its source input message (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF current_run.predecessor_run_id IS DISTINCT FROM regenerate_source_run.predecessor_run_id THEN
      RAISE EXCEPTION
        'regenerate Run must preserve its source predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

DO $$
DECLARE
  existing_run record;
BEGIN
  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_turn_queue_integrity(existing_run.id);
  END LOOP;
END;
$$;
