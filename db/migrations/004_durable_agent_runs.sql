DROP INDEX messages_run_id_unique_idx;

CREATE UNIQUE INDEX messages_run_role_unique_idx
  ON messages (run_id, role)
  WHERE run_id IS NOT NULL;

DROP INDEX runs_conversation_active_unique_idx;

ALTER TABLE runs
  DROP CONSTRAINT runs_status_check,
  DROP CONSTRAINT runs_check,
  DROP CONSTRAINT runs_check1,
  DROP CONSTRAINT runs_usage_matches_status_check;

ALTER TABLE runs
  ADD COLUMN input_message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
  ADD COLUMN assistant_message_id uuid,
  ADD COLUMN failure_code text,
  ADD COLUMN failure_message text,
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN lease_owner uuid,
  ADD COLUMN lease_token bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN model_started_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

UPDATE runs
SET status = 'queued'
WHERE status = 'reserved';

UPDATE runs run
SET assistant_message_id = message.id
FROM messages message
WHERE message.run_id = run.id AND message.role = 'assistant';

UPDATE runs
SET finished_at = COALESCE(completed_at, updated_at)
WHERE status IN ('completed', 'reconciliation_required');

UPDATE runs
SET
  failure_code = 'RUN_REQUIRES_RECONCILIATION',
  failure_message = '这次运行需要积分对账。'
WHERE status = 'reconciliation_required';

ALTER TABLE runs
  ADD CONSTRAINT runs_status_check
  CHECK (
    status IN (
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'reconciliation_required'
    )
  ),
  ADD CONSTRAINT runs_completion_matches_status_check
  CHECK (
    (
      status = 'completed'
      AND charged_credits IS NOT NULL
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND web_searches IS NOT NULL
      AND completed_at IS NOT NULL
      AND finished_at IS NOT NULL
    )
    OR
    (
      status <> 'completed'
      AND charged_credits IS NULL
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND web_searches IS NULL
      AND completed_at IS NULL
    )
  ),
  ADD CONSTRAINT runs_failure_matches_status_check
  CHECK (
    (
      status IN ('failed', 'cancelled', 'reconciliation_required')
      AND failure_code IS NOT NULL
      AND failure_message IS NOT NULL
      AND finished_at IS NOT NULL
    )
    OR
    (
      status IN ('queued', 'running')
      AND failure_code IS NULL
      AND failure_message IS NULL
      AND finished_at IS NULL
    )
    OR
    (
      status = 'completed'
      AND failure_code IS NULL
      AND failure_message IS NULL
      AND finished_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT runs_reconciliation_matches_status_check
  CHECK (
    (status = 'reconciliation_required' AND reconciliation_reason IS NOT NULL)
    OR
    (status <> 'reconciliation_required' AND reconciliation_reason IS NULL)
  ),
  ADD CONSTRAINT runs_lease_shape_check
  CHECK (
    (
      status = 'running'
      AND (
        (
          lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
          AND heartbeat_at IS NOT NULL
        )
        OR
        (
          lease_owner IS NULL
          AND lease_expires_at IS NULL
          AND heartbeat_at IS NULL
        )
      )
    )
    OR
    (
      status <> 'running'
      AND lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND heartbeat_at IS NULL
    )
  );

CREATE UNIQUE INDEX runs_input_message_unique_idx
  ON runs (input_message_id)
  WHERE input_message_id IS NOT NULL;

CREATE UNIQUE INDEX runs_assistant_message_unique_idx
  ON runs (assistant_message_id)
  WHERE assistant_message_id IS NOT NULL;

CREATE UNIQUE INDEX runs_conversation_active_unique_idx
  ON runs (conversation_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX runs_queue_created_idx
  ON runs (created_at, id)
  WHERE status = 'queued';

CREATE INDEX runs_expired_lease_idx
  ON runs (lease_expires_at, id)
  WHERE status = 'running';

ALTER TABLE credit_ledger
  DROP CONSTRAINT credit_ledger_entry_type_check;

ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_entry_type_check
  CHECK (entry_type IN ('grant', 'reserve', 'release', 'settle', 'freeze'));

CREATE TABLE run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN (
      'status',
      'reasoning',
      'web_search',
      'tool_started',
      'tool_completed',
      'delta',
      'artifact',
      'done',
      'error'
    )
  ),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload ->> 'type' = event_type
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_events_run_id_id_idx ON run_events (run_id, id);
