-- Repeatable PostgreSQL assertions for 012_generic_artifacts.sql.
-- This script never mutates durable data and always rolls its transaction back.
BEGIN;

DO $$
DECLARE
  nullable_value text;
  snapshot_foreign_key_exists boolean;
  invalid_artifacts text;
BEGIN
  SELECT column_info.is_nullable
  INTO nullable_value
  FROM information_schema.columns column_info
  WHERE
    column_info.table_schema = current_schema()
    AND column_info.table_name = 'artifacts'
    AND column_info.column_name = 'research_snapshot_id';

  IF nullable_value IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION
      '012 assertion: artifacts.research_snapshot_id must be nullable'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    WHERE
      constraint_info.conrelid = 'artifacts'::regclass
      AND constraint_info.confrelid = 'research_snapshots'::regclass
      AND constraint_info.contype = 'f'
  )
  INTO snapshot_foreign_key_exists;

  IF NOT snapshot_foreign_key_exists THEN
    RAISE EXCEPTION
      '012 assertion: artifacts must retain the research snapshot foreign key'
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(artifact.id::text, ', ' ORDER BY artifact.id)
  INTO invalid_artifacts
  FROM artifacts artifact
  LEFT JOIN runs artifact_run ON artifact_run.id = artifact.run_id
  LEFT JOIN conversations conversation
    ON conversation.id = artifact.conversation_id
  LEFT JOIN messages message ON message.id = artifact.message_id
  LEFT JOIN research_snapshots snapshot
    ON snapshot.id = artifact.research_snapshot_id
  LEFT JOIN runs snapshot_run ON snapshot_run.id = snapshot.run_id
  WHERE
    artifact_run.id IS NULL
    OR conversation.id IS NULL
    OR artifact_run.user_id IS DISTINCT FROM artifact.user_id
    OR artifact_run.conversation_id IS DISTINCT FROM artifact.conversation_id
    OR conversation.user_id IS DISTINCT FROM artifact.user_id
    OR (
      artifact.message_id IS NOT NULL
      AND (
        message.id IS NULL
        OR message.conversation_id IS DISTINCT FROM artifact.conversation_id
      )
    )
    OR (
      artifact.research_snapshot_id IS NOT NULL
      AND (
        snapshot.id IS NULL
        OR snapshot.user_id IS DISTINCT FROM artifact.user_id
        OR snapshot.conversation_id IS DISTINCT FROM artifact.conversation_id
        OR (
          snapshot.run_id IS DISTINCT FROM artifact.run_id
          AND snapshot_run.status IS DISTINCT FROM 'completed'
        )
      )
    );

  IF invalid_artifacts IS NOT NULL THEN
    RAISE EXCEPTION
      '012 assertion: artifacts have inconsistent ownership or links: %',
      invalid_artifacts
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ROLLBACK;
