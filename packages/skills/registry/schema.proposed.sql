-- 05 PROPOSAL ONLY. Architecture control assigns the next global migration number.
-- Apply only after contract/event payload review. 05 never owns SendTask or platform credentials.
CREATE TABLE skills_current (
  skill_id uuid PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('built_in','custom')),
  current_version bigint NOT NULL CHECK (current_version > 0),
  status text NOT NULL CHECK (status IN ('active','disabled','deleted')),
  visibility_scope text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE skills_versions (
  skill_id uuid NOT NULL REFERENCES skills_current(skill_id),
  version bigint NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('active','disabled','deleted')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (skill_id,version),
  CHECK (definition->>'skillId' = skill_id::text),
  CHECK ((definition->>'version')::bigint = version),
  CHECK (definition->>'status' = status)
);
ALTER TABLE skills_current ADD CONSTRAINT skills_current_version_fk
  FOREIGN KEY (skill_id,current_version) REFERENCES skills_versions(skill_id,version)
  DEFERRABLE INITIALLY DEFERRED;
-- Immutable historical rows. Status changes create another row/version.
CREATE FUNCTION skills_forbid_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_SKILL_VERSION'; END $$;
CREATE TRIGGER skills_versions_immutable BEFORE UPDATE OR DELETE ON skills_versions
  FOR EACH ROW EXECUTE FUNCTION skills_forbid_version_mutation();

CREATE TABLE skills_grants (
  id uuid NOT NULL UNIQUE,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  skill_id uuid NOT NULL REFERENCES skills_current(skill_id),
  min_version bigint NOT NULL CHECK (min_version > 0),
  max_version bigint NOT NULL CHECK (max_version >= min_version),
  version bigint NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (contact_id,skill_id)
);
CREATE INDEX skills_grants_eligible_idx ON skills_grants(contact_id,skill_id)
  WHERE enabled;

CREATE TABLE skills_invocations (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  stage text NOT NULL CHECK (stage IN ('analysis','strategy','expression')),
  skill_id uuid,
  skill_version bigint,
  skill_epoch bigint NOT NULL CHECK (skill_epoch >= 0),
  selection_mode text NOT NULL CHECK (selection_mode IN ('automatic','manual','base')),
  reason text NOT NULL,
  input_refs jsonb NOT NULL,
  output jsonb,
  status text NOT NULL CHECK (status IN ('suggested','fallback','manual_required')),
  fallback_reason text,
  adopted boolean,
  created_at timestamptz NOT NULL,
  CHECK ((skill_id IS NULL) = (skill_version IS NULL)),
  FOREIGN KEY (skill_id,skill_version) REFERENCES skills_versions(skill_id,version)
);
CREATE INDEX skills_invocations_contact_task_idx ON skills_invocations(contact_id,task_id,created_at);

-- Owner command replay guard. A duplicate command with a different request hash is rejected.
CREATE TABLE skills_command_receipts (
  command_id text PRIMARY KEY,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Contact-scoped runtime role must SET LOCAL app.contact_id. Owner management uses
-- a separate authenticated role/port and must not accept browser-supplied callerContactId.
ALTER TABLE skills_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_grants_contact_read ON skills_grants FOR SELECT
  USING (contact_id::text = current_setting('app.contact_id',true));
ALTER TABLE skills_invocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_invocations_contact_read ON skills_invocations FOR SELECT
  USING (contact_id::text = current_setting('app.contact_id',true));
-- Architecture control must assign table-owner writes only to the trusted owner
-- service role; runtime role receives SELECT only and is subject to these policies.
