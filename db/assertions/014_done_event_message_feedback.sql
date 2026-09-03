-- Repeatable PostgreSQL assertions for 014_done_event_message_feedback.sql.
BEGIN;

DO $$
DECLARE
  invalid_done_events text;
BEGIN
  SELECT string_agg(event.id::text, ', ' ORDER BY event.id)
  INTO invalid_done_events
  FROM run_events event
  WHERE
    event.event_type = 'done'
    AND (
      jsonb_typeof(event.payload -> 'message') IS DISTINCT FROM 'object'
      OR NOT ((event.payload -> 'message') ? 'feedback')
      OR (
        event.payload -> 'message' -> 'feedback' <> 'null'::jsonb
        AND event.payload -> 'message' ->> 'feedback' NOT IN ('up', 'down')
      )
      OR (
        event.payload -> 'message' ->> 'role' = 'user'
        AND event.payload -> 'message' -> 'feedback' <> 'null'::jsonb
      )
    );

  IF invalid_done_events IS NOT NULL THEN
    RAISE EXCEPTION
      '014 assertion: done events contain invalid message feedback: %',
      invalid_done_events
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ROLLBACK;
