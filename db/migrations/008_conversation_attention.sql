ALTER TABLE conversations
  ADD COLUMN read_through_terminal_event_id bigint NOT NULL DEFAULT 0
  CHECK (read_through_terminal_event_id >= 0);

UPDATE conversations conversation
SET read_through_terminal_event_id = terminal_event.id
FROM (
  SELECT run.conversation_id, MAX(event.id) AS id
  FROM runs run
  JOIN run_events event ON event.run_id = run.id
  WHERE
    run.status IN (
      'completed',
      'failed',
      'cancelled',
      'reconciliation_required'
    )
    AND event.event_type IN ('done', 'error')
  GROUP BY run.conversation_id
) terminal_event
WHERE terminal_event.conversation_id = conversation.id;
