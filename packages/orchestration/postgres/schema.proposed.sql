-- 02-owned tables. Architecture control assigns the numbered global migration.
CREATE TABLE orch_conversations (
  conversation_id text PRIMARY KEY REFERENCES dispatch_control(conversation_id),
  contact_id uuid NOT NULL UNIQUE REFERENCES data_contacts(id),
  account_id text NOT NULL,
  external_contact_ref text NOT NULL,
  policy jsonb NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  generation bigint NOT NULL CHECK (generation > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  state text NOT NULL,
  pause_reasons text[] NOT NULL DEFAULT '{}',
  last_inbound_message_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orch_plans (
  id uuid PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES orch_conversations(conversation_id),
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  context_snapshot_id uuid NOT NULL REFERENCES data_context_snapshots(id),
  generation bigint NOT NULL,
  policy_version bigint NOT NULL,
  dependency_epoch bigint NOT NULL,
  skill_epoch bigint NOT NULL,
  trigger_message_ids uuid[] NOT NULL,
  fact_versions jsonb NOT NULL DEFAULT '{}',
  analysis_versions jsonb NOT NULL DEFAULT '{}',
  skill_versions jsonb NOT NULL DEFAULT '{}',
  risks text[] NOT NULL,
  alternatives jsonb NOT NULL,
  status text NOT NULL,
  invalidation_reasons text[] NOT NULL DEFAULT '{}',
  approved_alternative_id uuid,
  final_content_hash text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orch_plans_conversation_idx ON orch_plans(conversation_id,created_at DESC);
CREATE TABLE orch_confirmation_tasks (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL UNIQUE REFERENCES orch_plans(id),
  status text NOT NULL,
  reason_codes text[] NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  confirmed_content_hash text,
  confirmed_plan_version bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orch_send_tasks (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES orch_plans(id),
  reply_part_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  send_key text NOT NULL UNIQUE,
  content text NOT NULL CHECK (length(trim(content)) > 0),
  content_sha256 text NOT NULL CHECK (length(content_sha256) = 64),
  status text NOT NULL,
  receipt jsonb,
  correlation_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,sequence)
);
CREATE TABLE orch_owner_commands (
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  idempotency_key text NOT NULL,
  command_hash text NOT NULL,
  plan_id uuid NOT NULL REFERENCES orch_plans(id),
  result_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(contact_id,idempotency_key)
);
CREATE TABLE orch_control_commands (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  command_hash text NOT NULL,
  result_version bigint NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope,idempotency_key)
);
