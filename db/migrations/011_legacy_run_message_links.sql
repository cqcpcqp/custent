-- Repair Run/message links written before message IDs became mandatory for the
-- chat lifecycle. This migration is intentionally conservative: it only uses
-- the audited temporal relationship between a legacy Run and its user message,
-- and aborts the whole transaction when that relationship is not unique.

LOCK TABLE
  runs,
  messages,
  agent_session_items,
  run_events,
  research_snapshots,
  artifacts
IN SHARE ROW EXCLUSIVE MODE;

-- A legacy input belongs to the Run whose [created_at, next Run.created_at)
-- window contains it. Run IDs only break ties when finding the next Run; the
-- temporal window itself remains strict, so equal timestamps fail closed.
CREATE TEMP TABLE migration_011_input_candidates
ON COMMIT DROP
AS
WITH run_windows AS (
  SELECT
    run.id,
    run.conversation_id,
    run.created_at,
    lead(run.created_at) OVER (
      PARTITION BY run.conversation_id
      ORDER BY run.created_at, run.id
    ) AS next_run_created_at
  FROM runs run
), missing_inputs AS (
  SELECT
    run.id AS run_id,
    run.conversation_id,
    run_window.created_at,
    run_window.next_run_created_at
  FROM runs run
  JOIN run_windows run_window ON run_window.id = run.id
  WHERE run.input_message_id IS NULL
)
SELECT
  missing.run_id,
  count(message.id)::integer AS candidate_count,
  (
    array_agg(message.id ORDER BY message.created_at, message.id)
      FILTER (WHERE message.id IS NOT NULL)
  )[1] AS candidate_message_id
FROM missing_inputs missing
LEFT JOIN messages message
  ON message.conversation_id = missing.conversation_id
  AND message.role = 'user'
  AND message.created_at >= missing.created_at
  AND (
    missing.next_run_created_at IS NULL
    OR message.created_at < missing.next_run_created_at
  )
GROUP BY missing.run_id;

DO $$
DECLARE
  invalid_runs text;
BEGIN
  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  WHERE
    run.input_message_id IS NULL
    AND (run.attempt_index <> 1 OR run.retry_of_run_id IS NOT NULL);

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 cannot infer input messages for retry attempts: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(
    format('%s (candidates=%s)', candidate.run_id, candidate.candidate_count),
    ', '
    ORDER BY candidate.run_id
  )
  INTO invalid_runs
  FROM migration_011_input_candidates candidate
  WHERE candidate.candidate_count <> 1;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 requires exactly one temporal user-message candidate per legacy Run: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(
    format(
      '%s -> message %s already used by Run %s',
      candidate.run_id,
      candidate.candidate_message_id,
      owner.id
    ),
    ', '
    ORDER BY candidate.run_id
  )
  INTO invalid_runs
  FROM migration_011_input_candidates candidate
  JOIN runs owner
    ON owner.input_message_id = candidate.candidate_message_id
    AND owner.id <> candidate.run_id;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 refuses to reuse an input message already owned by another Run: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(
    format(
      '%s -> message %s is linked to Run %s',
      candidate.run_id,
      candidate.candidate_message_id,
      message.run_id
    ),
    ', '
    ORDER BY candidate.run_id
  )
  INTO invalid_runs
  FROM migration_011_input_candidates candidate
  JOIN messages message ON message.id = candidate.candidate_message_id
  WHERE
    message.run_id IS NOT NULL
    AND message.run_id <> candidate.run_id;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 temporal input candidate is linked to another Run: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(
    format(
      '%s already has linked user message %s outside the temporal candidate',
      candidate.run_id,
      linked_message.id
    ),
    ', '
    ORDER BY candidate.run_id
  )
  INTO invalid_runs
  FROM migration_011_input_candidates candidate
  JOIN messages linked_message
    ON linked_message.run_id = candidate.run_id
    AND linked_message.role = 'user'
    AND linked_message.id <> candidate.candidate_message_id;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 found conflicting linked input evidence: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(candidate_message_id::text, ', ' ORDER BY candidate_message_id)
  INTO invalid_runs
  FROM migration_011_input_candidates
  GROUP BY candidate_message_id
  HAVING count(*) <> 1
  LIMIT 1;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 assigned one temporal input candidate to multiple Runs: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;
END;
$$;

-- The first attempt owns the user message. Retry attempts reuse that message
-- through runs.input_message_id but never replace messages.run_id.
UPDATE messages message
SET run_id = candidate.run_id
FROM migration_011_input_candidates candidate
WHERE
  message.id = candidate.candidate_message_id
  AND message.run_id IS NULL;

UPDATE runs run
SET input_message_id = candidate.candidate_message_id
FROM migration_011_input_candidates candidate
WHERE run.id = candidate.run_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM migration_011_input_candidates candidate
    JOIN runs run ON run.id = candidate.run_id
    JOIN messages message ON message.id = candidate.candidate_message_id
    WHERE
      run.input_message_id IS DISTINCT FROM candidate.candidate_message_id
      OR message.run_id IS DISTINCT FROM run.id
      OR message.conversation_id IS DISTINCT FROM run.conversation_id
      OR message.role <> 'user'
  ) THEN
    RAISE EXCEPTION '011 failed to bind a recovered input message to its first Run attempt'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TEMP TABLE migration_011_missing_assistants
ON COMMIT DROP
AS
SELECT
  run.id AS run_id,
  run.conversation_id,
  run.status,
  run.completed_at,
  run.finished_at,
  run.updated_at,
  run.created_at
FROM runs run
WHERE run.assistant_message_id IS NULL;

DO $$
DECLARE
  invalid_runs text;
BEGIN
  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  JOIN migration_011_missing_assistants missing ON missing.run_id = run.id
  WHERE run.attempt_index <> 1 OR run.retry_of_run_id IS NOT NULL;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 cannot create planned assistant IDs for retry attempts: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(missing.run_id::text, ', ' ORDER BY missing.run_id)
  INTO invalid_runs
  FROM migration_011_missing_assistants missing
  WHERE missing.status NOT IN (
    'completed',
    'failed',
    'cancelled',
    'reconciliation_required'
  );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 refuses to infer an assistant ID for a non-terminal Run: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(
    format('%s -> assistant message %s', missing.run_id, message.id),
    ', '
    ORDER BY missing.run_id
  )
  INTO invalid_runs
  FROM migration_011_missing_assistants missing
  JOIN messages message
    ON message.run_id = missing.run_id
    AND message.role = 'assistant';

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 found a recoverable assistant message but no Run link: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  -- A completed Run is only declared irrecoverable when no possible answer
  -- evidence survives. Any evidence requires a deliberate manual recovery;
  -- guessing which payload was the final answer would corrupt history.
  SELECT string_agg(missing.run_id::text, ', ' ORDER BY missing.run_id)
  INTO invalid_runs
  FROM migration_011_missing_assistants missing
  WHERE
    missing.status = 'completed'
    AND (
      EXISTS (
        SELECT 1
        FROM messages message
        WHERE
          message.conversation_id = missing.conversation_id
          AND message.role = 'assistant'
      )
      OR EXISTS (
        SELECT 1
        FROM agent_session_items session_item
        WHERE
          session_item.conversation_id = missing.conversation_id
          AND session_item.item ->> 'role' = 'assistant'
      )
      OR EXISTS (
        SELECT 1
        FROM run_events event
        WHERE event.run_id = missing.run_id
      )
      OR EXISTS (
        SELECT 1
        FROM research_snapshots snapshot
        WHERE snapshot.run_id = missing.run_id
      )
      OR EXISTS (
        SELECT 1
        FROM artifacts artifact
        WHERE artifact.run_id = missing.run_id
      )
    );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 found possible answer evidence for completed legacy Runs; manual recovery is required: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE TEMP TABLE migration_011_completed_assistant_messages
ON COMMIT DROP
AS
SELECT
  missing.run_id,
  gen_random_uuid() AS message_id
FROM migration_011_missing_assistants missing
WHERE missing.status = 'completed';

INSERT INTO messages (
  id,
  conversation_id,
  run_id,
  role,
  content,
  citations,
  created_at
)
SELECT
  generated.message_id,
  missing.conversation_id,
  missing.run_id,
  'assistant',
  '【系统迁移说明】这个历史运行在旧版本中被标记为“已完成”，但数据库中没有保存可恢复的助手回答。此消息由数据迁移生成，仅用于说明记录缺失，并不是模型生成的回答。',
  '[]'::jsonb,
  COALESCE(
    missing.finished_at,
    missing.completed_at,
    missing.updated_at
  )
FROM migration_011_completed_assistant_messages generated
JOIN migration_011_missing_assistants missing
  ON missing.run_id = generated.run_id;

UPDATE runs run
SET assistant_message_id = generated.message_id
FROM migration_011_completed_assistant_messages generated
WHERE run.id = generated.run_id;

-- Failed, cancelled, and reconciliation-required Runs have no assistant
-- message. They still need the planned UUID used by the fixed Run contract.
UPDATE runs run
SET assistant_message_id = gen_random_uuid()
FROM migration_011_missing_assistants missing
WHERE
  run.id = missing.run_id
  AND missing.status IN (
    'failed',
    'cancelled',
    'reconciliation_required'
  );

-- One-shot upgrade assertions. Nullable columns remain part of the historical
-- storage schema, but no row present at the end of this migration may use that
-- legacy shape.
DO $$
DECLARE
  invalid_runs text;
BEGIN
  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  WHERE run.input_message_id IS NULL OR run.assistant_message_id IS NULL;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 left Runs without fixed message IDs: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  LEFT JOIN messages input_message ON input_message.id = run.input_message_id
  WHERE
    run.attempt_index = 1
    AND (
      input_message.id IS NULL
      OR input_message.role IS DISTINCT FROM 'user'
      OR input_message.conversation_id IS DISTINCT FROM run.conversation_id
      OR input_message.run_id IS DISTINCT FROM run.id
    );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 first-attempt input messages are not bound to their Runs: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  LEFT JOIN runs first_attempt
    ON first_attempt.conversation_id = run.conversation_id
    AND first_attempt.conversation_turn = run.conversation_turn
    AND first_attempt.attempt_index = 1
  LEFT JOIN messages input_message ON input_message.id = run.input_message_id
  WHERE
    run.attempt_index > 1
    AND (
      first_attempt.id IS NULL
      OR run.input_message_id IS DISTINCT FROM first_attempt.input_message_id
      OR input_message.id IS NULL
      OR input_message.role IS DISTINCT FROM 'user'
      OR input_message.conversation_id IS DISTINCT FROM run.conversation_id
      OR input_message.run_id IS DISTINCT FROM first_attempt.id
    );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 retry inputs are not bound to their Turn first attempts: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(message.id::text, ', ' ORDER BY message.id)
  INTO invalid_runs
  FROM messages message
  LEFT JOIN runs declared_run ON declared_run.id = message.run_id
  WHERE
    message.run_id IS NOT NULL
    AND (
      declared_run.id IS NULL
      OR (
        message.role = 'user'
        AND (
          declared_run.attempt_index <> 1
          OR declared_run.input_message_id IS DISTINCT FROM message.id
        )
      )
      OR (
        message.role = 'assistant'
        AND declared_run.assistant_message_id IS DISTINCT FROM message.id
      )
    );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 found messages linked to Runs that do not declare them: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  JOIN messages assistant_message
    ON assistant_message.id = run.assistant_message_id
  WHERE
    assistant_message.role IS DISTINCT FROM 'assistant'
    OR assistant_message.conversation_id IS DISTINCT FROM run.conversation_id
    OR assistant_message.run_id IS DISTINCT FROM run.id;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 assistant message IDs resolve to inconsistent messages: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  LEFT JOIN messages assistant_message
    ON assistant_message.id = run.assistant_message_id
    AND assistant_message.run_id = run.id
    AND assistant_message.conversation_id = run.conversation_id
    AND assistant_message.role = 'assistant'
  WHERE run.status = 'completed' AND assistant_message.id IS NULL;

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 completed Runs still lack their assistant messages: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;
END;
$$;
