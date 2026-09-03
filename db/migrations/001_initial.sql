CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  available_credits integer NOT NULL CHECK (available_credits >= 0),
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  frozen_credits integer NOT NULL DEFAULT 0 CHECK (frozen_credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversations_user_updated_idx
  ON conversations (user_id, updated_at DESC, id DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(citations) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at, id);

CREATE TABLE agent_session_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position bigint NOT NULL CHECK (position > 0),
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, position)
);

CREATE INDEX agent_session_items_conversation_position_idx
  ON agent_session_items (conversation_id, position);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (
    status IN ('reserved', 'running', 'completed', 'reconciliation_required')
  ),
  reservation_credits integer NOT NULL CHECK (reservation_credits > 0),
  charged_credits integer CHECK (charged_credits >= 0),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  web_searches integer CHECK (web_searches >= 0),
  reconciliation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'completed' AND charged_credits IS NOT NULL AND completed_at IS NOT NULL)
    OR
    (status <> 'completed' AND charged_credits IS NULL AND completed_at IS NULL)
  ),
  CHECK (
    (status = 'reconciliation_required' AND reconciliation_reason IS NOT NULL)
    OR
    (status <> 'reconciliation_required' AND reconciliation_reason IS NULL)
  )
);

CREATE INDEX runs_user_created_idx ON runs (user_id, created_at DESC);
CREATE INDEX runs_conversation_created_idx ON runs (conversation_id, created_at DESC);

CREATE TABLE credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES runs(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  entry_type text NOT NULL CHECK (entry_type IN ('grant', 'reserve', 'settle', 'freeze')),
  available_delta integer NOT NULL,
  reserved_delta integer NOT NULL,
  frozen_delta integer NOT NULL,
  CHECK (
    (entry_type = 'grant' AND run_id IS NULL)
    OR
    (entry_type <> 'grant' AND run_id IS NOT NULL)
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_ledger_user_created_idx
  ON credit_ledger (user_id, created_at DESC, id DESC);

CREATE TABLE research_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  query_summary text NOT NULL CHECK (length(query_summary) BETWEEN 1 AND 4000),
  limitations text NOT NULL CHECK (length(limitations) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX research_snapshots_conversation_created_idx
  ON research_snapshots (conversation_id, created_at DESC, id DESC);

CREATE TABLE research_companies (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES research_snapshots(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  website_url text NOT NULL,
  country text NOT NULL CHECK (length(country) BETWEEN 2 AND 120),
  company_type text NOT NULL CHECK (
    company_type IN (
      'importer',
      'distributor',
      'retailer',
      'brand',
      'manufacturer',
      'industrial_end_user',
      'other'
    )
  ),
  relevance_summary text NOT NULL CHECK (length(relevance_summary) BETWEEN 1 AND 2000),
  UNIQUE (snapshot_id, ordinal)
);

CREATE TABLE research_contacts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES research_companies(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  title_original text NOT NULL CHECK (length(title_original) BETWEEN 1 AND 500),
  role_category text NOT NULL CHECK (
    role_category IN (
      'procurement',
      'purchasing',
      'sourcing',
      'buyer',
      'category_product',
      'supply_chain',
      'operations',
      'engineering_project',
      'owner_executive',
      'business_development',
      'other'
    )
  ),
  public_profile_url text,
  confidence text NOT NULL CHECK (confidence IN ('A', 'B', 'C')),
  UNIQUE (company_id, ordinal)
);

CREATE TABLE research_evidence (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES research_snapshots(id) ON DELETE CASCADE,
  company_id uuid REFERENCES research_companies(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES research_contacts(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  claim text NOT NULL CHECK (length(claim) BETWEEN 1 AND 2000),
  source_url text NOT NULL,
  source_title text NOT NULL CHECK (length(source_title) BETWEEN 1 AND 500),
  supports text NOT NULL CHECK (
    supports IN ('company_identity', 'business_fit', 'contact_role')
  ),
  CHECK ((company_id IS NOT NULL)::integer + (contact_id IS NOT NULL)::integer = 1)
);

CREATE UNIQUE INDEX research_evidence_company_ordinal_idx
  ON research_evidence (company_id, ordinal)
  WHERE company_id IS NOT NULL;

CREATE UNIQUE INDEX research_evidence_contact_ordinal_idx
  ON research_evidence (contact_id, ordinal)
  WHERE contact_id IS NOT NULL;

CREATE TABLE artifacts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  research_snapshot_id uuid NOT NULL REFERENCES research_snapshots(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  mime_type text NOT NULL CHECK (mime_type IN ('text/csv', 'application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX artifacts_message_created_idx
  ON artifacts (message_id, created_at, id);

INSERT INTO users (id, name, available_credits)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  '演示用户',
  10000
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO credit_ledger (
  user_id,
  run_id,
  idempotency_key,
  entry_type,
  available_delta,
  reserved_delta,
  frozen_delta
)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  NULL,
  'demo-initial-grant-v1',
  'grant',
  10000,
  0,
  0
)
ON CONFLICT (idempotency_key) DO NOTHING;
