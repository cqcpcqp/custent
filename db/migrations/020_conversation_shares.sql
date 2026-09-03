CREATE TABLE conversation_shares (
  conversation_id uuid PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  messages jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_shares_conversation_fk
    FOREIGN KEY (conversation_id)
    REFERENCES conversations(id)
    ON DELETE CASCADE,
  CONSTRAINT conversation_shares_messages_nonempty_array_check
    CHECK (
      CASE
        WHEN jsonb_typeof(messages) = 'array'
          THEN jsonb_array_length(messages) > 0
        ELSE false
      END
    ),
  CONSTRAINT conversation_shares_timestamp_order_check
    CHECK (updated_at >= created_at)
);

COMMENT ON TABLE conversation_shares IS
  'Owner-controlled public snapshots of a conversation selected branch.';

COMMENT ON COLUMN conversation_shares.public_id IS
  'Stable opaque UUID used only in the public /share/{publicId} path.';

COMMENT ON COLUMN conversation_shares.messages IS
  'Immutable-at-public-read selected-branch message snapshot refreshed only by an explicit owner PUT.';
