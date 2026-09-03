ALTER TABLE users
  ADD COLUMN custom_instructions_enabled boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN custom_instructions_content text NOT NULL DEFAULT '',
  ADD COLUMN custom_instructions_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN custom_instructions_updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE users
  ADD CONSTRAINT users_custom_instructions_content_check CHECK (
    length(custom_instructions_content) <= 4000
    AND (
      custom_instructions_enabled IS FALSE
      OR custom_instructions_content ~ '[^[:space:]]'
    )
  ),
  ADD CONSTRAINT users_custom_instructions_revision_check CHECK (
    custom_instructions_revision >= 0
    AND (
      custom_instructions_enabled IS FALSE
      OR custom_instructions_revision > 0
    )
  );

ALTER TABLE conversations
  ADD COLUMN custom_instructions_snapshot text,
  ADD COLUMN custom_instructions_snapshot_revision integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT conversations_custom_instructions_snapshot_shape_check CHECK (
    (
      custom_instructions_snapshot IS NULL
      AND custom_instructions_snapshot_revision = 0
    )
    OR
    (
      custom_instructions_snapshot IS NOT NULL
      AND length(custom_instructions_snapshot) <= 4000
      AND custom_instructions_snapshot ~ '[^[:space:]]'
      AND custom_instructions_snapshot_revision > 0
    )
  );

CREATE FUNCTION reject_conversation_custom_instructions_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.custom_instructions_snapshot
      IS DISTINCT FROM OLD.custom_instructions_snapshot
    OR NEW.custom_instructions_snapshot_revision
      IS DISTINCT FROM OLD.custom_instructions_snapshot_revision
  THEN
    RAISE EXCEPTION 'Conversation custom instructions snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER conversations_custom_instructions_snapshot_immutable_trigger
BEFORE UPDATE OF
  custom_instructions_snapshot,
  custom_instructions_snapshot_revision
ON conversations
FOR EACH ROW
EXECUTE FUNCTION reject_conversation_custom_instructions_snapshot_mutation();

COMMENT ON COLUMN users.custom_instructions_enabled IS
  'Whether newly created conversations capture the account custom instructions.';

COMMENT ON COLUMN users.custom_instructions_content IS
  'Raw account custom instructions retained even while disabled.';

COMMENT ON COLUMN users.custom_instructions_revision IS
  'Optimistic-concurrency revision incremented by each successful setting update.';

COMMENT ON COLUMN conversations.custom_instructions_snapshot IS
  'Immutable raw custom instructions captured when this conversation was created; NULL means disabled or historical.';

COMMENT ON COLUMN conversations.custom_instructions_snapshot_revision IS
  'Captured account setting revision; zero exactly when no snapshot is present.';
