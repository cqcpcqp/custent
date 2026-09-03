CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX conversations_title_search_trgm_idx
  ON conversations USING gin (title gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX messages_content_search_trgm_idx
  ON messages USING gin (content gin_trgm_ops);
