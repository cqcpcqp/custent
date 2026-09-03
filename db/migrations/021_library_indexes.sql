CREATE INDEX research_snapshots_user_library_created_idx
  ON research_snapshots (user_id, created_at DESC, id DESC);

CREATE INDEX artifacts_user_library_created_idx
  ON artifacts (user_id, created_at DESC, id DESC)
  WHERE message_id IS NOT NULL;
