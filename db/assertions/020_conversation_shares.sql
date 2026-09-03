-- Repeatable PostgreSQL assertions for 020_conversation_shares.sql.
-- Durable rows are checked first; all fixtures are rolled back.
BEGIN;

DO $$
DECLARE
  invalid_shares text;
BEGIN
  IF to_regclass('conversation_shares') IS NULL THEN
    RAISE EXCEPTION '020 assertion: conversation_shares table is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    WHERE
      constraint_info.conrelid = 'conversation_shares'::regclass
      AND constraint_info.contype = 'p'
      AND pg_get_constraintdef(constraint_info.oid) =
        'PRIMARY KEY (conversation_id)'
  ) THEN
    RAISE EXCEPTION '020 assertion: conversation_id primary key is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    WHERE
      constraint_info.conrelid = 'conversation_shares'::regclass
      AND constraint_info.contype = 'u'
      AND pg_get_constraintdef(constraint_info.oid) = 'UNIQUE (public_id)'
  ) THEN
    RAISE EXCEPTION '020 assertion: public_id unique constraint is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_info
    WHERE
      constraint_info.conrelid = 'conversation_shares'::regclass
      AND constraint_info.conname = 'conversation_shares_conversation_fk'
      AND constraint_info.contype = 'f'
      AND pg_get_constraintdef(constraint_info.oid) =
        'FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE'
  ) THEN
    RAISE EXCEPTION '020 assertion: conversation cascade foreign key is missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(share.conversation_id::text, ', ' ORDER BY share.conversation_id)
  INTO invalid_shares
  FROM conversation_shares share
  LEFT JOIN conversations conversation ON conversation.id = share.conversation_id
  WHERE
    conversation.id IS NULL
    OR length(share.title) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(share.messages) <> 'array'
    OR jsonb_array_length(share.messages) = 0
    OR share.updated_at < share.created_at;

  IF invalid_shares IS NOT NULL THEN
    RAISE EXCEPTION '020 assertion: invalid durable shares: %', invalid_shares
      USING ERRCODE = '23514';
  END IF;
END;
$$;

INSERT INTO users (id, name, available_credits)
VALUES ('20202020-0000-4000-8000-000000000001', '020 assertion owner', 100);

INSERT INTO conversations (id, user_id, title)
VALUES
  (
    '20202020-0000-4000-8000-000000000101',
    '20202020-0000-4000-8000-000000000001',
    'share fixture one'
  ),
  (
    '20202020-0000-4000-8000-000000000102',
    '20202020-0000-4000-8000-000000000001',
    'share fixture two'
  );

INSERT INTO conversation_shares (
  conversation_id,
  public_id,
  title,
  messages,
  created_at,
  updated_at
)
VALUES (
  '20202020-0000-4000-8000-000000000101',
  '20202020-0000-4000-8000-000000000201',
  'snapshot title',
  '[{"id":"20202020-0000-4000-8000-000000000301","role":"user","content":"snapshot","citations":[],"createdAt":"2026-08-28T00:00:00.000Z","files":[]}]',
  '2026-08-28T00:00:00Z',
  '2026-08-28T00:00:01Z'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO conversation_shares (
      conversation_id,
      public_id,
      title,
      messages
    )
    VALUES (
      '20202020-0000-4000-8000-000000000102',
      '20202020-0000-4000-8000-000000000201',
      'duplicate public id',
      '[{"id":"20202020-0000-4000-8000-000000000302"}]'
    );
    RAISE EXCEPTION '020 assertion: duplicate public_id was accepted'
      USING ERRCODE = '23514';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE conversation_shares
    SET messages = '[]'::jsonb
    WHERE conversation_id = '20202020-0000-4000-8000-000000000101';
    RAISE EXCEPTION '020 assertion: empty snapshot was accepted'
      USING ERRCODE = '23514';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE conversation_shares
    SET updated_at = created_at - interval '1 second'
    WHERE conversation_id = '20202020-0000-4000-8000-000000000101';
    RAISE EXCEPTION '020 assertion: reversed timestamps were accepted'
      USING ERRCODE = '23514';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

DELETE FROM conversations
WHERE id = '20202020-0000-4000-8000-000000000101';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM conversation_shares
    WHERE conversation_id = '20202020-0000-4000-8000-000000000101'
  ) THEN
    RAISE EXCEPTION '020 assertion: hard-deleted conversation retained its share'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ROLLBACK;
