CREATE OR REPLACE FUNCTION assert_conversation_context_seed_integrity(
  target_conversation_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  seed conversation_context_seeds%ROWTYPE;
  target_conversation conversations%ROWTYPE;
  source_conversation conversations%ROWTYPE;
  source_message messages%ROWTYPE;
  source_run runs%ROWTYPE;
  actual_item_count integer;
  first_position integer;
  last_position integer;
BEGIN
  SELECT *
  INTO seed
  FROM conversation_context_seeds
  WHERE conversation_id = target_conversation_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO target_conversation
  FROM conversations
  WHERE id = seed.conversation_id;

  SELECT * INTO source_conversation
  FROM conversations
  WHERE id = seed.source_conversation_id;

  SELECT * INTO source_message
  FROM messages
  WHERE id = seed.source_message_id;

  SELECT * INTO source_run
  FROM runs
  WHERE id = seed.source_run_id;

  IF
    target_conversation.id IS NULL
    OR source_conversation.id IS NULL
    OR source_message.id IS NULL
    OR source_run.id IS NULL
  THEN
    RAISE EXCEPTION
      'conversation context seed references missing source data (conversation %)',
      seed.conversation_id
      USING ERRCODE = '23503';
  END IF;

  IF
    target_conversation.user_id IS DISTINCT FROM seed.user_id
    OR source_conversation.user_id IS DISTINCT FROM seed.user_id
    OR source_message.conversation_id IS DISTINCT FROM source_conversation.id
    OR source_message.role <> 'assistant'
    OR source_message.run_id IS DISTINCT FROM source_run.id
    OR source_run.user_id IS DISTINCT FROM seed.user_id
    OR source_run.conversation_id IS DISTINCT FROM source_conversation.id
    OR source_run.assistant_message_id IS DISTINCT FROM source_message.id
    OR source_run.status <> 'completed'
  THEN
    RAISE EXCEPTION
      'conversation context seed source ownership or identity is inconsistent (conversation %)',
      seed.conversation_id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    count(*)::integer,
    min(seed_item.position),
    max(seed_item.position)
  INTO actual_item_count, first_position, last_position
  FROM conversation_context_seed_items seed_item
  WHERE seed_item.conversation_id = seed.conversation_id;

  IF
    actual_item_count IS DISTINCT FROM seed.item_count
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
      'conversation context seed item positions/count are inconsistent (conversation %, expected %, actual %, first %, last %)',
      seed.conversation_id,
      seed.item_count,
      actual_item_count,
      first_position,
      last_position
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION assert_conversation_context_seed_creation_state(
  target_conversation_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_conversation conversations%ROWTYPE;
BEGIN
  SELECT conversation.*
  INTO target_conversation
  FROM conversations conversation
  WHERE conversation.id = target_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'conversation context seed target conversation % does not exist',
      target_conversation_id
      USING ERRCODE = '23503';
  END IF;

  IF
    target_conversation.selected_run_id IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM runs target_run
      WHERE target_run.conversation_id = target_conversation.id
    )
  THEN
    RAISE EXCEPTION
      'conversation context seed must be created before the target conversation has Runs (conversation %)',
      target_conversation.id
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION enforce_conversation_context_seed_creation_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_conversation_context_seed_creation_state(NEW.conversation_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversation_context_seeds_creation_state_trigger
BEFORE INSERT ON conversation_context_seeds
FOR EACH ROW
EXECUTE FUNCTION enforce_conversation_context_seed_creation_state();

DO $$
DECLARE
  existing_seed record;
BEGIN
  FOR existing_seed IN
    SELECT conversation_id FROM conversation_context_seeds
  LOOP
    PERFORM assert_conversation_context_seed_integrity(
      existing_seed.conversation_id
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION assert_conversation_context_seed_creation_state(uuid) IS
  'Locks and verifies that a context seed target has no selected Run or persisted Runs at seed creation time.';
