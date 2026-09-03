-- Repeatable PostgreSQL assertions for 029_custom_instructions.sql.
-- Catalog and durable rows are inspected without changing committed state.
BEGIN;

DO $$
DECLARE
  expected_column record;
  expected_constraint record;
BEGIN
  FOR expected_column IN
    SELECT *
    FROM (
      VALUES
        (
          'users',
          'custom_instructions_enabled',
          'boolean',
          'NO',
          'false'
        ),
        (
          'users',
          'custom_instructions_content',
          'text',
          'NO',
          $default$''::text$default$
        ),
        (
          'users',
          'custom_instructions_revision',
          'integer',
          'NO',
          '0'
        ),
        (
          'users',
          'custom_instructions_updated_at',
          'timestamp with time zone',
          'NO',
          'now()'
        ),
        (
          'conversations',
          'custom_instructions_snapshot',
          'text',
          'YES',
          NULL
        ),
        (
          'conversations',
          'custom_instructions_snapshot_revision',
          'integer',
          'NO',
          '0'
        )
    ) expected(
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns actual
      WHERE
        actual.table_schema = current_schema()
        AND actual.table_name = expected_column.table_name
        AND actual.column_name = expected_column.column_name
        AND actual.data_type = expected_column.data_type
        AND actual.is_nullable = expected_column.is_nullable
        AND actual.column_default IS NOT DISTINCT FROM
          expected_column.column_default
    ) THEN
      RAISE EXCEPTION
        '029 assertion: %.% is missing or malformed',
        expected_column.table_name,
        expected_column.column_name
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR expected_constraint IN
    SELECT *
    FROM (
      VALUES
        ('users', 'users_custom_instructions_content_check'),
        ('users', 'users_custom_instructions_revision_check'),
        (
          'conversations',
          'conversations_custom_instructions_snapshot_shape_check'
        )
    ) expected(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_info
      JOIN pg_class table_info
        ON table_info.oid = constraint_info.conrelid
      JOIN pg_namespace table_namespace
        ON table_namespace.oid = table_info.relnamespace
      WHERE
        table_namespace.nspname = current_schema()
        AND table_info.relname = expected_constraint.table_name
        AND constraint_info.conname = expected_constraint.constraint_name
        AND constraint_info.contype = 'c'
        AND constraint_info.convalidated
        AND NOT constraint_info.connoinherit
    ) THEN
      RAISE EXCEPTION
        '029 assertion: constraint % on % is missing or malformed',
        expected_constraint.constraint_name,
        expected_constraint.table_name
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF to_regprocedure(
    'reject_conversation_custom_instructions_snapshot_mutation()'
  ) IS NULL THEN
    RAISE EXCEPTION '029 assertion: immutable snapshot function is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_info
    JOIN pg_class table_info ON table_info.oid = trigger_info.tgrelid
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_info.relnamespace
    WHERE
      table_namespace.nspname = current_schema()
      AND table_info.relname = 'conversations'
      AND trigger_info.tgname =
        'conversations_custom_instructions_snapshot_immutable_trigger'
      AND NOT trigger_info.tgisinternal
      AND trigger_info.tgenabled <> 'D'
      AND NOT trigger_info.tgdeferrable
      AND NOT trigger_info.tginitdeferred
      AND trigger_info.tgtype = 19
      AND trigger_info.tgfoid = to_regprocedure(
        'reject_conversation_custom_instructions_snapshot_mutation()'
      )
  ) THEN
    RAISE EXCEPTION '029 assertion: immutable snapshot trigger is missing or malformed'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM users account
    WHERE
      length(account.custom_instructions_content) > 4000
      OR account.custom_instructions_revision < 0
      OR (
        account.custom_instructions_enabled
        AND account.custom_instructions_revision = 0
      )
      OR (
        account.custom_instructions_enabled
        AND account.custom_instructions_content !~ '[^[:space:]]'
      )
  ) THEN
    RAISE EXCEPTION '029 assertion: invalid account custom instructions exist'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM conversations conversation
    WHERE NOT (
      (
        conversation.custom_instructions_snapshot IS NULL
        AND conversation.custom_instructions_snapshot_revision = 0
      )
      OR
      (
        conversation.custom_instructions_snapshot IS NOT NULL
        AND length(conversation.custom_instructions_snapshot) <= 4000
        AND conversation.custom_instructions_snapshot ~ '[^[:space:]]'
        AND conversation.custom_instructions_snapshot_revision > 0
      )
    )
  ) THEN
    RAISE EXCEPTION '029 assertion: invalid conversation custom instructions snapshots exist'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ROLLBACK;
