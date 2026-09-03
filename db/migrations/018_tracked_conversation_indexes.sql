CREATE INDEX runs_user_pending_conversation_order_idx
  ON runs (user_id, conversation_id, created_at DESC, id DESC)
  WHERE status IN ('waiting', 'queued', 'running');

CREATE INDEX runs_user_terminal_conversation_idx
  ON runs (user_id, conversation_id, id)
  WHERE status IN (
    'completed',
    'failed',
    'cancelled',
    'reconciliation_required'
  );

CREATE INDEX run_events_terminal_run_id_id_idx
  ON run_events (run_id, id DESC)
  WHERE event_type IN ('done', 'error');
