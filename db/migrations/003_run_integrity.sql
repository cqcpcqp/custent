CREATE UNIQUE INDEX runs_conversation_active_unique_idx
  ON runs (conversation_id)
  WHERE status IN ('reserved', 'running');

ALTER TABLE runs
  ADD CONSTRAINT runs_usage_matches_status_check
  CHECK (
    (
      status = 'completed'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND web_searches IS NOT NULL
    )
    OR
    (
      status <> 'completed'
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND web_searches IS NULL
    )
  );
