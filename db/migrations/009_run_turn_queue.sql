ALTER TABLE runs
  ADD COLUMN conversation_turn bigint,
  ADD COLUMN attempt_index integer NOT NULL DEFAULT 1,
  ADD COLUMN predecessor_run_id uuid,
  ADD COLUMN retry_of_run_id uuid;

WITH ordered_runs AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY conversation_id
      ORDER BY created_at, id
    )::bigint AS conversation_turn,
    lag(id) OVER (
      PARTITION BY conversation_id
      ORDER BY created_at, id
    ) AS predecessor_run_id
  FROM runs
)
UPDATE runs run
SET
  conversation_turn = ordered.conversation_turn,
  predecessor_run_id = ordered.predecessor_run_id
FROM ordered_runs ordered
WHERE run.id = ordered.id;

ALTER TABLE runs
  ALTER COLUMN conversation_turn SET NOT NULL,
  ADD CONSTRAINT runs_conversation_turn_positive_check
    CHECK (conversation_turn > 0),
  ADD CONSTRAINT runs_attempt_index_positive_check
    CHECK (attempt_index > 0),
  ADD CONSTRAINT runs_retry_attempt_shape_check
    CHECK (
      (attempt_index = 1 AND retry_of_run_id IS NULL)
      OR
      (attempt_index > 1 AND retry_of_run_id IS NOT NULL)
    ),
  ADD CONSTRAINT runs_predecessor_not_self_check
    CHECK (predecessor_run_id IS NULL OR predecessor_run_id <> id),
  ADD CONSTRAINT runs_retry_not_self_check
    CHECK (retry_of_run_id IS NULL OR retry_of_run_id <> id),
  ADD CONSTRAINT runs_predecessor_run_fk
    FOREIGN KEY (predecessor_run_id)
    REFERENCES runs(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT runs_retry_of_run_fk
    FOREIGN KEY (retry_of_run_id)
    REFERENCES runs(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

DROP INDEX runs_input_message_unique_idx;

CREATE UNIQUE INDEX runs_non_retry_input_message_unique_idx
  ON runs (input_message_id)
  WHERE input_message_id IS NOT NULL AND retry_of_run_id IS NULL;

CREATE UNIQUE INDEX runs_conversation_turn_attempt_unique_idx
  ON runs (conversation_id, conversation_turn, attempt_index);

CREATE UNIQUE INDEX runs_retry_of_run_unique_idx
  ON runs (retry_of_run_id)
  WHERE retry_of_run_id IS NOT NULL;

CREATE INDEX runs_predecessor_run_idx
  ON runs (predecessor_run_id)
  WHERE predecessor_run_id IS NOT NULL;

ALTER TABLE runs
  DROP CONSTRAINT runs_status_check,
  DROP CONSTRAINT runs_failure_matches_status_check;

ALTER TABLE runs
  ADD CONSTRAINT runs_status_check
  CHECK (
    status IN (
      'waiting',
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'reconciliation_required'
    )
  ),
  ADD CONSTRAINT runs_failure_matches_status_check
  CHECK (
    (
      status IN ('failed', 'cancelled', 'reconciliation_required')
      AND failure_code IS NOT NULL
      AND failure_message IS NOT NULL
      AND finished_at IS NOT NULL
    )
    OR
    (
      status IN ('waiting', 'queued', 'running')
      AND failure_code IS NULL
      AND failure_message IS NULL
      AND finished_at IS NULL
    )
    OR
    (
      status = 'completed'
      AND failure_code IS NULL
      AND failure_message IS NULL
      AND finished_at IS NOT NULL
    )
  );

ALTER TABLE runs
  ADD CONSTRAINT runs_message_ids_distinct_check
    CHECK (
      input_message_id IS NULL
      OR assistant_message_id IS NULL
      OR input_message_id <> assistant_message_id
    ),
  ADD CONSTRAINT runs_waiting_shape_check
  CHECK (
    status <> 'waiting'
    OR
    (
      predecessor_run_id IS NOT NULL
      AND input_message_id IS NOT NULL
      AND assistant_message_id IS NOT NULL
      AND started_at IS NULL
      AND model_started_at IS NULL
      AND cancel_requested_at IS NULL
      AND attempt_count = 0
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND heartbeat_at IS NULL
    )
  );

CREATE FUNCTION assert_run_turn_queue_integrity(target_run_id uuid)
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
  END IF;
END;
$$;

-- Validate every backfilled row before installing the deferred guards.
DO $$
DECLARE
  existing_run record;
BEGIN
  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_turn_queue_integrity(existing_run.id);
  END LOOP;
END;
$$;

CREATE FUNCTION enforce_run_turn_queue_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  related_run record;
BEGIN
  PERFORM assert_run_turn_queue_integrity(NEW.id);

  FOR related_run IN
    SELECT id
    FROM runs
    WHERE
      predecessor_run_id = NEW.id
      OR retry_of_run_id = NEW.id
      OR (
        NEW.retry_of_run_id IS NOT NULL
        AND predecessor_run_id = NEW.retry_of_run_id
      )
  LOOP
    PERFORM assert_run_turn_queue_integrity(related_run.id);
  END LOOP;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER runs_turn_queue_integrity_insert_trigger
AFTER INSERT ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_turn_queue_integrity();

CREATE CONSTRAINT TRIGGER runs_turn_queue_integrity_update_trigger
AFTER UPDATE OF
  user_id,
  conversation_id,
  status,
  input_message_id,
  conversation_turn,
  attempt_index,
  predecessor_run_id,
  retry_of_run_id
ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_turn_queue_integrity();
