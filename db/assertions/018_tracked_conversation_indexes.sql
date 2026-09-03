-- Repeatable PostgreSQL assertions for 018_tracked_conversation_indexes.sql.
-- The assertion reads only catalog metadata and always rolls its transaction back.
BEGIN;

DO $$
DECLARE
  expected record;
  actual record;
  actual_keys text[];
  actual_key_options smallint[];
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        (
          'runs_user_pending_conversation_order_idx',
          'runs',
          ARRAY[
            'user_id',
            'conversation_id',
            'created_at',
            'id'
          ]::text[],
          ARRAY[0, 0, 3, 3]::smallint[],
          'status = ANY (ARRAY[''waiting''::text, ''queued''::text, ''running''::text])'
        ),
        (
          'runs_user_terminal_conversation_idx',
          'runs',
          ARRAY['user_id', 'conversation_id', 'id']::text[],
          ARRAY[0, 0, 0]::smallint[],
          'status = ANY (ARRAY[''completed''::text, ''failed''::text, ''cancelled''::text, ''reconciliation_required''::text])'
        ),
        (
          'run_events_terminal_run_id_id_idx',
          'run_events',
          ARRAY['run_id', 'id']::text[],
          ARRAY[0, 3]::smallint[],
          'event_type = ANY (ARRAY[''done''::text, ''error''::text])'
        )
    ) AS required_index(
      index_name,
      table_name,
      key_definitions,
      key_options,
      predicate
    )
  LOOP
    SELECT
      index_catalog.oid AS indexrelid,
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indisunique,
      index_metadata.indnatts,
      index_metadata.indnkeyatts,
      index_metadata.indoption,
      access_method.amname AS access_method,
      pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid,
        true
      ) AS predicate
    INTO actual
    FROM pg_index index_metadata
    JOIN pg_class index_catalog
      ON index_catalog.oid = index_metadata.indexrelid
    JOIN pg_class table_catalog
      ON table_catalog.oid = index_metadata.indrelid
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_catalog.relnamespace
    JOIN pg_am access_method
      ON access_method.oid = index_catalog.relam
    WHERE
      index_namespace.nspname = current_schema()
      AND index_catalog.relname = expected.index_name
      AND table_catalog.relname = expected.table_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        '018 assertion: required index % on % is missing',
        expected.index_name,
        expected.table_name;
    END IF;

    SELECT ARRAY_AGG(
      pg_get_indexdef(actual.indexrelid, key_position, true)
      ORDER BY key_position
    )
    INTO actual_keys
    FROM generate_series(1, actual.indnkeyatts) key_position;

    SELECT ARRAY_AGG(key_option ORDER BY option_position)
    INTO actual_key_options
    FROM UNNEST(actual.indoption)
      WITH ORDINALITY AS options(key_option, option_position);

    IF
      actual.access_method <> 'btree'
      OR actual.indisunique
      OR NOT actual.indisvalid
      OR NOT actual.indisready
      OR actual.indnatts <> actual.indnkeyatts
      OR actual_keys IS DISTINCT FROM expected.key_definitions
      OR actual_key_options IS DISTINCT FROM expected.key_options
      OR actual.predicate IS DISTINCT FROM expected.predicate
    THEN
      RAISE EXCEPTION
        '018 assertion: index % has an unexpected definition (keys %, options %, predicate %)',
        expected.index_name,
        actual_keys,
        actual_key_options,
        actual.predicate;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
