ALTER TABLE runs
  ADD COLUMN regenerate_of_run_id uuid,
  ADD CONSTRAINT runs_regenerate_not_self_check
    CHECK (regenerate_of_run_id IS NULL OR regenerate_of_run_id <> id),
  ADD CONSTRAINT runs_regenerate_of_run_fk
    FOREIGN KEY (regenerate_of_run_id)
    REFERENCES runs(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE runs
  DROP CONSTRAINT runs_retry_attempt_shape_check,
  ADD CONSTRAINT runs_attempt_source_shape_check
    CHECK (
      (
        attempt_index = 1
        AND retry_of_run_id IS NULL
        AND regenerate_of_run_id IS NULL
      )
      OR
      (
        attempt_index > 1
        AND (
          (retry_of_run_id IS NOT NULL)::integer
          + (regenerate_of_run_id IS NOT NULL)::integer
        ) = 1
      )
    );

DROP INDEX runs_non_retry_input_message_unique_idx;

CREATE UNIQUE INDEX runs_initial_input_message_unique_idx
  ON runs (input_message_id)
  WHERE
    input_message_id IS NOT NULL
    AND retry_of_run_id IS NULL
    AND regenerate_of_run_id IS NULL;

CREATE UNIQUE INDEX runs_regenerate_of_run_unique_idx
  ON runs (regenerate_of_run_id)
  WHERE regenerate_of_run_id IS NOT NULL;

CREATE TABLE run_session_snapshots (
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('pre', 'post')),
  item_count integer NOT NULL CHECK (item_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, phase)
);

CREATE TABLE run_session_snapshot_items (
  run_id uuid NOT NULL,
  phase text NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, phase, position),
  CONSTRAINT run_session_snapshot_items_snapshot_fk
    FOREIGN KEY (run_id, phase)
    REFERENCES run_session_snapshots(run_id, phase)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION assert_run_session_snapshot_integrity(
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

  IF snapshot_record.phase = 'post' AND snapshot_run.status <> 'completed' THEN
    RAISE EXCEPTION
      'post session snapshot requires a completed Run (run %)',
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

CREATE FUNCTION enforce_run_session_snapshot_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_run_session_snapshot_integrity(NEW.run_id, NEW.phase);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER run_session_snapshots_integrity_trigger
AFTER INSERT ON run_session_snapshots
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_session_snapshot_integrity();

CREATE CONSTRAINT TRIGGER run_session_snapshot_items_integrity_trigger
AFTER INSERT ON run_session_snapshot_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_session_snapshot_integrity();

CREATE FUNCTION enforce_run_session_snapshot_run_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_phase record;
BEGIN
  FOR snapshot_phase IN
    SELECT phase
    FROM run_session_snapshots
    WHERE run_id = NEW.id
  LOOP
    PERFORM assert_run_session_snapshot_integrity(
      NEW.id,
      snapshot_phase.phase
    );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER runs_session_snapshot_status_trigger
AFTER UPDATE OF status ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_session_snapshot_run_status();

CREATE FUNCTION reject_run_session_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A snapshot cannot be edited or removed independently. It still belongs to
  -- the lifecycle of its parent Run, so allow the nested DELETE issued by the
  -- foreign-key cascade when that Run itself is removed.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Run session snapshots are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER run_session_snapshots_immutable_trigger
BEFORE UPDATE OR DELETE ON run_session_snapshots
FOR EACH ROW
EXECUTE FUNCTION reject_run_session_snapshot_mutation();

CREATE TRIGGER run_session_snapshot_items_immutable_trigger
BEFORE UPDATE OR DELETE ON run_session_snapshot_items
FOR EACH ROW
EXECUTE FUNCTION reject_run_session_snapshot_mutation();

-- A first conversation Turn has no predecessor and therefore has a provably
-- empty pre-Run Agent context. No other historical snapshot boundary can be
-- inferred from the conversation-level Session without guessing.
INSERT INTO run_session_snapshots (run_id, phase, item_count)
SELECT run.id, 'pre', 0
FROM runs run
WHERE
  run.status = 'completed'
  AND run.conversation_turn = 1
  AND run.predecessor_run_id IS NULL;

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

    IF
      current_run.predecessor_run_id IS DISTINCT FROM regenerate_source_run.predecessor_run_id
    THEN
      RAISE EXCEPTION
        'regenerate Run must preserve its source predecessor (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM runs direct_successor
      WHERE direct_successor.predecessor_run_id = regenerate_source_run.id
    ) THEN
      RAISE EXCEPTION
        'Run cannot be regenerated after a successor has been created (run %)',
        current_run.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

-- Validate every existing Run under the widened attempt source contract before
-- reinstalling the deferred trigger with regenerate_of_run_id in its column set.
DO $$
DECLARE
  existing_run record;
BEGIN
  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_turn_queue_integrity(existing_run.id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_run_turn_queue_integrity()
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
      OR regenerate_of_run_id = NEW.id
      OR (
        NEW.retry_of_run_id IS NOT NULL
        AND predecessor_run_id = NEW.retry_of_run_id
      )
      OR (
        NEW.regenerate_of_run_id IS NOT NULL
        AND predecessor_run_id = NEW.regenerate_of_run_id
      )
  LOOP
    PERFORM assert_run_turn_queue_integrity(related_run.id);
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER runs_turn_queue_integrity_update_trigger ON runs;

CREATE CONSTRAINT TRIGGER runs_turn_queue_integrity_update_trigger
AFTER UPDATE OF
  user_id,
  conversation_id,
  status,
  input_message_id,
  assistant_message_id,
  conversation_turn,
  attempt_index,
  predecessor_run_id,
  retry_of_run_id,
  regenerate_of_run_id
ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_turn_queue_integrity();
