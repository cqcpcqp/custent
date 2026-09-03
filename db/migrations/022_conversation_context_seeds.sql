CREATE TABLE conversation_context_seeds (
  conversation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  source_conversation_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  source_run_id uuid NOT NULL,
  item_count integer NOT NULL CHECK (item_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_context_seeds_conversation_fk
    FOREIGN KEY (conversation_id)
    REFERENCES conversations(id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_context_seeds_user_fk
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_context_seeds_source_conversation_fk
    FOREIGN KEY (source_conversation_id)
    REFERENCES conversations(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT conversation_context_seeds_source_message_fk
    FOREIGN KEY (source_message_id)
    REFERENCES messages(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT conversation_context_seeds_source_run_fk
    FOREIGN KEY (source_run_id)
    REFERENCES runs(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT conversation_context_seeds_distinct_conversations_check
    CHECK (conversation_id <> source_conversation_id)
);

CREATE TABLE conversation_context_seed_items (
  conversation_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, position),
  CONSTRAINT conversation_context_seed_items_seed_fk
    FOREIGN KEY (conversation_id)
    REFERENCES conversation_context_seeds(conversation_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE conversation_branch_requests (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  source_conversation_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  target_conversation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_branch_requests_user_fk
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_branch_requests_source_conversation_fk
    FOREIGN KEY (source_conversation_id)
    REFERENCES conversations(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT conversation_branch_requests_source_message_fk
    FOREIGN KEY (source_message_id)
    REFERENCES messages(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT conversation_branch_requests_target_conversation_fk
    FOREIGN KEY (target_conversation_id)
    REFERENCES conversations(id)
    ON DELETE CASCADE
);

CREATE INDEX conversation_context_seeds_source_run_idx
  ON conversation_context_seeds (source_run_id);

CREATE INDEX conversation_branch_requests_source_idx
  ON conversation_branch_requests (
    user_id,
    source_conversation_id,
    source_message_id,
    created_at
  );

CREATE FUNCTION assert_conversation_context_seed_integrity(
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

CREATE FUNCTION enforce_conversation_context_seed_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_conversation_context_seed_integrity(NEW.conversation_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER conversation_context_seeds_integrity_trigger
AFTER INSERT ON conversation_context_seeds
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_conversation_context_seed_integrity();

CREATE CONSTRAINT TRIGGER conversation_context_seed_items_integrity_trigger
AFTER INSERT ON conversation_context_seed_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_conversation_context_seed_integrity();

CREATE FUNCTION reject_conversation_context_seed_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'conversation context seeds are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER conversation_context_seeds_immutable_trigger
BEFORE UPDATE OR DELETE ON conversation_context_seeds
FOR EACH ROW
EXECUTE FUNCTION reject_conversation_context_seed_mutation();

CREATE TRIGGER conversation_context_seed_items_immutable_trigger
BEFORE UPDATE OR DELETE ON conversation_context_seed_items
FOR EACH ROW
EXECUTE FUNCTION reject_conversation_context_seed_mutation();

COMMENT ON TABLE conversation_context_seeds IS
  'Immutable Agent context copied when an existing assistant message starts a new conversation; it is consumed only by the target conversation root Run.';

COMMENT ON TABLE conversation_branch_requests IS
  'Idempotency receipts for creating a new conversation from an existing message.';
