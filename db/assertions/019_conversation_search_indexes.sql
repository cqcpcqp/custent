-- Repeatable PostgreSQL assertions for 019_conversation_search_indexes.sql.
-- The assertion reads only catalog metadata and always rolls its transaction back.
BEGIN;

DO $$
DECLARE
  expected record;
  actual record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_trgm'
  ) THEN
    RAISE EXCEPTION '019 assertion: pg_trgm extension is missing';
  END IF;

  FOR expected IN
    SELECT *
    FROM (
      VALUES
        (
          'conversations_title_search_trgm_idx',
          'conversations',
          'title',
          'deleted_at IS NULL'
        ),
        (
          'messages_content_search_trgm_idx',
          'messages',
          'content',
          NULL::text
        )
    ) AS required_index(index_name, table_name, key_definition, predicate)
  LOOP
    SELECT
      index_catalog.oid AS indexrelid,
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indisunique,
      index_metadata.indnatts,
      index_metadata.indnkeyatts,
      access_method.amname AS access_method,
      pg_get_indexdef(index_catalog.oid, 1, true) AS key_definition,
      pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid,
        true
      ) AS predicate,
      operator_class.opcname AS operator_class
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
    JOIN pg_opclass operator_class
      ON operator_class.oid = index_metadata.indclass[0]
    WHERE
      index_namespace.nspname = current_schema()
      AND index_catalog.relname = expected.index_name
      AND table_catalog.relname = expected.table_name;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        '019 assertion: required index % on % is missing',
        expected.index_name,
        expected.table_name;
    END IF;

    IF
      actual.access_method <> 'gin'
      OR actual.operator_class <> 'gin_trgm_ops'
      OR actual.indisunique
      OR NOT actual.indisvalid
      OR NOT actual.indisready
      OR actual.indnatts <> 1
      OR actual.indnkeyatts <> 1
      OR actual.key_definition IS DISTINCT FROM expected.key_definition
      OR actual.predicate IS DISTINCT FROM expected.predicate
    THEN
      RAISE EXCEPTION
        '019 assertion: index % has an unexpected definition (method %, opclass %, key %, predicate %)',
        expected.index_name,
        actual.access_method,
        actual.operator_class,
        actual.key_definition,
        actual.predicate;
    END IF;
  END LOOP;
END;
$$;

ROLLBACK;
