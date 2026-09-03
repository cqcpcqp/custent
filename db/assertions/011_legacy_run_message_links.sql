-- Repeatable PostgreSQL assertions for 011_legacy_run_message_links.sql.
-- This script never mutates durable data and always rolls its transaction back.
BEGIN;

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
      '011 assertion: Runs still have nullable message links: %',
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
      '011 assertion: retry inputs are inconsistent: %',
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
      '011 assertion: messages.run_id contains undeclared links: %',
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
      '011 assertion: assistant message IDs resolve inconsistently: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(run.id::text, ', ' ORDER BY run.id)
  INTO invalid_runs
  FROM runs run
  LEFT JOIN messages input_message
    ON input_message.id = run.input_message_id
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
      '011 assertion: first-attempt input links are inconsistent: %',
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
      '011 assertion: completed Runs lack their assistant messages: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(message.run_id::text, ', ' ORDER BY message.run_id)
  INTO invalid_runs
  FROM messages message
  JOIN runs run ON run.id = message.run_id
  WHERE
    message.content = '【系统迁移说明】这个历史运行在旧版本中被标记为“已完成”，但数据库中没有保存可恢复的助手回答。此消息由数据迁移生成，仅用于说明记录缺失，并不是模型生成的回答。'
    AND (
      message.role <> 'assistant'
      OR message.citations <> '[]'::jsonb
      OR run.status <> 'completed'
      OR run.assistant_message_id IS DISTINCT FROM message.id
      OR message.created_at IS DISTINCT FROM COALESCE(
        run.finished_at,
        run.completed_at,
        run.updated_at
      )
    );

  IF invalid_runs IS NOT NULL THEN
    RAISE EXCEPTION
      '011 assertion: migration explanation messages are inconsistent: %',
      invalid_runs
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ROLLBACK;
