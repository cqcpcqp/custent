ALTER TABLE input_attachments
  DROP CONSTRAINT input_attachments_mime_type_check,
  DROP CONSTRAINT input_attachments_kind_mime_type_check;

ALTER TABLE input_attachments
  ADD CONSTRAINT input_attachments_mime_type_check CHECK (
    mime_type IN (
      'text/plain',
      'application/pdf',
      'text/csv',
      'text/markdown',
      'application/json',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif'
    )
  ),
  ADD CONSTRAINT input_attachments_kind_mime_type_check CHECK (
    (
      kind = 'image'
      AND mime_type IN (
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/gif'
      )
    )
    OR
    (
      kind = 'file'
      AND mime_type IN (
        'text/plain',
        'application/pdf',
        'text/csv',
        'text/markdown',
        'application/json',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      )
    )
  );
