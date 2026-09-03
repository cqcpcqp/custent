-- Repeatable PostgreSQL assertions for 025_conversation_share_management_index.sql.
-- The assertion reads only catalog metadata and always rolls its transaction back.
BEGIN;

DO $$
DECLARE
  actual record;
  actual_keys text[];
  actual_key_options smallint[];
BEGIN
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
    AND index_catalog.relname = 'conversation_shares_management_order_idx'
    AND table_catalog.relname = 'conversation_shares';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      '025 assertion: required conversation share management index is missing';
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
    OR actual.indnatts <> 2
    OR actual.indnkeyatts <> 2
    OR actual_keys IS DISTINCT FROM ARRAY[
      'updated_at',
      'conversation_id'
    ]::text[]
    OR actual_key_options IS DISTINCT FROM ARRAY[3, 3]::smallint[]
    OR actual.predicate IS NOT NULL
  THEN
    RAISE EXCEPTION
      '025 assertion: index has an unexpected definition (method %, keys %, options %, predicate %)',
      actual.access_method,
      actual_keys,
      actual_key_options,
      actual.predicate;
  END IF;
END;
$$;

ROLLBACK;
