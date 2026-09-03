CREATE INDEX conversation_shares_management_order_idx
  ON conversation_shares (updated_at DESC, conversation_id DESC);
