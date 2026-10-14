ALTER TABLE orch_reply_jobs DROP CONSTRAINT orch_reply_jobs_status_check;
ALTER TABLE orch_reply_jobs ADD CONSTRAINT orch_reply_jobs_status_check CHECK (status IN
  ('RECEIVED','BUFFERING','CONTEXT_READY','DECIDING','GENERATING','VALIDATING','PENDING_APPROVAL','SEND_QUEUED','SENDING','SUBMITTED','SENT','UNCERTAIN','FAILED','STALE','SKIPPED','CANCELLED'));
ALTER TABLE orch_reply_jobs ADD COLUMN decision_record jsonb;
ALTER TABLE orch_reply_jobs ADD COLUMN route_record jsonb;
ALTER TABLE orch_reply_jobs ADD COLUMN quality_results jsonb NOT NULL DEFAULT '[]';
ALTER TABLE orch_reply_jobs ADD CONSTRAINT orch_reply_jobs_model_scope_unique UNIQUE(id,conversation_id,contact_id);
CREATE TABLE ai_model_configs_v2 (
  owner_id text PRIMARY KEY, version bigint NOT NULL CHECK(version>0), config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_model_commands_v2 (
  owner_id text NOT NULL, idempotency_key text NOT NULL, command_hash text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,idempotency_key)
);
CREATE TABLE ai_model_calls_v2 (
  id uuid PRIMARY KEY, owner_id text NOT NULL, job_id uuid NOT NULL REFERENCES orch_reply_jobs(id),
  conversation_id text NOT NULL, contact_id uuid NOT NULL,
  conversation_uuid uuid GENERATED ALWAYS AS(conversation_id::uuid) STORED,
  context_snapshot_id uuid NOT NULL REFERENCES data_context_snapshots(id), config_version bigint NOT NULL,
  task text NOT NULL CHECK(task IN ('decision','generation')), provider_key text NOT NULL, provider_id text NOT NULL,
  model_id text NOT NULL, model_version text NOT NULL, prompt_version text NOT NULL, route_reason text NOT NULL,
  data_region text NOT NULL, retention_policy text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, elapsed_ms double precision, outcome text NOT NULL CHECK(outcome IN ('running','ok','error','timeout')),
  error_code text, input_tokens bigint, output_tokens bigint, reasoning_tokens bigint, cached_input_tokens bigint,
  reserved_tokens bigint NOT NULL CHECK(reserved_tokens>=0), price_snapshot jsonb, cost numeric,
  CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0),
  CHECK(reasoning_tokens IS NULL OR reasoning_tokens>=0), CHECK(cached_input_tokens IS NULL OR cached_input_tokens>=0),
  FOREIGN KEY(job_id,conversation_id,contact_id) REFERENCES orch_reply_jobs(id,conversation_id,contact_id),
  FOREIGN KEY(context_snapshot_id,contact_id,conversation_uuid) REFERENCES data_context_snapshots(id,contact_id,conversation_id)
);
CREATE INDEX ai_model_calls_v2_usage_idx ON ai_model_calls_v2(owner_id,started_at DESC);
-- These are owner-scoped records, not a second execution queue. No prompt, response or credential is stored.
ALTER TABLE ai_model_configs_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_model_configs_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY model_configs_owner ON ai_model_configs_v2 USING(owner_id=current_setting('app.memory_owner_id',true)) WITH CHECK(owner_id=current_setting('app.memory_owner_id',true));
ALTER TABLE ai_model_commands_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_model_commands_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY model_commands_owner ON ai_model_commands_v2 USING(owner_id=current_setting('app.memory_owner_id',true)) WITH CHECK(owner_id=current_setting('app.memory_owner_id',true));
ALTER TABLE ai_model_calls_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_model_calls_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY model_calls_owner ON ai_model_calls_v2 USING(owner_id=current_setting('app.memory_owner_id',true)) WITH CHECK(owner_id=current_setting('app.memory_owner_id',true));
