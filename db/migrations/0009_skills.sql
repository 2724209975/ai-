-- 05-owned Skill storage (A18). Revised after the 2026-09-24 review: the contact-scoped tables now
-- force RLS with policies for every command, so a restricted runtime role can write inside its own
-- scope instead of only working when the process happens to run as a superuser.
CREATE TABLE skills_current (
  skill_id uuid PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('built_in','custom')),
  current_version bigint NOT NULL CHECK (current_version > 0),
  status text NOT NULL CHECK (status IN ('active','disabled','deleted')),
  -- Only global definitions live here for now; contact-private Skills need their own scoped design
  -- and a separate proposal, otherwise a future join could leak definitions across contacts.
  visibility_scope text NOT NULL CHECK (visibility_scope = 'global'),
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
-- Deferred on purpose: the first version row may be inserted in the same transaction as its
-- skills_current row, but a store that writes outside a transaction fails with 23503.
ALTER TABLE skills_current ADD CONSTRAINT skills_current_version_fk
  FOREIGN KEY (skill_id,current_version) REFERENCES skills_versions(skill_id,version)
  DEFERRABLE INITIALLY DEFERRED;
-- Immutable historical rows. Status changes create another version row.
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
CREATE INDEX skills_grants_eligible_idx ON skills_grants(contact_id,skill_id) WHERE enabled;

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

-- Contact-scoped tables use the 0002_data.sql shape: USING plus WITH CHECK for every command, and
-- FORCE so the table owner cannot silently bypass the scope. Known gap: skills_current,
-- skills_versions and skills_command_receipts are global and carry no RLS, so today the runtime
-- role could write them; owner-only write separation needs a dedicated role and its own proposal.
ALTER TABLE skills_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY skills_grants_contact ON skills_grants
  USING (contact_id::text = current_setting('app.contact_id', true))
  WITH CHECK (contact_id::text = current_setting('app.contact_id', true));
ALTER TABLE skills_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY skills_invocations_contact ON skills_invocations
  USING (contact_id::text = current_setting('app.contact_id', true))
  WITH CHECK (contact_id::text = current_setting('app.contact_id', true));
