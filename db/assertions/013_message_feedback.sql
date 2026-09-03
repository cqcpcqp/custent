-- Repeatable PostgreSQL assertions for 013_message_feedback.sql.
-- All fixtures are local to this transaction and are rolled back.
BEGIN;

DO $$
DECLARE
  feedback_data_type text;
  feedback_is_nullable text;
  invalid_messages text;
  assertion_user_id uuid := gen_random_uuid();
  assertion_conversation_id uuid := gen_random_uuid();
BEGIN
  SELECT column_info.data_type, column_info.is_nullable
  INTO feedback_data_type, feedback_is_nullable
  FROM information_schema.columns column_info
  WHERE
    column_info.table_schema = current_schema()
    AND column_info.table_name = 'messages'
    AND column_info.column_name = 'feedback';

  IF feedback_data_type IS DISTINCT FROM 'text'
    OR feedback_is_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION
      '013 assertion: messages.feedback must be nullable text'
      USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(message.id::text, ', ' ORDER BY message.id)
  INTO invalid_messages
  FROM messages message
  WHERE
    (message.feedback IS NOT NULL AND message.feedback NOT IN ('up', 'down'))
    OR (message.role = 'user' AND message.feedback IS NOT NULL);

  IF invalid_messages IS NOT NULL THEN
    RAISE EXCEPTION
      '013 assertion: messages contain invalid feedback: %',
      invalid_messages
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO users (id, name, available_credits)
  VALUES (assertion_user_id, '013 assertion user', 100);

  INSERT INTO conversations (id, user_id, title)
  VALUES (
    assertion_conversation_id,
    assertion_user_id,
    'message feedback constraints'
  );

  INSERT INTO messages (conversation_id, role, content, citations, feedback)
  VALUES
    (assertion_conversation_id, 'user', 'question', '[]', NULL),
    (assertion_conversation_id, 'assistant', 'up answer', '[]', 'up'),
    (assertion_conversation_id, 'assistant', 'down answer', '[]', 'down'),
    (assertion_conversation_id, 'assistant', 'unrated answer', '[]', NULL);

  BEGIN
    INSERT INTO messages (
      conversation_id,
      role,
      content,
      citations,
      feedback
    )
    VALUES (
      assertion_conversation_id,
      'user',
      'invalid rated question',
      '[]',
      'up'
    );
    RAISE EXCEPTION 'expected user-message feedback to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO messages (
      conversation_id,
      role,
      content,
      citations,
      feedback
    )
    VALUES (
      assertion_conversation_id,
      'assistant',
      'invalid feedback value',
      '[]',
      'sideways'
    );
    RAISE EXCEPTION 'expected an unknown feedback value to be rejected';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END;
$$;

ROLLBACK;
