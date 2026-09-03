-- Repeatable PostgreSQL assertions for 016_conversation_branches.sql.
-- Durable state is checked first; all fixtures and deletion checks roll back.
BEGIN;

DO $$
DECLARE
  existing_conversation record;
  existing_run record;
  existing_attachment record;
BEGIN
  FOR existing_conversation IN SELECT id FROM conversations LOOP
    PERFORM assert_conversation_selected_run_integrity(existing_conversation.id);
  END LOOP;

  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_turn_queue_integrity(existing_run.id);
  END LOOP;

  FOR existing_attachment IN SELECT id FROM input_attachments LOOP
    PERFORM assert_input_attachment_binding_integrity(existing_attachment.id);
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE
      table_schema = current_schema()
      AND table_name = 'input_attachments'
      AND column_name IN ('message_id', 'position')
  ) THEN
    RAISE EXCEPTION '016 assertion: legacy attachment relationship columns remain'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE
      schemaname = current_schema()
      AND tablename = 'runs'
      AND indexname = 'runs_input_message_attempt_unique_idx'
  ) THEN
    RAISE EXCEPTION '016 assertion: input-message attempt index is missing'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE
      schemaname = current_schema()
      AND tablename = 'runs'
      AND indexname = 'runs_waiting_predecessor_unique_idx'
      AND indexdef LIKE '%WHERE ((status = ''waiting''::text)%'
  ) THEN
    RAISE EXCEPTION '016 assertion: waiting predecessor serialization index is missing'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE
      schemaname = current_schema()
      AND tablename = 'runs'
      AND indexname IN (
        'runs_conversation_turn_attempt_unique_idx',
        'runs_initial_input_message_unique_idx'
      )
  ) THEN
    RAISE EXCEPTION '016 assertion: legacy Run attempt indexes remain'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_indexes
    WHERE
      schemaname = current_schema()
      AND tablename = 'input_attachments'
      AND indexname IN (
        'input_attachments_user_staged_created_idx',
        'input_attachments_staged_expiry_idx'
      )
      AND indexdef LIKE '%attached_at IS NULL%'
  ) <> 2 THEN
    RAISE EXCEPTION '016 assertion: normalized staged attachment indexes are missing'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

INSERT INTO users (id, name, available_credits)
VALUES
  ('16161616-0000-4000-8000-000000000001', '016 assertion owner', 1000),
  ('16161616-0000-4000-8000-000000000002', '016 assertion other owner', 1000),
  ('16161616-0000-4000-8000-000000000003', '016 cascade owner', 1000);

INSERT INTO conversations (id, user_id, title)
VALUES
  (
    '16161616-0000-4000-8000-000000000101',
    '16161616-0000-4000-8000-000000000001',
    'branch graph'
  ),
  (
    '16161616-0000-4000-8000-000000000102',
    '16161616-0000-4000-8000-000000000001',
    'shared attachment history'
  ),
  (
    '16161616-0000-4000-8000-000000000103',
    '16161616-0000-4000-8000-000000000002',
    'foreign selection'
  ),
  (
    '16161616-0000-4000-8000-000000000104',
    '16161616-0000-4000-8000-000000000003',
    'user cascade attachments'
  ),
  (
    '16161616-0000-4000-8000-000000000105',
    '16161616-0000-4000-8000-000000000001',
    'empty conversation'
  );

INSERT INTO messages (id, conversation_id, role, content, citations)
VALUES
  (
    '16161616-0000-4000-8000-000000000201',
    '16161616-0000-4000-8000-000000000101',
    'user',
    'first branch input',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000202',
    '16161616-0000-4000-8000-000000000101',
    'assistant',
    'first branch answer',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000203',
    '16161616-0000-4000-8000-000000000101',
    'user',
    'original second-depth input',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000204',
    '16161616-0000-4000-8000-000000000101',
    'assistant',
    'original second-depth answer',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000205',
    '16161616-0000-4000-8000-000000000101',
    'user',
    'sibling second-depth input',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000206',
    '16161616-0000-4000-8000-000000000102',
    'user',
    'old immutable message',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000207',
    '16161616-0000-4000-8000-000000000102',
    'user',
    'new immutable message',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000208',
    '16161616-0000-4000-8000-000000000103',
    'user',
    'foreign input',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000209',
    '16161616-0000-4000-8000-000000000104',
    'user',
    'cascade attachment message',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000215',
    '16161616-0000-4000-8000-000000000101',
    'user',
    'queued child must have a completed predecessor',
    '[]'
  ),
  (
    '16161616-0000-4000-8000-000000000216',
    '16161616-0000-4000-8000-000000000101',
    'user',
    'second concurrent waiting child',
    '[]'
  );

INSERT INTO runs (
  id,
  request_id,
  user_id,
  conversation_id,
  status,
  reservation_credits,
  charged_credits,
  input_tokens,
  output_tokens,
  web_searches,
  input_message_id,
  assistant_message_id,
  completed_at,
  finished_at,
  conversation_turn,
  attempt_index,
  predecessor_run_id
)
VALUES
  (
    '16161616-0000-4000-8000-000000000301',
    '16161616-0000-4000-8000-000000000401',
    '16161616-0000-4000-8000-000000000001',
    '16161616-0000-4000-8000-000000000101',
    'completed', 20, 1, 1, 1, 0,
    '16161616-0000-4000-8000-000000000201',
    '16161616-0000-4000-8000-000000000202',
    now(), now(), 1, 1, NULL
  ),
  (
    '16161616-0000-4000-8000-000000000302',
    '16161616-0000-4000-8000-000000000402',
    '16161616-0000-4000-8000-000000000001',
    '16161616-0000-4000-8000-000000000101',
    'completed', 20, 1, 1, 1, 0,
    '16161616-0000-4000-8000-000000000203',
    '16161616-0000-4000-8000-000000000204',
    now(), now(), 2, 1,
    '16161616-0000-4000-8000-000000000301'
  );

INSERT INTO runs (
  id,
  request_id,
  user_id,
  conversation_id,
  status,
  reservation_credits,
  input_message_id,
  assistant_message_id,
  failure_code,
  failure_message,
  finished_at,
  conversation_turn,
  attempt_index
)
VALUES (
  '16161616-0000-4000-8000-000000000303',
  '16161616-0000-4000-8000-000000000403',
  '16161616-0000-4000-8000-000000000002',
  '16161616-0000-4000-8000-000000000103',
  'failed', 20,
  '16161616-0000-4000-8000-000000000208',
  '16161616-0000-4000-8000-000000000210',
  'PROVIDER_ERROR', 'foreign failed Run', now(), 1, 1
);

UPDATE messages
SET run_id = CASE id
  WHEN '16161616-0000-4000-8000-000000000201'::uuid
    THEN '16161616-0000-4000-8000-000000000301'::uuid
  WHEN '16161616-0000-4000-8000-000000000202'::uuid
    THEN '16161616-0000-4000-8000-000000000301'::uuid
  WHEN '16161616-0000-4000-8000-000000000203'::uuid
    THEN '16161616-0000-4000-8000-000000000302'::uuid
  WHEN '16161616-0000-4000-8000-000000000204'::uuid
    THEN '16161616-0000-4000-8000-000000000302'::uuid
  WHEN '16161616-0000-4000-8000-000000000208'::uuid
    THEN '16161616-0000-4000-8000-000000000303'::uuid
END
WHERE id IN (
  '16161616-0000-4000-8000-000000000201',
  '16161616-0000-4000-8000-000000000202',
  '16161616-0000-4000-8000-000000000203',
  '16161616-0000-4000-8000-000000000204',
  '16161616-0000-4000-8000-000000000208'
);

UPDATE conversations
SET selected_run_id = CASE id
  WHEN '16161616-0000-4000-8000-000000000101'::uuid
    THEN '16161616-0000-4000-8000-000000000302'::uuid
  WHEN '16161616-0000-4000-8000-000000000103'::uuid
    THEN '16161616-0000-4000-8000-000000000303'::uuid
END
WHERE id IN (
  '16161616-0000-4000-8000-000000000101',
  '16161616-0000-4000-8000-000000000103'
);

SET CONSTRAINTS ALL IMMEDIATE;

-- A non-empty conversation cannot clear or cross its selected branch head.
DO $$
BEGIN
  BEGIN
    UPDATE conversations
    SET selected_run_id = NULL
    WHERE id = '16161616-0000-4000-8000-000000000101';
    RAISE EXCEPTION 'expected a NULL non-empty selection to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE conversations
    SET selected_run_id = '16161616-0000-4000-8000-000000000303'
    WHERE id = '16161616-0000-4000-8000-000000000101';
    RAISE EXCEPTION 'expected a cross-conversation selection to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

END;
$$;

-- Regenerating an ancestor with descendants creates an alternative attempt;
-- a normal child on that attempt may share depth/attempt coordinates with the
-- original branch because it owns a different input message.
INSERT INTO runs (
  id,
  request_id,
  user_id,
  conversation_id,
  status,
  reservation_credits,
  input_message_id,
  assistant_message_id,
  failure_code,
  failure_message,
  finished_at,
  conversation_turn,
  attempt_index,
  regenerate_of_run_id
)
VALUES (
  '16161616-0000-4000-8000-000000000304',
  '16161616-0000-4000-8000-000000000404',
  '16161616-0000-4000-8000-000000000001',
  '16161616-0000-4000-8000-000000000101',
  'failed', 20,
  '16161616-0000-4000-8000-000000000201',
  '16161616-0000-4000-8000-000000000211',
  'PROVIDER_ERROR', 'regenerated branch failed', now(), 1, 2,
  '16161616-0000-4000-8000-000000000301'
);

INSERT INTO runs (
  id,
  request_id,
  user_id,
  conversation_id,
  status,
  reservation_credits,
  input_message_id,
  assistant_message_id,
  conversation_turn,
  attempt_index,
  predecessor_run_id
)
VALUES (
  '16161616-0000-4000-8000-000000000305',
  '16161616-0000-4000-8000-000000000405',
  '16161616-0000-4000-8000-000000000001',
  '16161616-0000-4000-8000-000000000101',
  'waiting', 20,
  '16161616-0000-4000-8000-000000000205',
  '16161616-0000-4000-8000-000000000212',
  2, 1,
  '16161616-0000-4000-8000-000000000304'
);

UPDATE conversations
SET selected_run_id = '16161616-0000-4000-8000-000000000305'
WHERE id = '16161616-0000-4000-8000-000000000101';

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM runs
    WHERE
      conversation_id = '16161616-0000-4000-8000-000000000101'
      AND conversation_turn = 2
      AND attempt_index = 1
  ) <> 2 THEN
    RAISE EXCEPTION '016 assertion: same-depth sibling input branches were not retained';
  END IF;

  PERFORM assert_run_turn_queue_integrity(
    '16161616-0000-4000-8000-000000000302'
  );

  BEGIN
    INSERT INTO runs (
      id,
      request_id,
      user_id,
      conversation_id,
      status,
      reservation_credits,
      input_message_id,
      assistant_message_id,
      failure_code,
      failure_message,
      finished_at,
      conversation_turn,
      attempt_index,
      predecessor_run_id
    )
    VALUES (
      '16161616-0000-4000-8000-000000000306',
      '16161616-0000-4000-8000-000000000406',
      '16161616-0000-4000-8000-000000000001',
      '16161616-0000-4000-8000-000000000101',
      'failed', 20,
      '16161616-0000-4000-8000-000000000205',
      '16161616-0000-4000-8000-000000000213',
      'PROVIDER_ERROR', 'duplicate attempt', now(), 2, 1,
      '16161616-0000-4000-8000-000000000301'
    );
    RAISE EXCEPTION 'expected a duplicate input attempt to be rejected';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO runs (
      id,
      request_id,
      user_id,
      conversation_id,
      status,
      reservation_credits,
      input_message_id,
      assistant_message_id,
      conversation_turn,
      attempt_index,
      predecessor_run_id
    )
    VALUES (
      '16161616-0000-4000-8000-000000000307',
      '16161616-0000-4000-8000-000000000407',
      '16161616-0000-4000-8000-000000000001',
      '16161616-0000-4000-8000-000000000101',
      'queued', 20,
      '16161616-0000-4000-8000-000000000215',
      '16161616-0000-4000-8000-000000000214',
      2, 1,
      '16161616-0000-4000-8000-000000000304'
    );
    RAISE EXCEPTION 'expected queued child after failure to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO runs (
      id,
      request_id,
      user_id,
      conversation_id,
      status,
      reservation_credits,
      input_message_id,
      assistant_message_id,
      conversation_turn,
      attempt_index,
      predecessor_run_id
    )
    VALUES (
      '16161616-0000-4000-8000-000000000308',
      '16161616-0000-4000-8000-000000000408',
      '16161616-0000-4000-8000-000000000001',
      '16161616-0000-4000-8000-000000000101',
      'waiting', 20,
      '16161616-0000-4000-8000-000000000216',
      '16161616-0000-4000-8000-000000000217',
      2, 1,
      '16161616-0000-4000-8000-000000000304'
    );
    RAISE EXCEPTION 'expected a second waiting successor to be rejected';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- One attachment is shared by an old and a new immutable message. The first
-- message deletion retains it; deleting the last reference creates the durable
-- storage-deletion tombstone and removes only then the metadata row.
SET CONSTRAINTS ALL DEFERRED;

INSERT INTO input_attachments (
  id,
  user_id,
  kind,
  original_name,
  mime_type,
  size_bytes,
  sha256,
  storage_path,
  attached_at,
  expires_at
)
VALUES
  (
    '16161616-0000-4000-8000-000000000501',
    '16161616-0000-4000-8000-000000000001',
    'file', 'shared.txt', 'text/plain', 5, repeat('a', 64),
    '16161616-0000-4000-8000-000000000501', now(), NULL
  ),
  (
    '16161616-0000-4000-8000-000000000502',
    '16161616-0000-4000-8000-000000000003',
    'file', 'cascade.txt', 'text/plain', 7, repeat('b', 64),
    '16161616-0000-4000-8000-000000000502', now(), NULL
  );

INSERT INTO message_input_attachments (message_id, attachment_id, position)
VALUES
  (
    '16161616-0000-4000-8000-000000000206',
    '16161616-0000-4000-8000-000000000501',
    0
  ),
  (
    '16161616-0000-4000-8000-000000000207',
    '16161616-0000-4000-8000-000000000501',
    0
  ),
  (
    '16161616-0000-4000-8000-000000000209',
    '16161616-0000-4000-8000-000000000502',
    0
  );

SET CONSTRAINTS ALL IMMEDIATE;

DELETE FROM messages
WHERE id = '16161616-0000-4000-8000-000000000206';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM input_attachments
    WHERE id = '16161616-0000-4000-8000-000000000501'
  ) THEN
    RAISE EXCEPTION '016 assertion: deleting one shared reference removed its attachment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM input_attachment_deletions
    WHERE attachment_id = '16161616-0000-4000-8000-000000000501'
  ) THEN
    RAISE EXCEPTION '016 assertion: shared attachment was tombstoned too early';
  END IF;
END;
$$;

DELETE FROM messages
WHERE id = '16161616-0000-4000-8000-000000000207';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM input_attachments
    WHERE id = '16161616-0000-4000-8000-000000000501'
  ) OR NOT EXISTS (
    SELECT 1
    FROM input_attachment_deletions
    WHERE attachment_id = '16161616-0000-4000-8000-000000000501'
  ) THEN
    RAISE EXCEPTION '016 assertion: last attachment reference did not enter deletion lifecycle';
  END IF;
END;
$$;

-- This fixture has no Runs or ledger entries, so its user-level cascades must
-- remove message links and attachment metadata without FK-order dependence.
SET CONSTRAINTS ALL DEFERRED;

DELETE FROM users
WHERE id = '16161616-0000-4000-8000-000000000003';

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM input_attachments
    WHERE id = '16161616-0000-4000-8000-000000000502'
  ) OR EXISTS (
    SELECT 1
    FROM message_input_attachments
    WHERE attachment_id = '16161616-0000-4000-8000-000000000502'
  ) THEN
    RAISE EXCEPTION '016 assertion: user cascade retained attachment state';
  END IF;
END;
$$;

ROLLBACK;
