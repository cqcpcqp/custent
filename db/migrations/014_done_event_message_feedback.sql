-- Durable done events embed the fixed ChatMessage contract. Keep historical
-- event replay readable after feedback becomes a required nullable field.
UPDATE run_events
SET payload = jsonb_set(
  payload,
  '{message,feedback}',
  'null'::jsonb,
  true
)
WHERE event_type = 'done';
