ALTER TABLE messages
  ADD COLUMN feedback text;

ALTER TABLE messages
  ADD CONSTRAINT messages_feedback_value_check
    CHECK (feedback IS NULL OR feedback IN ('up', 'down')),
  ADD CONSTRAINT messages_user_feedback_null_check
    CHECK (role <> 'user' OR feedback IS NULL);

COMMENT ON COLUMN messages.feedback IS
  'Local platform feedback for assistant messages: up, down, or NULL when unset.';
