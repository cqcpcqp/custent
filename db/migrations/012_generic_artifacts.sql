-- A generated conversation file does not necessarily describe a saved research
-- snapshot. Snapshot exports keep their foreign key; generic files use NULL.
ALTER TABLE artifacts
  ALTER COLUMN research_snapshot_id DROP NOT NULL;

COMMENT ON COLUMN artifacts.research_snapshot_id IS
  'Saved research source for snapshot exports; NULL for conversation-generated files.';
