ALTER TABLE messages
  ADD COLUMN run_id uuid REFERENCES runs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX messages_run_id_unique_idx
  ON messages (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX artifacts_run_message_idx
  ON artifacts (run_id, message_id);
