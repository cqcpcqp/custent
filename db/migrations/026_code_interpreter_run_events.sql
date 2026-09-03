ALTER TABLE run_events
  DROP CONSTRAINT run_events_event_type_check;

ALTER TABLE run_events
  ADD CONSTRAINT run_events_event_type_check CHECK (
    event_type IN (
      'status',
      'reasoning',
      'web_search',
      'code_interpreter_status',
      'code_interpreter_code',
      'code_interpreter_result',
      'tool_started',
      'tool_completed',
      'delta',
      'artifact',
      'attachment',
      'done',
      'error'
    )
  );
