CREATE TABLE input_attachments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  position integer,
  kind text NOT NULL CHECK (kind IN ('file', 'image')),
  original_name text NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  mime_type text NOT NULL CHECK (
    mime_type IN ('text/plain', 'application/pdf', 'image/png')
  ),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  attached_at timestamptz,
  expires_at timestamptz,
  CONSTRAINT input_attachments_kind_mime_type_check CHECK (
    (kind = 'image' AND mime_type = 'image/png')
    OR
    (
      kind = 'file'
      AND mime_type IN ('text/plain', 'application/pdf')
    )
  ),
  CONSTRAINT input_attachments_state_check CHECK (
    (
      message_id IS NULL
      AND position IS NULL
      AND attached_at IS NULL
      AND expires_at IS NOT NULL
    )
    OR
    (
      message_id IS NOT NULL
      AND position IS NOT NULL
      AND position >= 0
      AND attached_at IS NOT NULL
      AND expires_at IS NULL
    )
  )
);

CREATE UNIQUE INDEX input_attachments_message_position_unique_idx
  ON input_attachments (message_id, position)
  WHERE message_id IS NOT NULL;

CREATE INDEX input_attachments_user_staged_created_idx
  ON input_attachments (user_id, created_at, id)
  WHERE message_id IS NULL;

CREATE INDEX input_attachments_staged_expiry_idx
  ON input_attachments (expires_at, id)
  WHERE message_id IS NULL;

ALTER TABLE run_events
  DROP CONSTRAINT run_events_event_type_check;

ALTER TABLE run_events
  ADD CONSTRAINT run_events_event_type_check CHECK (
    event_type IN (
      'status',
      'reasoning',
      'web_search',
      'tool_started',
      'tool_completed',
      'delta',
      'artifact',
      'attachment',
      'done',
      'error'
    )
  );
