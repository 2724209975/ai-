-- 03-owned PostgreSQL migration body. Total control must assign the global
-- migration number and approve shared contact/event ownership before applying.
-- This file is intentionally not an independently runnable migration.
CREATE TABLE data_contacts (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL UNIQUE,
  platform_account_id uuid NOT NULL,
  external_contact_ref text NOT NULL,
  display_name text NOT NULL,
  enrollment_status text NOT NULL CHECK (enrollment_status IN ('enrolled','discovered')),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (platform_account_id, external_contact_ref)
);
CREATE TABLE data_messages (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  conversation_id uuid NOT NULL REFERENCES data_contacts(conversation_id),
  platform_account_id uuid NOT NULL,
  platform_message_id text NOT NULL,
  platform_event_id text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('owner','contact','agent','system','platform','unknown')),
  type text NOT NULL CHECK (type IN ('text','image','voice','sticker_static','sticker_animated','unsupported')),
  content_ref text,
  media_id uuid,
  quoted_message_id uuid,
  sent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  provenance jsonb NOT NULL,
  is_agent_generated boolean NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live','import','trial','replay')),
  version bigint NOT NULL CHECK (version > 0),
  deletion_status text NOT NULL CHECK (deletion_status IN ('active','deleted')),
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (is_agent_generated = (actor = 'agent')),
  UNIQUE (mode, platform_account_id, conversation_id, platform_message_id),
  UNIQUE (mode, platform_account_id, conversation_id, platform_event_id)
);
CREATE INDEX data_messages_context_idx ON data_messages
  (contact_id, mode, sent_at, platform_event_id, platform_message_id, id)
  WHERE deletion_status = 'active';
CREATE TABLE data_facts (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  scope text NOT NULL,
  content text,
  source_category text NOT NULL CHECK (source_category IN ('owner-confirmed','owner-message-candidate','model-inference')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  confirmation_status text NOT NULL CHECK (confirmation_status IN ('candidate','confirmed')),
  deletion_status text NOT NULL CHECK (deletion_status IN ('active','deleted')),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (valid_until IS NULL OR valid_until > valid_from),
  CHECK (deletion_status <> 'deleted' OR content IS NULL)
);
CREATE INDEX data_facts_scope_idx ON data_facts (scope, valid_from, valid_until)
  WHERE confirmation_status = 'confirmed' AND deletion_status = 'active';
CREATE TABLE data_evidence (
  owner_kind text NOT NULL CHECK (owner_kind IN ('fact','analysis','interpretation','summary')),
  owner_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('message','fact','media','analysis')),
  source_id uuid NOT NULL,
  source_version bigint NOT NULL,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  PRIMARY KEY (owner_kind, owner_id, source_kind, source_id)
);
CREATE INDEX data_evidence_source_idx ON data_evidence (source_kind, source_id, contact_id);
CREATE TABLE data_analyses (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  analysis_version text NOT NULL,
  cutoff timestamptz NOT NULL,
  sample_range jsonb NOT NULL,
  claims jsonb NOT NULL,
  stage_hypotheses jsonb NOT NULL,
  trend jsonb,
  supporting_evidence jsonb NOT NULL,
  counter_evidence jsonb NOT NULL,
  uncertainty jsonb NOT NULL,
  corrections jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('valid','invalid')),
  version bigint NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX data_analyses_contact_idx ON data_analyses (contact_id, cutoff DESC)
  WHERE status = 'valid';
CREATE TABLE data_context_snapshots (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  generation bigint NOT NULL,
  cutoff_message_id uuid,
  cutoff_time timestamptz NOT NULL,
  message_refs jsonb NOT NULL,
  summary_refs jsonb NOT NULL,
  fact_refs jsonb NOT NULL,
  analysis_refs jsonb NOT NULL,
  policy_version bigint NOT NULL,
  hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('valid','invalid')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX data_snapshot_contact_idx ON data_context_snapshots (contact_id, status);
CREATE TABLE data_media_assets (
  id uuid PRIMARY KEY,
  message_id uuid REFERENCES data_messages(id),
  contact_id uuid REFERENCES data_contacts(id),
  media_type text NOT NULL,
  storage_ref text,
  sha256 text,
  fetch_status text NOT NULL,
  completeness text NOT NULL CHECK (completeness IN ('complete','partial','unavailable','unknown')),
  interpretation_status text NOT NULL,
  platform_metadata jsonb NOT NULL,
  approval_status text NOT NULL,
  approval_version bigint NOT NULL,
  allowed_platforms text[] NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE data_import_jobs (
  id uuid PRIMARY KEY,
  format text NOT NULL,
  source_hash text NOT NULL,
  mode text NOT NULL DEFAULT 'import' CHECK (mode = 'import'),
  preview jsonb NOT NULL,
  identity_mapping jsonb,
  confirmed_scope jsonb,
  status text NOT NULL,
  error_report jsonb NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (format, source_hash)
);
CREATE TABLE data_feedback (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  plan_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  shown_alternative_ids uuid[] NOT NULL,
  action text NOT NULL,
  original_content jsonb,
  final_content jsonb,
  reason text,
  rating jsonb,
  source text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (contact_id, idempotency_key)
);
CREATE TABLE data_audit (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  target_version bigint,
  decision_summary text NOT NULL,
  source_refs jsonb NOT NULL,
  result text NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
