-- Repeatable PostgreSQL assertions for 009_run_turn_queue.sql.
-- Run after migrations 001-009; every fixture is rolled back.
BEGIN;

INSERT INTO users (id, name, available_credits)
VALUES
  ('99999999-0000-4000-8000-000000000001', '009 assertion user', 1000),
  ('99999999-0000-4000-8000-000000000002', '009 other user', 1000);

INSERT INTO conversations (id, user_id, title)
VALUES
  (
    '99999999-0000-4000-8000-000000000101',
    '99999999-0000-4000-8000-000000000001',
    'retry chain'
  ),
  (
    '99999999-0000-4000-8000-000000000102',
    '99999999-0000-4000-8000-000000000001',
    'active head'
  ),
  (
    '99999999-0000-4000-8000-000000000103',
    '99999999-0000-4000-8000-000000000001',
    'cross conversation target'
  ),
  (
    '99999999-0000-4000-8000-000000000104',
    '99999999-0000-4000-8000-000000000001',
    'cross conversation source'
  ),
  (
    '99999999-0000-4000-8000-000000000105',
    '99999999-0000-4000-8000-000000000001',
    'message integrity target'
  ),
  (
    '99999999-0000-4000-8000-000000000106',
    '99999999-0000-4000-8000-000000000001',
    'message integrity source'
  ),
  (
    '99999999-0000-4000-8000-000000000107',
    '99999999-0000-4000-8000-000000000002',
    'owned by another user'
  );

INSERT INTO messages (id, conversation_id, role, content, citations)
VALUES
  (
    '99999999-0000-4000-8000-000000000201',
    '99999999-0000-4000-8000-000000000101',
    'user',
    'retry this input',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000202',
    '99999999-0000-4000-8000-000000000101',
    'user',
    'wait behind the retry',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000203',
    '99999999-0000-4000-8000-000000000102',
    'user',
    'active head input',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000204',
    '99999999-0000-4000-8000-000000000102',
    'user',
    'second head input',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000205',
    '99999999-0000-4000-8000-000000000103',
    'user',
    'cross conversation target input',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000206',
    '99999999-0000-4000-8000-000000000104',
    'user',
    'cross conversation source input',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000207',
    '99999999-0000-4000-8000-000000000104',
    'user',
    'new input sent after failure',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000208',
    '99999999-0000-4000-8000-000000000105',
    'user',
    'one normal Turn may own this input',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000209',
    '99999999-0000-4000-8000-000000000106',
    'user',
    'belongs to another conversation',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000210',
    '99999999-0000-4000-8000-000000000105',
    'assistant',
    'must not be accepted as Run input',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000211',
    '99999999-0000-4000-8000-000000000105',
    'user',
    'input and assistant ids must differ',
    '[]'
  ),
  (
    '99999999-0000-4000-8000-000000000212',
    '99999999-0000-4000-8000-000000000107',
    'user',
    'conversation belongs to another user',
    '[]'
  );

-- A first Turn still has to enforce tenant ownership even though it has no
-- predecessor from which ownership could otherwise be inferred.
DO $$
BEGIN
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
      attempt_index
    )
    VALUES (
      '99999999-0000-4000-8000-000000000318',
      '99999999-0000-4000-8000-000000000418',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000107',
      'queued',
      20,
      '99999999-0000-4000-8000-000000000212',
      '99999999-0000-4000-8000-000000000518',
      1,
      1
    );
    PERFORM assert_run_turn_queue_integrity(
      '99999999-0000-4000-8000-000000000318'
    );
    RAISE EXCEPTION 'expected a Run owned by another conversation user to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- A non-retry Turn owns its input message. Retry attempts may reuse that
-- message, but a second ordinary Turn may not.
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
  '99999999-0000-4000-8000-000000000313',
  '99999999-0000-4000-8000-000000000413',
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000105',
  'failed',
  20,
  '99999999-0000-4000-8000-000000000208',
  '99999999-0000-4000-8000-000000000513',
  'PROVIDER_ERROR',
  'provider failed',
  now(),
  1,
  1
);

DO $$
BEGIN
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
      '99999999-0000-4000-8000-000000000314',
      '99999999-0000-4000-8000-000000000414',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000105',
      'failed',
      20,
      '99999999-0000-4000-8000-000000000208',
      '99999999-0000-4000-8000-000000000514',
      'PROVIDER_ERROR',
      'provider failed',
      now(),
      2,
      1,
      '99999999-0000-4000-8000-000000000313'
    );
    RAISE EXCEPTION 'expected ordinary Turns to reject a reused input message';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- Run input must be a user message from the Run's own conversation.
DO $$
BEGIN
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
      '99999999-0000-4000-8000-000000000315',
      '99999999-0000-4000-8000-000000000415',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000105',
      'queued',
      20,
      '99999999-0000-4000-8000-000000000209',
      '99999999-0000-4000-8000-000000000515',
      2,
      1,
      '99999999-0000-4000-8000-000000000313'
    );
    PERFORM assert_run_turn_queue_integrity(
      '99999999-0000-4000-8000-000000000315'
    );
    RAISE EXCEPTION 'expected a cross-conversation input message to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
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
      '99999999-0000-4000-8000-000000000316',
      '99999999-0000-4000-8000-000000000416',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000105',
      'queued',
      20,
      '99999999-0000-4000-8000-000000000210',
      '99999999-0000-4000-8000-000000000516',
      2,
      1,
      '99999999-0000-4000-8000-000000000313'
    );
    PERFORM assert_run_turn_queue_integrity(
      '99999999-0000-4000-8000-000000000316'
    );
    RAISE EXCEPTION 'expected an assistant input message to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
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
      attempt_index
    )
    VALUES (
      '99999999-0000-4000-8000-000000000317',
      '99999999-0000-4000-8000-000000000417',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000105',
      'queued',
      20,
      '99999999-0000-4000-8000-000000000211',
      '99999999-0000-4000-8000-000000000211',
      2,
      1
    );
    RAISE EXCEPTION 'expected identical input and assistant message ids to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Turn 1 failed, so Turn 2 is waiting and continues to hold its reservation.
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
  '99999999-0000-4000-8000-000000000301',
  '99999999-0000-4000-8000-000000000401',
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000101',
  'failed',
  20,
  '99999999-0000-4000-8000-000000000201',
  '99999999-0000-4000-8000-000000000501',
  'PROVIDER_ERROR',
  'provider failed',
  now(),
  1,
  1
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
  '99999999-0000-4000-8000-000000000302',
  '99999999-0000-4000-8000-000000000402',
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000101',
  'waiting',
  20,
  '99999999-0000-4000-8000-000000000202',
  '99999999-0000-4000-8000-000000000502',
  2,
  1,
  '99999999-0000-4000-8000-000000000301'
);

DO $$
DECLARE
  waiting_run record;
BEGIN
  SELECT status, reservation_credits, charged_credits, lease_owner
  INTO waiting_run
  FROM runs
  WHERE id = '99999999-0000-4000-8000-000000000302';

  IF
    waiting_run.status <> 'waiting'
    OR waiting_run.reservation_credits <> 20
    OR waiting_run.charged_credits IS NOT NULL
    OR waiting_run.lease_owner IS NOT NULL
  THEN
    RAISE EXCEPTION 'waiting Run did not retain the expected reserved shape';
  END IF;
END;
$$;

-- A retry is a new attempt of the same Turn and reuses the same input message.
-- Repointing the waiting successor in this transaction is mandatory.
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
  retry_of_run_id
)
VALUES (
  '99999999-0000-4000-8000-000000000303',
  '99999999-0000-4000-8000-000000000403',
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000101',
  'queued',
  20,
  '99999999-0000-4000-8000-000000000201',
  '99999999-0000-4000-8000-000000000503',
  1,
  2,
  '99999999-0000-4000-8000-000000000301'
);

UPDATE runs
SET predecessor_run_id = '99999999-0000-4000-8000-000000000303'
WHERE id = '99999999-0000-4000-8000-000000000302';

-- The original active-head uniqueness remains in force.
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
  attempt_index
)
VALUES (
  '99999999-0000-4000-8000-000000000304',
  '99999999-0000-4000-8000-000000000404',
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000102',
  'queued',
  20,
  '99999999-0000-4000-8000-000000000203',
  '99999999-0000-4000-8000-000000000504',
  1,
  1
);

DO $$
BEGIN
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
      '99999999-0000-4000-8000-000000000305',
      '99999999-0000-4000-8000-000000000405',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000102',
      'queued',
      20,
      '99999999-0000-4000-8000-000000000204',
      '99999999-0000-4000-8000-000000000505',
      2,
      1,
      '99999999-0000-4000-8000-000000000304'
    );
    RAISE EXCEPTION 'expected a second executable head to be rejected';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- A waiting Run can never carry a worker lease.
DO $$
BEGIN
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
      predecessor_run_id,
      lease_owner,
      lease_expires_at,
      heartbeat_at
    )
    VALUES (
      '99999999-0000-4000-8000-000000000306',
      '99999999-0000-4000-8000-000000000406',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000102',
      'waiting',
      20,
      '99999999-0000-4000-8000-000000000204',
      '99999999-0000-4000-8000-000000000506',
      2,
      1,
      '99999999-0000-4000-8000-000000000304',
      '99999999-0000-4000-8000-000000000601',
      now() + interval '1 minute',
      now()
    );
    RAISE EXCEPTION 'expected a leased waiting Run to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Cross-conversation predecessors are rejected by the strict validator.
DO $$
BEGIN
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
      '99999999-0000-4000-8000-000000000307',
      '99999999-0000-4000-8000-000000000407',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000103',
      'waiting',
      20,
      '99999999-0000-4000-8000-000000000205',
      '99999999-0000-4000-8000-000000000507',
      2,
      1,
      '99999999-0000-4000-8000-000000000304'
    );
    PERFORM assert_run_turn_queue_integrity(
      '99999999-0000-4000-8000-000000000307'
    );
    RAISE EXCEPTION 'expected a cross-conversation predecessor to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Cross-conversation retry sources are rejected independently of predecessors.
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
  '99999999-0000-4000-8000-000000000308',
  '99999999-0000-4000-8000-000000000408',
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000104',
  'failed',
  20,
  '99999999-0000-4000-8000-000000000206',
  '99999999-0000-4000-8000-000000000508',
  'PROVIDER_ERROR',
  'provider failed',
  now(),
  1,
  1
);

-- Unlike a pre-queued waiting successor, a new message submitted after the
-- failure is immediately executable because its predecessor is already terminal.
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
  '99999999-0000-4000-8000-000000000311',
  '99999999-0000-4000-8000-000000000411',
  '99999999-0000-4000-8000-000000000001',
  '99999999-0000-4000-8000-000000000104',
  'queued',
  20,
  '99999999-0000-4000-8000-000000000207',
  '99999999-0000-4000-8000-000000000511',
  2,
  1,
  '99999999-0000-4000-8000-000000000308'
);

SELECT assert_run_turn_queue_integrity(
  '99999999-0000-4000-8000-000000000311'
);

-- Once a direct successor is queued/running/terminal, retrying the earlier
-- failed Turn would fork existing history and must be rejected. Only a waiting
-- successor may be atomically rewired to the retry.
DO $$
BEGIN
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
      retry_of_run_id
    )
    VALUES (
      '99999999-0000-4000-8000-000000000312',
      '99999999-0000-4000-8000-000000000412',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000104',
      'cancelled',
      20,
      '99999999-0000-4000-8000-000000000206',
      '99999999-0000-4000-8000-000000000512',
      'RUN_CANCELLED',
      'cancelled',
      now(),
      1,
      2,
      '99999999-0000-4000-8000-000000000308'
    );
    PERFORM assert_run_turn_queue_integrity(
      '99999999-0000-4000-8000-000000000312'
    );
    RAISE EXCEPTION 'expected retry after a non-waiting successor to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
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
      retry_of_run_id
    )
    VALUES (
      '99999999-0000-4000-8000-000000000309',
      '99999999-0000-4000-8000-000000000409',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000103',
      'cancelled',
      20,
      '99999999-0000-4000-8000-000000000206',
      '99999999-0000-4000-8000-000000000509',
      'RUN_CANCELLED',
      'cancelled',
      now(),
      1,
      2,
      '99999999-0000-4000-8000-000000000308'
    );
    PERFORM assert_run_turn_queue_integrity(
      '99999999-0000-4000-8000-000000000309'
    );
    RAISE EXCEPTION 'expected a cross-conversation retry source to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- One source attempt can have only one direct retry.
DO $$
BEGIN
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
      retry_of_run_id
    )
    VALUES (
      '99999999-0000-4000-8000-000000000310',
      '99999999-0000-4000-8000-000000000410',
      '99999999-0000-4000-8000-000000000001',
      '99999999-0000-4000-8000-000000000101',
      'cancelled',
      20,
      '99999999-0000-4000-8000-000000000201',
      '99999999-0000-4000-8000-000000000510',
      'RUN_CANCELLED',
      'cancelled',
      now(),
      1,
      3,
      '99999999-0000-4000-8000-000000000301'
    );
    RAISE EXCEPTION 'expected a second direct retry to be rejected';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END;
$$;

-- Completing the retry and its rewired direct successor is valid. The original
-- failed Run and its attempt number remain unchanged.
UPDATE runs
SET
  status = 'completed',
  charged_credits = 10,
  input_tokens = 10,
  output_tokens = 20,
  web_searches = 1,
  completed_at = now(),
  finished_at = now(),
  updated_at = now()
WHERE id = '99999999-0000-4000-8000-000000000303';

UPDATE runs
SET
  status = 'completed',
  charged_credits = 10,
  input_tokens = 10,
  output_tokens = 20,
  web_searches = 1,
  completed_at = now(),
  finished_at = now(),
  updated_at = now()
WHERE id = '99999999-0000-4000-8000-000000000302';

SET CONSTRAINTS ALL IMMEDIATE;

-- A terminal successor is still part of the same linear history. Repointing
-- completed B from the valid retry A2 back to stale A1 must fail when deferred
-- constraints are settled (the same validation point used at commit).
DO $$
BEGIN
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;

    UPDATE runs
    SET predecessor_run_id = '99999999-0000-4000-8000-000000000301'
    WHERE id = '99999999-0000-4000-8000-000000000302';

    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'expected completed successor to reject a stale predecessor attempt';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE
      schemaname = current_schema()
      AND indexname = 'runs_conversation_active_unique_idx'
      AND indexdef LIKE '%WHERE (status = ANY (ARRAY[''queued''::text, ''running''::text]))%'
  ) THEN
    RAISE EXCEPTION 'the single executable-head index is missing or changed';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM runs
    WHERE
      conversation_id = '99999999-0000-4000-8000-000000000101'
      AND conversation_turn = 1
  ) <> 2 THEN
    RAISE EXCEPTION 'the retry did not create exactly two attempts for Turn 1';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM runs
    WHERE
      id = '99999999-0000-4000-8000-000000000301'
      AND status = 'failed'
      AND attempt_index = 1
      AND retry_of_run_id IS NULL
  ) THEN
    RAISE EXCEPTION 'the original failed Run was mutated by retry assertions';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM runs
    WHERE
      id = '99999999-0000-4000-8000-000000000302'
      AND status = 'completed'
      AND predecessor_run_id = '99999999-0000-4000-8000-000000000303'
  ) THEN
    RAISE EXCEPTION 'the completed successor retained a stale predecessor attempt';
  END IF;
END;
$$;

ROLLBACK;
