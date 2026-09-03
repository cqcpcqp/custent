-- Repeatable PostgreSQL assertions for 017_input_attachment_formats.sql.
-- This script exercises the live constraints and always rolls its transaction back.
BEGIN;

DO $$
DECLARE
  candidate_id uuid;
  valid_format record;
BEGIN
  FOR valid_format IN
    SELECT format.kind, format.mime_type
    FROM (
      VALUES
        ('file', 'text/plain'),
        ('file', 'application/pdf'),
        ('file', 'text/csv'),
        ('file', 'text/markdown'),
        ('file', 'application/json'),
        (
          'file',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ),
        (
          'file',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        ),
        (
          'file',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        ),
        ('image', 'image/png'),
        ('image', 'image/jpeg'),
        ('image', 'image/webp'),
        ('image', 'image/gif')
    ) AS format(kind, mime_type)
  LOOP
    candidate_id := md5(
      clock_timestamp()::text || random()::text || valid_format.mime_type
    )::uuid;
    INSERT INTO input_attachments (
      id,
      user_id,
      kind,
      original_name,
      mime_type,
      size_bytes,
      sha256,
      storage_path,
      expires_at
    )
    VALUES (
      candidate_id,
      '11111111-1111-4111-8111-111111111111',
      valid_format.kind,
      '017-assertion.fixture',
      valid_format.mime_type,
      1,
      repeat('a', 64),
      candidate_id::text,
      now() + interval '1 hour'
    );

    candidate_id := md5(
      clock_timestamp()::text || random()::text || valid_format.mime_type
        || '-opposite-kind'
    )::uuid;
    BEGIN
      INSERT INTO input_attachments (
        id,
        user_id,
        kind,
        original_name,
        mime_type,
        size_bytes,
        sha256,
        storage_path,
        expires_at
      )
      VALUES (
        candidate_id,
        '11111111-1111-4111-8111-111111111111',
        CASE valid_format.kind WHEN 'file' THEN 'image' ELSE 'file' END,
        '017-opposite-kind.fixture',
        valid_format.mime_type,
        1,
        repeat('b', 64),
        candidate_id::text,
        now() + interval '1 hour'
      );
      RAISE EXCEPTION
        '017 assertion: MIME % was accepted with its opposite kind',
        valid_format.mime_type;
    EXCEPTION
      WHEN check_violation THEN NULL;
    END;
  END LOOP;

  candidate_id := md5(clock_timestamp()::text || random()::text)::uuid;
  BEGIN
    INSERT INTO input_attachments (
      id,
      user_id,
      kind,
      original_name,
      mime_type,
      size_bytes,
      sha256,
      storage_path,
      expires_at
    )
    VALUES (
      candidate_id,
      '11111111-1111-4111-8111-111111111111',
      'file',
      'unknown.svg',
      'image/svg+xml',
      1,
      repeat('c', 64),
      candidate_id::text,
      now() + interval '1 hour'
    );
    RAISE EXCEPTION '017 assertion: unknown MIME type was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

END;
$$;

ROLLBACK;
