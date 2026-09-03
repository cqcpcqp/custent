LOCK TABLE
  conversations,
  runs,
  messages,
  input_attachments
IN SHARE ROW EXCLUSIVE MODE;

-- The selected Run is the durable head of the branch currently shown to the
-- user. Empty conversations have no head. Existing conversations predate
-- branching, so their unique graph leaf is the only deterministic backfill;
-- timestamps are deliberately not part of this migration.
ALTER TABLE conversations
  ADD COLUMN selected_run_id uuid;

DO $$
DECLARE
  invalid_conversations text;
BEGIN
  SELECT string_agg(
    format('%s (leaves=%s)', graph.conversation_id, graph.leaf_count),
    ', '
    ORDER BY graph.conversation_id
  )
  INTO invalid_conversations
  FROM (
    SELECT
      conversation.id AS conversation_id,
      count(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1
          FROM runs successor
          WHERE
            successor.predecessor_run_id = run.id
            OR successor.retry_of_run_id = run.id
            OR successor.regenerate_of_run_id = run.id
        )
      ) AS leaf_count
    FROM conversations conversation
    JOIN runs run ON run.conversation_id = conversation.id
    GROUP BY conversation.id
  ) graph
  WHERE graph.leaf_count <> 1;

  IF invalid_conversations IS NOT NULL THEN
    RAISE EXCEPTION
      '016 requires exactly one structural Run leaf per historical non-empty conversation: %',
      invalid_conversations
      USING ERRCODE = '23514';
  END IF;
END;
$$;

WITH historical_leaf AS (
  SELECT run.conversation_id, run.id AS run_id
  FROM runs run
  WHERE NOT EXISTS (
    SELECT 1
    FROM runs successor
    WHERE
      successor.predecessor_run_id = run.id
      OR successor.retry_of_run_id = run.id
      OR successor.regenerate_of_run_id = run.id
  )
)
UPDATE conversations conversation
SET selected_run_id = historical_leaf.run_id
FROM historical_leaf
WHERE historical_leaf.conversation_id = conversation.id;

DO $$
DECLARE
  invalid_conversations text;
BEGIN
  SELECT string_agg(conversation.id::text, ', ' ORDER BY conversation.id)
  INTO invalid_conversations
  FROM conversations conversation
  WHERE
    (
      EXISTS (
        SELECT 1
        FROM runs run
        WHERE run.conversation_id = conversation.id
      )
      AND conversation.selected_run_id IS NULL
    )
    OR (
      NOT EXISTS (
        SELECT 1
        FROM runs run
        WHERE run.conversation_id = conversation.id
      )
      AND conversation.selected_run_id IS NOT NULL
    );

  IF invalid_conversations IS NOT NULL THEN
    RAISE EXCEPTION
      '016 failed to backfill conversation branch heads: %',
      invalid_conversations
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_selected_run_fk
    FOREIGN KEY (selected_run_id)
    REFERENCES runs(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX conversations_selected_run_idx
  ON conversations (selected_run_id)
  WHERE selected_run_id IS NOT NULL;

COMMENT ON COLUMN conversations.selected_run_id IS
  'Run at the head of the conversation branch currently selected by the user; NULL only while the conversation has no Runs.';

CREATE FUNCTION assert_conversation_selected_run_integrity(
  target_conversation_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_conversation conversations%ROWTYPE;
  selected_run runs%ROWTYPE;
  has_runs boolean;
BEGIN
  SELECT *
  INTO current_conversation
  FROM conversations
  WHERE id = target_conversation_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM runs run
    WHERE run.conversation_id = current_conversation.id
  )
  INTO has_runs;

  IF NOT has_runs THEN
    IF current_conversation.selected_run_id IS NOT NULL THEN
      RAISE EXCEPTION
        'empty conversation must not select a Run (conversation %)',
        current_conversation.id
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  IF current_conversation.selected_run_id IS NULL THEN
    RAISE EXCEPTION
      'non-empty conversation must select a Run (conversation %)',
      current_conversation.id
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO selected_run
  FROM runs
  WHERE id = current_conversation.selected_run_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'selected Run % does not exist (conversation %)',
      current_conversation.selected_run_id,
      current_conversation.id
      USING ERRCODE = '23503';
  END IF;

  IF
    selected_run.conversation_id IS DISTINCT FROM current_conversation.id
    OR selected_run.user_id IS DISTINCT FROM current_conversation.user_id
  THEN
    RAISE EXCEPTION
      'selected Run must belong to the same user and conversation (conversation %)',
      current_conversation.id
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION enforce_conversation_selected_run_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_conversation_selected_run_integrity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER conversations_selected_run_integrity_insert_trigger
AFTER INSERT ON conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_conversation_selected_run_integrity();

CREATE CONSTRAINT TRIGGER conversations_selected_run_integrity_update_trigger
AFTER UPDATE OF user_id, selected_run_id ON conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_conversation_selected_run_integrity();

CREATE FUNCTION enforce_run_conversation_selection_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_conversation_selected_run_integrity(OLD.conversation_id);
    RETURN NULL;
  END IF;

  PERFORM assert_conversation_selected_run_integrity(NEW.conversation_id);

  IF
    TG_OP = 'UPDATE'
    AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id
  THEN
    PERFORM assert_conversation_selected_run_integrity(OLD.conversation_id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER runs_conversation_selection_integrity_insert_trigger
AFTER INSERT ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_conversation_selection_integrity();

CREATE CONSTRAINT TRIGGER runs_conversation_selection_integrity_update_trigger
AFTER UPDATE OF user_id, conversation_id ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_conversation_selection_integrity();

CREATE CONSTRAINT TRIGGER runs_conversation_selection_integrity_delete_trigger
AFTER DELETE ON runs
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_run_conversation_selection_integrity();

-- Attempts are scoped to one immutable input message. This permits two
-- different user inputs to occupy the same conversation depth while retaining
-- an unambiguous, adjacent answer-attempt sequence for each input.
DROP INDEX runs_conversation_turn_attempt_unique_idx;
DROP INDEX runs_initial_input_message_unique_idx;

CREATE UNIQUE INDEX runs_input_message_attempt_unique_idx
  ON runs (input_message_id, attempt_index);

-- Two concurrent appends against one selected parent must not create two
-- waiting successors. Once a successor leaves waiting, historical siblings
-- remain representable and another branch may be appended deliberately.
CREATE UNIQUE INDEX runs_waiting_predecessor_unique_idx
  ON runs (predecessor_run_id)
  WHERE status = 'waiting' AND predecessor_run_id IS NOT NULL;

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
      AND predecessor_run.status <> 'completed'
    THEN
      RAISE EXCEPTION
        'executable Run requires a completed predecessor (run %)',
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

-- Normalize the attachment/message relationship before editable messages can
-- create branches. The blob metadata remains one row, while immutable old and
-- new user messages may each reference it in their own order.
CREATE TABLE message_input_attachments (
  message_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  CONSTRAINT message_input_attachments_pkey
    PRIMARY KEY (message_id, attachment_id),
  CONSTRAINT message_input_attachments_message_position_key
    UNIQUE (message_id, position),
  CONSTRAINT message_input_attachments_message_fk
    FOREIGN KEY (message_id)
    REFERENCES messages(id)
    ON DELETE CASCADE,
  CONSTRAINT message_input_attachments_attachment_fk
    FOREIGN KEY (attachment_id)
    REFERENCES input_attachments(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX message_input_attachments_attachment_idx
  ON message_input_attachments (attachment_id, message_id);

INSERT INTO message_input_attachments (message_id, attachment_id, position)
SELECT attachment.message_id, attachment.id, attachment.position
FROM input_attachments attachment
WHERE attachment.message_id IS NOT NULL;

DO $$
DECLARE
  invalid_attachments text;
BEGIN
  SELECT string_agg(attachment.id::text, ', ' ORDER BY attachment.id)
  INTO invalid_attachments
  FROM input_attachments attachment
  LEFT JOIN message_input_attachments link
    ON link.attachment_id = attachment.id
  WHERE
    (
      attachment.message_id IS NULL
      AND link.attachment_id IS NOT NULL
    )
    OR (
      attachment.message_id IS NOT NULL
      AND (
        link.attachment_id IS NULL
        OR link.message_id IS DISTINCT FROM attachment.message_id
        OR link.position IS DISTINCT FROM attachment.position
      )
    );

  IF invalid_attachments IS NOT NULL THEN
    RAISE EXCEPTION
      '016 failed to backfill input attachment message links exactly: %',
      invalid_attachments
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(attachment.id::text, ', ' ORDER BY attachment.id)
  INTO invalid_attachments
  FROM input_attachments attachment
  JOIN message_input_attachments link ON link.attachment_id = attachment.id
  JOIN messages message ON message.id = link.message_id
  JOIN conversations conversation ON conversation.id = message.conversation_id
  WHERE
    message.role <> 'user'
    OR conversation.user_id IS DISTINCT FROM attachment.user_id;

  IF invalid_attachments IS NOT NULL THEN
    RAISE EXCEPTION
      '016 found input attachments linked to a non-user or foreign-owned message: %',
      invalid_attachments
      USING ERRCODE = '23514';
  END IF;
END;
$$;

DROP TRIGGER input_attachments_message_owner_trigger ON input_attachments;
DROP FUNCTION enforce_input_attachment_message_owner();
DROP INDEX input_attachments_message_position_unique_idx;

ALTER TABLE input_attachments
  DROP CONSTRAINT input_attachments_state_check,
  DROP COLUMN message_id,
  DROP COLUMN position;

ALTER TABLE input_attachments
  ADD CONSTRAINT input_attachments_state_check CHECK (
    (
      attached_at IS NULL
      AND expires_at IS NOT NULL
    )
    OR
    (
      attached_at IS NOT NULL
      AND expires_at IS NULL
    )
  );

-- Dropping the legacy message_id column also drops both staged partial indexes
-- because their predicates referenced that column. Recreate the same lifecycle
-- access paths against the normalized staged-state discriminator.
CREATE INDEX input_attachments_user_staged_created_idx
  ON input_attachments (user_id, created_at, id)
  WHERE attached_at IS NULL;

CREATE INDEX input_attachments_staged_expiry_idx
  ON input_attachments (expires_at, id)
  WHERE attached_at IS NULL;

CREATE FUNCTION assert_message_input_attachment_integrity(
  target_message_id uuid,
  target_attachment_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  link_record message_input_attachments%ROWTYPE;
  linked_message messages%ROWTYPE;
  message_conversation conversations%ROWTYPE;
  linked_attachment input_attachments%ROWTYPE;
BEGIN
  SELECT *
  INTO link_record
  FROM message_input_attachments
  WHERE
    message_id = target_message_id
    AND attachment_id = target_attachment_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT *
  INTO linked_message
  FROM messages
  WHERE id = link_record.message_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'input attachment message % does not exist',
      link_record.message_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO message_conversation
  FROM conversations
  WHERE id = linked_message.conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'input attachment message conversation % does not exist',
      linked_message.conversation_id
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO linked_attachment
  FROM input_attachments
  WHERE id = link_record.attachment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'input attachment % does not exist',
      link_record.attachment_id
      USING ERRCODE = '23503';
  END IF;

  IF linked_message.role <> 'user' THEN
    RAISE EXCEPTION
      'input attachments may only belong to user messages (message %)',
      linked_message.id
      USING ERRCODE = '23514';
  END IF;

  IF message_conversation.user_id IS DISTINCT FROM linked_attachment.user_id THEN
    RAISE EXCEPTION
      'input attachment owner must match message conversation owner (attachment %, message %)',
      linked_attachment.id,
      linked_message.id
      USING ERRCODE = '23514';
  END IF;

  IF
    linked_attachment.attached_at IS NULL
    OR linked_attachment.expires_at IS NOT NULL
  THEN
    RAISE EXCEPTION
      'a staged input attachment cannot be linked to a message (attachment %)',
      linked_attachment.id
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION assert_input_attachment_binding_integrity(
  target_attachment_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  current_attachment input_attachments%ROWTYPE;
  has_message_links boolean;
  linked_message record;
BEGIN
  SELECT *
  INTO current_attachment
  FROM input_attachments
  WHERE id = target_attachment_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM message_input_attachments link
    WHERE link.attachment_id = current_attachment.id
  )
  INTO has_message_links;

  IF current_attachment.attached_at IS NULL THEN
    IF has_message_links THEN
      RAISE EXCEPTION
        'staged input attachment must not have message links (attachment %)',
        current_attachment.id
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  IF NOT has_message_links THEN
    RAISE EXCEPTION
      'attached input attachment requires at least one message link (attachment %)',
      current_attachment.id
      USING ERRCODE = '23514';
  END IF;

  FOR linked_message IN
    SELECT message_id
    FROM message_input_attachments
    WHERE attachment_id = current_attachment.id
  LOOP
    PERFORM assert_message_input_attachment_integrity(
      linked_message.message_id,
      current_attachment.id
    );
  END LOOP;
END;
$$;

CREATE FUNCTION enforce_message_input_attachment_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_message_input_attachment_integrity(
    NEW.message_id,
    NEW.attachment_id
  );
  PERFORM assert_input_attachment_binding_integrity(NEW.attachment_id);

  IF
    TG_OP = 'UPDATE'
    AND OLD.attachment_id IS DISTINCT FROM NEW.attachment_id
  THEN
    PERFORM assert_input_attachment_binding_integrity(OLD.attachment_id);
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER message_input_attachments_integrity_insert_trigger
AFTER INSERT ON message_input_attachments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_message_input_attachment_integrity();

CREATE CONSTRAINT TRIGGER message_input_attachments_integrity_update_trigger
AFTER UPDATE OF message_id, attachment_id ON message_input_attachments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_message_input_attachment_integrity();

CREATE FUNCTION cleanup_unreferenced_input_attachment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO input_attachment_deletions (
    attachment_id,
    user_id,
    storage_path
  )
  SELECT
    attachment.id,
    attachment.user_id,
    attachment.storage_path
  FROM input_attachments attachment
  WHERE
    attachment.id = OLD.attachment_id
    AND attachment.attached_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM message_input_attachments remaining_link
      WHERE remaining_link.attachment_id = attachment.id
    )
  ON CONFLICT (attachment_id) DO NOTHING;

  DELETE FROM input_attachments attachment
  WHERE
    attachment.id = OLD.attachment_id
    AND attachment.attached_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM message_input_attachments remaining_link
      WHERE remaining_link.attachment_id = attachment.id
    );

  PERFORM assert_input_attachment_binding_integrity(OLD.attachment_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER message_input_attachments_cleanup_delete_trigger
AFTER DELETE ON message_input_attachments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION cleanup_unreferenced_input_attachment();

CREATE FUNCTION enforce_input_attachment_binding_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_input_attachment_binding_integrity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER input_attachments_binding_integrity_insert_trigger
AFTER INSERT ON input_attachments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_input_attachment_binding_integrity();

CREATE CONSTRAINT TRIGGER input_attachments_binding_integrity_update_trigger
AFTER UPDATE OF user_id, attached_at, expires_at ON input_attachments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_input_attachment_binding_integrity();

CREATE FUNCTION enforce_message_input_attachment_message_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_attachment record;
BEGIN
  FOR linked_attachment IN
    SELECT attachment_id
    FROM message_input_attachments
    WHERE message_id = NEW.id
  LOOP
    PERFORM assert_message_input_attachment_integrity(
      NEW.id,
      linked_attachment.attachment_id
    );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER messages_input_attachment_integrity_update_trigger
AFTER UPDATE OF conversation_id, role ON messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_message_input_attachment_message_integrity();

CREATE FUNCTION enforce_conversation_input_attachment_owner_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_attachment record;
BEGIN
  FOR linked_attachment IN
    SELECT link.message_id, link.attachment_id
    FROM messages message
    JOIN message_input_attachments link ON link.message_id = message.id
    WHERE message.conversation_id = NEW.id
  LOOP
    PERFORM assert_message_input_attachment_integrity(
      linked_attachment.message_id,
      linked_attachment.attachment_id
    );
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER conversations_input_attachment_owner_update_trigger
AFTER UPDATE OF user_id ON conversations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_conversation_input_attachment_owner_integrity();

-- Validate the normalized state before committing the migration. Future writes
-- are covered by the deferred constraint triggers above.
DO $$
DECLARE
  existing_conversation record;
  existing_attachment record;
BEGIN
  FOR existing_conversation IN SELECT id FROM conversations LOOP
    PERFORM assert_conversation_selected_run_integrity(existing_conversation.id);
  END LOOP;

  FOR existing_attachment IN SELECT id FROM input_attachments LOOP
    PERFORM assert_input_attachment_binding_integrity(existing_attachment.id);
  END LOOP;
END;
$$;
