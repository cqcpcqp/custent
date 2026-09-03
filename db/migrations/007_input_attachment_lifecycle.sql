ALTER TABLE runs
  ADD COLUMN request_fingerprint text CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE input_attachments
  ADD CONSTRAINT input_attachments_storage_path_matches_id_check
  CHECK (storage_path = id::text);

CREATE FUNCTION enforce_input_attachment_message_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM messages message
    JOIN conversations conversation
      ON conversation.id = message.conversation_id
    WHERE
      message.id = NEW.message_id
      AND conversation.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'input attachment owner must match message conversation owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER input_attachments_message_owner_trigger
BEFORE INSERT OR UPDATE ON input_attachments
FOR EACH ROW
EXECUTE FUNCTION enforce_input_attachment_message_owner();

CREATE TABLE input_attachment_deletions (
  attachment_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_path text NOT NULL CHECK (storage_path = attachment_id::text),
  deleted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  CHECK (
    (completed_at IS NULL)
    OR
    (completed_at IS NOT NULL AND last_error IS NULL)
  )
);

CREATE INDEX input_attachment_deletions_pending_idx
  ON input_attachment_deletions (next_attempt_at, deleted_at, attachment_id)
  WHERE completed_at IS NULL;
