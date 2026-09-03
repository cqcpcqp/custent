CREATE INDEX runs_user_terminal_finished_idx
  ON runs (user_id, finished_at DESC, id DESC)
  WHERE status IN (
    'completed',
    'failed',
    'cancelled',
    'reconciliation_required'
  );
