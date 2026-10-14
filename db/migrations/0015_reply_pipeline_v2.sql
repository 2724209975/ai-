-- Additive, opt-in journal. Existing inbox, message, plan and send tables remain authoritative.
ALTER TABLE orch_conversations ADD COLUMN pipeline_version smallint NOT NULL DEFAULT 1
  CHECK (pipeline_version IN (1,2));
ALTER TABLE orch_conversations ADD CONSTRAINT orch_conversations_reply_scope_unique
  UNIQUE (conversation_id,contact_id,account_id);
ALTER TABLE orch_plans ADD CONSTRAINT orch_plans_reply_scope_unique UNIQUE (id,conversation_id,contact_id);
ALTER TABLE data_context_snapshots ADD CONSTRAINT data_snapshots_reply_scope_unique UNIQUE (id,contact_id,conversation_id);
CREATE TABLE orch_reply_jobs (
  id uuid PRIMARY KEY,
  conversation_id text NOT NULL,
  conversation_uuid uuid GENERATED ALWAYS AS (conversation_id::uuid) STORED,
  contact_id uuid NOT NULL,
  account_id text NOT NULL,
  request_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  conversation_revision bigint NOT NULL CHECK (conversation_revision > 0),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  trigger_message_ids uuid[] NOT NULL CHECK (cardinality(trigger_message_ids) > 0),
  context_snapshot_id uuid,
  plan_id uuid UNIQUE,
  status text NOT NULL CHECK (status IN ('RECEIVED','BUFFERING','CONTEXT_READY','GENERATING','VALIDATING',
    'PENDING_APPROVAL','SEND_QUEUED','SENDING','SUBMITTED','SENT','UNCERTAIN','FAILED','STALE','SKIPPED','CANCELLED')),
  reason_code text,
  trace_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id,request_key),
  UNIQUE (id,conversation_id),
  FOREIGN KEY (conversation_id,contact_id,account_id)
    REFERENCES orch_conversations(conversation_id,contact_id,account_id),
  FOREIGN KEY (plan_id,conversation_id,contact_id)
    REFERENCES orch_plans(id,conversation_id,contact_id),
  FOREIGN KEY (context_snapshot_id,contact_id,conversation_uuid)
    REFERENCES data_context_snapshots(id,contact_id,conversation_id)
);
CREATE INDEX orch_reply_jobs_conversation_idx ON orch_reply_jobs(conversation_id,created_at DESC,id DESC);
ALTER TABLE orch_conversations ADD COLUMN current_reply_job_id uuid;
ALTER TABLE orch_conversations ADD CONSTRAINT orch_conversations_current_reply_job_fk
  FOREIGN KEY (current_reply_job_id,conversation_id) REFERENCES orch_reply_jobs(id,conversation_id);
CREATE TABLE orch_reply_job_transitions (
  job_id uuid NOT NULL REFERENCES orch_reply_jobs(id),
  version bigint NOT NULL,
  from_status text,
  to_status text NOT NULL,
  reason_code text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id,version)
);
