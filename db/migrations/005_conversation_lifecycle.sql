ALTER TABLE conversations
  ADD COLUMN pinned_at timestamptz,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN deleted_at timestamptz;

DROP INDEX conversations_user_updated_idx;

CREATE INDEX conversations_user_active_order_idx
  ON conversations (
    user_id,
    pinned_at DESC NULLS LAST,
    updated_at DESC,
    id DESC
  )
  WHERE deleted_at IS NULL AND archived_at IS NULL;

CREATE INDEX conversations_user_archived_order_idx
  ON conversations (
    user_id,
    pinned_at DESC NULLS LAST,
    updated_at DESC,
    id DESC
  )
  WHERE deleted_at IS NULL AND archived_at IS NOT NULL;
