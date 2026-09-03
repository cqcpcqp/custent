-- Repeatable PostgreSQL assertions for 015_run_regeneration_snapshots.sql.
-- The durable state is inspected first; every fixture below is rolled back.
BEGIN;

DO $$
DECLARE
  existing_run record;
  existing_snapshot record;
  invalid_first_turn_runs text;
BEGIN
  FOR existing_run IN SELECT id FROM runs LOOP
    PERFORM assert_run_turn_queue_integrity(existing_run.id);
  END LOOP;

  FOR existing_snapshot IN
    SELECT run_id, phase
    FROM run_session_snapshots
  LOOP
    PERFORM assert_run_session_snapshot_integrity(
      existing_snapshot.run_id,
      existing_snapshot.phase
    );
  END LOOP;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_first_turn_runs
  FROM runs run
  LEFT JOIN run_session_snapshots snapshot
    ON snapshot.run_id = run.id
    AND snapshot.phase = 'pre'
  WHERE
    run.status = 'completed'
    AND run.conversation_turn = 1
    AND run.predecessor_run_id IS NULL
    AND (
      snapshot.run_id IS NULL
      OR snapshot.item_count <> 0
      OR EXISTS (
        SELECT 1
        FROM run_session_snapshot_items snapshot_item
        WHERE
          snapshot_item.run_id = run.id
          AND snapshot_item.phase = 'pre'
      )
    );

  IF invalid_first_turn_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '015 assertion: completed first-turn Runs lack an empty pre snapshot: %',
      invalid_first_turn_runs
      USING ERRCODE = '23514';
  END IF;
END;
$$;

INSERT INTO users (id, name, available_credits)
VALUES (
  '15151515-0000-4000-8000-000000000001',
  '015 assertion user',
  1000
);

INSERT INTO conversations (id, user_id, title)
VALUES
  (
    '15151515-0000-4000-8000-000000000101',
    '15151515-0000-4000-8000-000000000001',
    'valid regeneration lineage'
  ),
  (
    '15151515-0000-4000-8000-000000000102',
    '15151515-0000-4000-8000-000000000001',
    'non-completed regeneration source'
  );

INSERT INTO messages (id, conversation_id, role, content, citations)
VALUES
  (
    '15151515-0000-4000-8000-000000000201',
    '15151515-0000-4000-8000-000000000101',
    'user',
    'first turn input',
    '[]'
  ),
  (
    '15151515-0000-4000-8000-000000000202',
    '15151515-0000-4000-8000-000000000101',
    'assistant',
    'first turn answer',
    '[]'
  ),
  (
    '15151515-0000-4000-8000-000000000203',
    '15151515-0000-4000-8000-000000000101',
    'user',
    'second turn input',
    '[]'
  ),
  (
    '15151515-0000-4000-8000-000000000204',
    '15151515-0000-4000-8000-000000000101',
    'assistant',
    'second turn answer',
    '[]'
  ),
  (
    '15151515-0000-4000-8000-000000000205',
    '15151515-0000-4000-8000-000000000101',
    'user',
    'wrong regeneration input',
    '[]'
  ),
  (
    '15151515-0000-4000-8000-000000000206',
    '15151515-0000-4000-8000-000000000102',
    'user',
    'failed source input',
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
    '15151515-0000-4000-8000-000000000301',
    '15151515-0000-4000-8000-000000000401',
    '15151515-0000-4000-8000-000000000001',
    '15151515-0000-4000-8000-000000000101',
    'completed',
    20,
    1,
    1,
    1,
    0,
    '15151515-0000-4000-8000-000000000201',
    '15151515-0000-4000-8000-000000000202',
    now(),
    now(),
    1,
    1,
    NULL
  ),
  (
    '15151515-0000-4000-8000-000000000302',
    '15151515-0000-4000-8000-000000000402',
    '15151515-0000-4000-8000-000000000001',
    '15151515-0000-4000-8000-000000000101',
    'completed',
    20,
    1,
    1,
    1,
    0,
    '15151515-0000-4000-8000-000000000203',
    '15151515-0000-4000-8000-000000000204',
    now(),
    now(),
    2,
    1,
    '15151515-0000-4000-8000-000000000301'
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
  '15151515-0000-4000-8000-000000000303',
  '15151515-0000-4000-8000-000000000403',
  '15151515-0000-4000-8000-000000000001',
  '15151515-0000-4000-8000-000000000102',
  'failed',
  20,
  '15151515-0000-4000-8000-000000000206',
  '15151515-0000-4000-8000-000000000207',
  'PROVIDER_ERROR',
  'provider failed',
  now(),
  1,
  1
);

UPDATE messages
SET run_id = CASE id
  WHEN '15151515-0000-4000-8000-000000000201'::uuid
    THEN '15151515-0000-4000-8000-000000000301'::uuid
  WHEN '15151515-0000-4000-8000-000000000202'::uuid
    THEN '15151515-0000-4000-8000-000000000301'::uuid
  WHEN '15151515-0000-4000-8000-000000000203'::uuid
    THEN '15151515-0000-4000-8000-000000000302'::uuid
  WHEN '15151515-0000-4000-8000-000000000204'::uuid
    THEN '15151515-0000-4000-8000-000000000302'::uuid
  WHEN '15151515-0000-4000-8000-000000000206'::uuid
    THEN '15151515-0000-4000-8000-000000000303'::uuid
END
WHERE id IN (
  '15151515-0000-4000-8000-000000000201',
  '15151515-0000-4000-8000-000000000202',
  '15151515-0000-4000-8000-000000000203',
  '15151515-0000-4000-8000-000000000204',
  '15151515-0000-4000-8000-000000000206'
);

INSERT INTO run_session_snapshots (run_id, phase, item_count)
VALUES
  ('15151515-0000-4000-8000-000000000301', 'pre', 0),
  ('15151515-0000-4000-8000-000000000302', 'pre', 2),
  ('15151515-0000-4000-8000-000000000302', 'post', 3);

INSERT INTO run_session_snapshot_items (run_id, phase, position, item)
VALUES
  (
    '15151515-0000-4000-8000-000000000302',
    'pre',
    1,
    '{"role":"user","content":"prior input"}'
  ),
  (
    '15151515-0000-4000-8000-000000000302',
    'pre',
    2,
    '{"role":"assistant","content":"prior answer"}'
  ),
  (
    '15151515-0000-4000-8000-000000000302',
    'post',
    1,
    '{"role":"user","content":"prior input"}'
  ),
  (
    '15151515-0000-4000-8000-000000000302',
    'post',
    2,
    '{"role":"assistant","content":"prior answer"}'
  ),
  (
    '15151515-0000-4000-8000-000000000302',
    'post',
    3,
    '{"role":"assistant","content":"current answer"}'
  );

SET CONSTRAINTS ALL IMMEDIATE;

-- retry_of_run_id and regenerate_of_run_id are mutually exclusive.
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
      retry_of_run_id,
      regenerate_of_run_id
    )
    VALUES (
      '15151515-0000-4000-8000-000000000311',
      '15151515-0000-4000-8000-000000000411',
      '15151515-0000-4000-8000-000000000001',
      '15151515-0000-4000-8000-000000000101',
      'queued',
      20,
      '15151515-0000-4000-8000-000000000203',
      '15151515-0000-4000-8000-000000000211',
      2,
      2,
      '15151515-0000-4000-8000-000000000301',
      '15151515-0000-4000-8000-000000000302',
      '15151515-0000-4000-8000-000000000302'
    );

    RAISE EXCEPTION 'expected retry/regenerate dual lineage to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- A regeneration source must be completed.
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
      regenerate_of_run_id
    )
    VALUES (
      '15151515-0000-4000-8000-000000000312',
      '15151515-0000-4000-8000-000000000412',
      '15151515-0000-4000-8000-000000000001',
      '15151515-0000-4000-8000-000000000102',
      'queued',
      20,
      '15151515-0000-4000-8000-000000000206',
      '15151515-0000-4000-8000-000000000212',
      1,
      2,
      '15151515-0000-4000-8000-000000000303'
    );

    RAISE EXCEPTION 'expected regeneration of a failed Run to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Regeneration must preserve the source input and predecessor exactly.
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
      regenerate_of_run_id
    )
    VALUES (
      '15151515-0000-4000-8000-000000000313',
      '15151515-0000-4000-8000-000000000413',
      '15151515-0000-4000-8000-000000000001',
      '15151515-0000-4000-8000-000000000101',
      'queued',
      20,
      '15151515-0000-4000-8000-000000000205',
      '15151515-0000-4000-8000-000000000213',
      2,
      2,
      '15151515-0000-4000-8000-000000000301',
      '15151515-0000-4000-8000-000000000302'
    );

    RAISE EXCEPTION 'expected mismatched regeneration input to be rejected';
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
      predecessor_run_id,
      regenerate_of_run_id
    )
    VALUES (
      '15151515-0000-4000-8000-000000000314',
      '15151515-0000-4000-8000-000000000414',
      '15151515-0000-4000-8000-000000000001',
      '15151515-0000-4000-8000-000000000101',
      'queued',
      20,
      '15151515-0000-4000-8000-000000000203',
      '15151515-0000-4000-8000-000000000214',
      2,
      2,
      NULL,
      '15151515-0000-4000-8000-000000000302'
    );

    RAISE EXCEPTION 'expected mismatched regeneration predecessor to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- A regeneration must be the direct next attempt.
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
      regenerate_of_run_id
    )
    VALUES (
      '15151515-0000-4000-8000-000000000315',
      '15151515-0000-4000-8000-000000000415',
      '15151515-0000-4000-8000-000000000001',
      '15151515-0000-4000-8000-000000000101',
      'queued',
      20,
      '15151515-0000-4000-8000-000000000203',
      '15151515-0000-4000-8000-000000000215',
      2,
      3,
      '15151515-0000-4000-8000-000000000301',
      '15151515-0000-4000-8000-000000000302'
    );

    RAISE EXCEPTION 'expected skipped regeneration attempt to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- A completed Run with a successor can no longer be regenerated.
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
      regenerate_of_run_id
    )
    VALUES (
      '15151515-0000-4000-8000-000000000316',
      '15151515-0000-4000-8000-000000000416',
      '15151515-0000-4000-8000-000000000001',
      '15151515-0000-4000-8000-000000000101',
      'queued',
      20,
      '15151515-0000-4000-8000-000000000201',
      '15151515-0000-4000-8000-000000000216',
      1,
      2,
      NULL,
      '15151515-0000-4000-8000-000000000301'
    );

    RAISE EXCEPTION 'expected regeneration after a successor to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- This is the valid completed-source -> queued-regeneration shape.
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
  regenerate_of_run_id
)
VALUES (
  '15151515-0000-4000-8000-000000000304',
  '15151515-0000-4000-8000-000000000404',
  '15151515-0000-4000-8000-000000000001',
  '15151515-0000-4000-8000-000000000101',
  'queued',
  20,
  '15151515-0000-4000-8000-000000000203',
  '15151515-0000-4000-8000-000000000208',
  2,
  2,
  '15151515-0000-4000-8000-000000000301',
  '15151515-0000-4000-8000-000000000302'
);

-- A post snapshot cannot describe a Run that has not completed.
DO $$
BEGIN
  BEGIN
    INSERT INTO run_session_snapshots (run_id, phase, item_count)
    VALUES ('15151515-0000-4000-8000-000000000304', 'post', 0);

    RAISE EXCEPTION 'expected a queued Run post snapshot to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Header count and 1-based positions must describe one contiguous sequence.
DO $$
BEGIN
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;

    INSERT INTO run_session_snapshots (run_id, phase, item_count)
    VALUES ('15151515-0000-4000-8000-000000000303', 'pre', 2);

    INSERT INTO run_session_snapshot_items (run_id, phase, position, item)
    VALUES
      (
        '15151515-0000-4000-8000-000000000303',
        'pre',
        1,
        '{"role":"user","content":"one"}'
      ),
      (
        '15151515-0000-4000-8000-000000000303',
        'pre',
        3,
        '{"role":"assistant","content":"gap"}'
      );

    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'expected a non-contiguous snapshot to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

-- Both headers and items are immutable after insertion.
DO $$
BEGIN
  BEGIN
    UPDATE run_session_snapshots
    SET item_count = item_count
    WHERE
      run_id = '15151515-0000-4000-8000-000000000302'
      AND phase = 'pre';
    RAISE EXCEPTION 'expected snapshot header update to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    DELETE FROM run_session_snapshots
    WHERE
      run_id = '15151515-0000-4000-8000-000000000302'
      AND phase = 'post';
    RAISE EXCEPTION 'expected snapshot header delete to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE run_session_snapshot_items
    SET item = item
    WHERE
      run_id = '15151515-0000-4000-8000-000000000302'
      AND phase = 'pre'
      AND position = 1;
    RAISE EXCEPTION 'expected snapshot item update to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    DELETE FROM run_session_snapshot_items
    WHERE
      run_id = '15151515-0000-4000-8000-000000000302'
      AND phase = 'post'
      AND position = 1;
    RAISE EXCEPTION 'expected snapshot item delete to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

DO $$
DECLARE
  fixture_run record;
  fixture_snapshot record;
BEGIN
  FOR fixture_run IN
    SELECT id
    FROM runs
    WHERE user_id = '15151515-0000-4000-8000-000000000001'
  LOOP
    PERFORM assert_run_turn_queue_integrity(fixture_run.id);
  END LOOP;

  FOR fixture_snapshot IN
    SELECT run_id, phase
    FROM run_session_snapshots
    WHERE run_id IN (
      '15151515-0000-4000-8000-000000000301',
      '15151515-0000-4000-8000-000000000302'
    )
  LOOP
    PERFORM assert_run_session_snapshot_integrity(
      fixture_snapshot.run_id,
      fixture_snapshot.phase
    );
  END LOOP;
END;
$$;

ROLLBACK;
