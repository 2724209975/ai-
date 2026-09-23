-- G0 shared persistence. All mutable dispatch rows are owned by 02.
CREATE TABLE platform_inbox_raw (
  id uuid PRIMARY KEY,
  platform text NOT NULL CHECK (platform IN ('wechat', 'qq')),
  account_id text NOT NULL,
  conversation_id text NOT NULL,
  event_key text NOT NULL,
  payload_ref text NOT NULL,
  payload_sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id, conversation_id, event_key)
);
CREATE TABLE event_outbox (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  aggregate_id text NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version >= 0),
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX event_outbox_pending_idx ON event_outbox (created_at, id) WHERE published_at IS NULL;
CREATE TABLE event_inbox (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
CREATE TABLE dispatch_control (
  conversation_id text PRIMARY KEY,
  account_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  dependency_epoch bigint NOT NULL DEFAULT 0 CHECK (dependency_epoch >= 0),
  skill_epoch bigint NOT NULL DEFAULT 0 CHECK (skill_epoch >= 0),
  pause_epoch bigint NOT NULL DEFAULT 0 CHECK (pause_epoch >= 0),
  paused boolean NOT NULL DEFAULT true,
  unresolved_send_key text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispatch_global_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  pause_epoch bigint NOT NULL DEFAULT 0 CHECK (pause_epoch >= 0),
  paused boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dispatch_global_control (singleton) VALUES (true);
CREATE TABLE dispatch_attempts (
  send_task_id uuid PRIMARY KEY,
  plan_id uuid NOT NULL,
  conversation_id text NOT NULL REFERENCES dispatch_control(conversation_id),
  account_id text NOT NULL,
  send_key text NOT NULL UNIQUE,
  sequence integer NOT NULL CHECK (sequence > 0),
  mode text NOT NULL CHECK (mode = 'live'),
  content_sha256 text NOT NULL CHECK (length(content_sha256) = 64),
  expected_generation bigint NOT NULL,
  expected_policy_version bigint NOT NULL,
  expected_dependency_epoch bigint NOT NULL,
  expected_skill_epoch bigint NOT NULL,
  expected_pause_epoch bigint NOT NULL,
  expected_global_pause_epoch bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('SUBMITTING','SUBMITTED','DELIVERED','FAILED_DEFINITE','RESULT_UNKNOWN')),
  platform_message_id text,
  receipt_level text,
  evidence_ref text,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, sequence)
);
CREATE INDEX dispatch_attempts_unresolved_idx ON dispatch_attempts (conversation_id, updated_at)
  WHERE status IN ('SUBMITTING','RESULT_UNKNOWN');
CREATE TABLE dependency_epochs (
  contact_id text PRIMARY KEY,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
