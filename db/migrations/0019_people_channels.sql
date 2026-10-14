-- A person joins explicitly selected channels. Existing message/account scopes remain intact.
ALTER TABLE orch_platform_accounts DROP CONSTRAINT orch_platform_accounts_platform_check;
ALTER TABLE orch_platform_accounts ADD CONSTRAINT orch_platform_accounts_platform_check CHECK(platform IN ('qq','wechat','other'));
CREATE TABLE data_people (
 id uuid PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id)
);
CREATE TABLE data_person_channels (
 owner_id text NOT NULL, contact_id uuid NOT NULL REFERENCES data_contacts(id), person_id uuid NOT NULL,
 label text NOT NULL, account_label text NOT NULL DEFAULT '', peer_label text NOT NULL DEFAULT '',
 import_only boolean NOT NULL DEFAULT false, shared boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(owner_id,contact_id), FOREIGN KEY(owner_id,person_id) REFERENCES data_people(owner_id,id)
);
CREATE INDEX data_person_channels_person ON data_person_channels(owner_id,person_id);
CREATE TABLE data_history_imports (
 id uuid PRIMARY KEY, owner_id text NOT NULL, contact_id uuid NOT NULL, person_id uuid NOT NULL,
 person_version bigint NOT NULL, channel_version bigint NOT NULL, filename text NOT NULL, source_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('preview','committed')), rows jsonb NOT NULL,
 inserted integer, duplicates integer, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,contact_id) REFERENCES data_person_channels(owner_id,contact_id)
);
-- Batch provenance is kept independently of canonical messages (including repeated imports).
CREATE TABLE data_history_import_rows (
 owner_id text NOT NULL, import_id uuid NOT NULL REFERENCES data_history_imports(id), line integer NOT NULL,
 message_id uuid NOT NULL REFERENCES data_messages(id), source_details jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(import_id,line)
);
CREATE TABLE data_people_commands (
 owner_id text NOT NULL, key text NOT NULL, input_hash text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(owner_id,key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['data_people','data_person_channels','data_history_imports','data_history_import_rows','data_people_commands'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY people_owner ON %I USING(owner_id=current_setting(''app.people_owner_id'',true)) WITH CHECK(owner_id=current_setting(''app.people_owner_id'',true))',t);
 END LOOP;
END $$;
