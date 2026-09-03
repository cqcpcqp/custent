-- Repeatable PostgreSQL assertions for 010_retry_predecessor_integrity.sql.
-- Run after migrations 001-010; every fixture is rolled back.
BEGIN;

INSERT INTO users (id, name, available_credits)
VALUES ('10101010-0000-4000-8000-000000000001', '010 assertion user', 1000);

INSERT INTO conversations (id, user_id, title)
VALUES
  (
    '10101010-0000-4000-8000-000000000101',
    '10101010-0000-4000-8000-000000000001',
    'retry must wait'
  ),
  (
    '10101010-0000-4000-8000-000000000102',
    '10101010-0000-4000-8000-000000000001',
    'ordinary turn may run'
  );

INSERT INTO messages (id, conversation_id, role, content, citations)
VALUES
  (
    '10101010-0000-4000-8000-000000000201',
    '10101010-0000-4000-8000-000000000101',
    'user',
    'failed predecessor',
    '[]'
  ),
  (
    '10101010-0000-4000-8000-000000000202',
    '10101010-0000-4000-8000-000000000101',
    'user',
    'retry this turn',
    '[]'
  ),
  (
    '10101010-0000-4000-8000-000000000203',
    '10101010-0000-4000-8000-000000000102',
    'user',
    'other failed predecessor',
    '[]'
  ),
  (
    '10101010-0000-4000-8000-000000000204',
    '10101010-0000-4000-8000-000000000102',
    'user',
    'ordinary next turn',
    '[]'
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
VALUES
  (
    '10101010-0000-4000-8000-000000000301',
    '10101010-0000-4000-8000-000000000401',
    '10101010-0000-4000-8000-000000000001',
    '10101010-0000-4000-8000-000000000101',
    'failed',
    20,
    '10101010-0000-4000-8000-000000000201',
    '10101010-0000-4000-8000-000000000501',
    'PROVIDER_ERROR',
    'provider failed',
    now(),
    1,
    1
  ),
  (
    '10101010-0000-4000-8000-000000000304',
    '10101010-0000-4000-8000-000000000404',
    '10101010-0000-4000-8000-000000000001',
    '10101010-0000-4000-8000-000000000102',
    'failed',
    20,
    '10101010-0000-4000-8000-000000000203',
    '10101010-0000-4000-8000-000000000504',
    'PROVIDER_ERROR',
    'provider failed',
    now(),
    1,
    1
  );

-- A normal new Turn remains executable after any terminal predecessor.
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
  '10101010-0000-4000-8000-000000000305',
  '10101010-0000-4000-8000-000000000405',
  '10101010-0000-4000-8000-000000000001',
  '10101010-0000-4000-8000-000000000102',
  'queued',
  20,
  '10101010-0000-4000-8000-000000000204',
  '10101010-0000-4000-8000-000000000505',
  2,
  1,
  '10101010-0000-4000-8000-000000000304'
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
  attempt_index,
  predecessor_run_id
)
VALUES (
  '10101010-0000-4000-8000-000000000302',
  '10101010-0000-4000-8000-000000000402',
  '10101010-0000-4000-8000-000000000001',
  '10101010-0000-4000-8000-000000000101',
  'failed',
  20,
  '10101010-0000-4000-8000-000000000202',
  '10101010-0000-4000-8000-000000000502',
  'PROVIDER_ERROR',
  'provider failed',
  now(),
  2,
  1,
  '10101010-0000-4000-8000-000000000301'
);

-- The retry is valid while waiting behind its failed preserved predecessor.
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
  predecessor_run_id,
  retry_of_run_id
)
VALUES (
  '10101010-0000-4000-8000-000000000303',
  '10101010-0000-4000-8000-000000000403',
  '10101010-0000-4000-8000-000000000001',
  '10101010-0000-4000-8000-000000000101',
  'waiting',
  20,
  '10101010-0000-4000-8000-000000000202',
  '10101010-0000-4000-8000-000000000503',
  2,
  2,
  '10101010-0000-4000-8000-000000000301',
  '10101010-0000-4000-8000-000000000302'
);

SET CONSTRAINTS ALL IMMEDIATE;

-- Promoting that retry would skip the failed predecessor and must be rejected
-- by the deferred Run integrity trigger at the statement boundary.
DO $$
BEGIN
  BEGIN
    UPDATE runs
    SET status = 'queued'
    WHERE id = '10101010-0000-4000-8000-000000000303';

    RAISE EXCEPTION 'expected executable retry behind a failed predecessor to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
  IF (
    SELECT status
    FROM runs
    WHERE id = '10101010-0000-4000-8000-000000000303'
  ) <> 'waiting' THEN
    RAISE EXCEPTION 'the rejected retry promotion was not rolled back';
  END IF;

  IF (
    SELECT status
    FROM runs
    WHERE id = '10101010-0000-4000-8000-000000000305'
  ) <> 'queued' THEN
    RAISE EXCEPTION '010 incorrectly blocked an ordinary Turn after failure';
  END IF;
END;
$$;

ROLLBACK;
