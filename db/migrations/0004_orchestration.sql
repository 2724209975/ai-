-- 02-owned confirmation state, assigned global migration 0004 by architecture control.
-- Composite references keep 02 plan identity aligned with 03 enrollment and snapshots.
ALTER TABLE data_contacts ADD CONSTRAINT data_contacts_orch_scope_unique
  UNIQUE (id,conversation_id,platform_account_id,external_contact_ref);
ALTER TABLE data_messages ADD CONSTRAINT data_messages_orch_identity_unique
  UNIQUE (id,contact_id,conversation_id);
ALTER TABLE data_context_snapshots ADD CONSTRAINT data_snapshots_orch_identity_unique
  UNIQUE (id,contact_id,conversation_id,generation,policy_version);
CREATE TABLE orch_conversations (
  conversation_id text PRIMARY KEY REFERENCES dispatch_control(conversation_id),
  conversation_uuid uuid GENERATED ALWAYS AS (conversation_id::uuid) STORED,
  contact_id uuid NOT NULL UNIQUE REFERENCES data_contacts(id),
  account_id text NOT NULL,
  account_uuid uuid GENERATED ALWAYS AS (account_id::uuid) STORED,
  external_contact_ref text NOT NULL,
  policy jsonb NOT NULL,
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  generation bigint NOT NULL CHECK (generation > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('READY_CONFIRM','GENERATING','AWAITING_CONFIRMATION','SCHEDULED','PARTIALLY_SENT','PAUSED_GLOBAL','PAUSED_OWNER','PAUSED_STOP_REQUEST','PAUSED_MISSING_FACT','PAUSED_MEDIA','PAUSED_UNKNOWN_SEND','PAUSED_FAILURE')),
  pause_reasons text[] NOT NULL DEFAULT '{}',
  last_inbound_message_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,contact_id),
  FOREIGN KEY (contact_id,conversation_uuid,account_uuid,external_contact_ref)
    REFERENCES data_contacts(id,conversation_id,platform_account_id,external_contact_ref),
  FOREIGN KEY (last_inbound_message_id,contact_id,conversation_uuid)
    REFERENCES data_messages(id,contact_id,conversation_id)
);
CREATE TABLE orch_plans (
  id uuid PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES orch_conversations(conversation_id),
  conversation_uuid uuid GENERATED ALWAYS AS (conversation_id::uuid) STORED,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  context_snapshot_id uuid NOT NULL REFERENCES data_context_snapshots(id),
  generation bigint NOT NULL CHECK (generation > 0),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  dependency_epoch bigint NOT NULL CHECK (dependency_epoch >= 0),
  skill_epoch bigint NOT NULL CHECK (skill_epoch >= 0),
  trigger_message_ids uuid[] NOT NULL CHECK (cardinality(trigger_message_ids) > 0),
  fact_versions jsonb NOT NULL DEFAULT '{}',
  analysis_versions jsonb NOT NULL DEFAULT '{}',
  skill_versions jsonb NOT NULL DEFAULT '{}',
  risks text[] NOT NULL,
  alternatives jsonb NOT NULL CHECK (jsonb_typeof(alternatives) = 'array'),
  status text NOT NULL CHECK (status IN ('AWAITING_CONFIRMATION','APPROVED','PARTIALLY_SENT','SENT','RESULT_UNKNOWN','FAILED','INVALIDATED','REJECTED')),
  invalidation_reasons text[] NOT NULL DEFAULT '{}',
  approved_alternative_id uuid,
  final_content_hash text CHECK (final_content_hash IS NULL OR length(final_content_hash) = 64),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id,contact_id) REFERENCES orch_conversations(conversation_id,contact_id),
  FOREIGN KEY (context_snapshot_id,contact_id,conversation_uuid,generation,policy_version)
    REFERENCES data_context_snapshots(id,contact_id,conversation_id,generation,policy_version)
);
CREATE INDEX orch_plans_conversation_idx ON orch_plans(conversation_id,created_at DESC);
CREATE TABLE orch_confirmation_tasks (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL UNIQUE REFERENCES orch_plans(id),
  status text NOT NULL CHECK (status IN ('PENDING','RESOLVED','INVALIDATED','REJECTED')),
  reason_codes text[] NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  confirmed_content_hash text CHECK (confirmed_content_hash IS NULL OR length(confirmed_content_hash) = 64),
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
  status text NOT NULL CHECK (status IN ('CREATED','SUBMITTED','DELIVERED','FAILED_DEFINITE','RESULT_UNKNOWN','CANCELLED_PRE_SUBMIT')),
  receipt jsonb,
  correlation_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id,sequence)
);
CREATE TABLE orch_owner_commands (
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  command_hash text NOT NULL CHECK (length(command_hash) = 64),
  plan_id uuid NOT NULL REFERENCES orch_plans(id),
  result_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(contact_id,idempotency_key)
);
CREATE TABLE orch_control_commands (
  scope text NOT NULL CHECK (length(trim(scope)) > 0),
  idempotency_key text NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  command_hash text NOT NULL CHECK (length(command_hash) = 64),
  result_version bigint NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope,idempotency_key)
);
