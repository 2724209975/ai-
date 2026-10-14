-- Reuse facts/evidence and the existing synchronous dependency epoch boundary.
ALTER TABLE data_contacts ADD CONSTRAINT data_contacts_memory_scope UNIQUE(id,conversation_id,platform_account_id);
ALTER TABLE data_context_snapshots ADD COLUMN context_package_v2 jsonb;
ALTER TABLE data_facts ADD COLUMN memory_owner_id text;
ALTER TABLE data_facts ADD CONSTRAINT data_facts_memory_owner UNIQUE(id,memory_owner_id);
ALTER TABLE data_facts DROP CONSTRAINT data_facts_source_category_check;
ALTER TABLE data_facts ADD CONSTRAINT data_facts_source_category_check CHECK(source_category IN ('owner-confirmed','owner-message-candidate','model-inference','explicit-statement','imported-unverified'));
CREATE TABLE data_memory_items (
  id uuid PRIMARY KEY REFERENCES data_facts(id),
  owner_id text NOT NULL,
  contact_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  account_id uuid NOT NULL,
  memory_type text NOT NULL CHECK(memory_type IN ('fact','preference','boundary','episode','promise','relationship_event','temporary_state')),
  predicate text NOT NULL,
  object_value text NOT NULL,
  evidence_type text NOT NULL CHECK(evidence_type IN ('explicit_statement','user_confirmed','inferred','imported_unverified')),
  confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  importance double precision NOT NULL CHECK(importance BETWEEN 0 AND 1),
  status text NOT NULL CHECK(status IN ('pending','active','superseded','expired','deleted')),
  normalized_key text NOT NULL,
  conflict_key text,
  locked boolean NOT NULL DEFAULT false,
  supersedes_id uuid REFERENCES data_memory_items(id),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,owner_id,contact_id),
  FOREIGN KEY(id,owner_id) REFERENCES data_facts(id,memory_owner_id),
  FOREIGN KEY(contact_id,conversation_id,account_id) REFERENCES data_contacts(id,conversation_id,platform_account_id)
);
CREATE UNIQUE INDEX data_memory_dedupe ON data_memory_items(owner_id,contact_id,normalized_key) WHERE status IN ('pending','active');
CREATE INDEX data_memory_scope ON data_memory_items(owner_id,contact_id,status);
CREATE TABLE data_memory_embeddings (
  memory_id uuid PRIMARY KEY REFERENCES data_memory_items(id),
  owner_id text NOT NULL,contact_id uuid NOT NULL,
  fact_version bigint NOT NULL,
  model_id text NOT NULL,dimensions integer NOT NULL CHECK(dimensions BETWEEN 1 AND 16000),
  embedding real[] NOT NULL,CHECK(cardinality(embedding)=dimensions),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(memory_id,owner_id,contact_id) REFERENCES data_memory_items(id,owner_id,contact_id)
);
-- array storage keeps migration compatible with installations without pgvector.
-- The optional extension uses the same rows via vector casts; no duplicate cache.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_available_extensions WHERE name='vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
  END IF;
END $$;
CREATE TABLE data_memory_tasks (
  id uuid PRIMARY KEY,owner_id text NOT NULL,contact_id uuid NOT NULL REFERENCES data_contacts(id),
  message_id uuid NOT NULL REFERENCES data_messages(id),message_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','DONE','FAILED')),
  attempts integer NOT NULL DEFAULT 0,lease_until timestamptz,retry_after timestamptz,error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,contact_id,message_id,message_version)
);
CREATE TABLE data_conversation_summaries (
  id uuid PRIMARY KEY,owner_id text NOT NULL,contact_id uuid NOT NULL REFERENCES data_contacts(id),
  conversation_id uuid NOT NULL,account_id uuid NOT NULL,
  previous_id uuid REFERENCES data_conversation_summaries(id),
  source_refs jsonb NOT NULL,from_message_id uuid NOT NULL,to_message_id uuid NOT NULL,
  content text, pending_topics jsonb NOT NULL,
  generator_version text NOT NULL,status text NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','invalid')),
  version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(contact_id,conversation_id,account_id) REFERENCES data_contacts(id,conversation_id,platform_account_id)
);
CREATE INDEX data_summary_current ON data_conversation_summaries(owner_id,contact_id,created_at DESC);
CREATE TABLE data_relationship_states (
  owner_id text NOT NULL,contact_id uuid NOT NULL REFERENCES data_contacts(id),
  confirmed_stage text NOT NULL DEFAULT 'unknown' CHECK(confirmed_stage IN ('unknown','stranger','familiar','getting_to_know','dating')),
  inferred_hint text, inferred_until timestamptz,locked boolean NOT NULL DEFAULT false,
  source_refs jsonb NOT NULL DEFAULT '[]',version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,contact_id)
);
CREATE TABLE data_style_profiles (
  id uuid PRIMARY KEY,owner_id text NOT NULL,contact_id uuid REFERENCES data_contacts(id),
  settings jsonb NOT NULL DEFAULT '{}',statistics jsonb,examples jsonb NOT NULL DEFAULT '[]',source_refs jsonb NOT NULL DEFAULT '[]',delivered_edit_refs jsonb NOT NULL DEFAULT '[]',
  locked boolean NOT NULL DEFAULT false,version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT(owner_id,contact_id)
);
CREATE TABLE data_memory_commands (
  owner_id text NOT NULL,scope text NOT NULL,idempotency_key text NOT NULL,command_hash text NOT NULL,
  result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,scope,idempotency_key)
);
CREATE TABLE data_memory_controls (
  owner_id text NOT NULL,contact_id uuid NOT NULL REFERENCES data_contacts(id),enabled boolean NOT NULL DEFAULT true,
  style_samples boolean NOT NULL DEFAULT true,retention_days integer NOT NULL DEFAULT 90 CHECK(retention_days BETWEEN 1 AND 3650),
  version bigint NOT NULL DEFAULT 1,PRIMARY KEY(owner_id,contact_id)
);
-- A tombstoned/corrected source synchronously purges searchable derivatives.
CREATE FUNCTION data_scrub_memory_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.version=NEW.version AND OLD.deletion_status=NEW.deletion_status THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM data_style_profiles WHERE contact_id IS NULL AND source_refs @> jsonb_build_array(jsonb_build_object('id',NEW.id::text))) THEN
    UPDATE data_context_snapshots SET context_package_v2=NULL,status='invalid' WHERE context_package_v2 IS NOT NULL;
  END IF;
  UPDATE data_conversation_summaries SET status='invalid',content=NULL,pending_topics='[]',version=version+1
    WHERE status='valid' AND source_refs @> jsonb_build_array(jsonb_build_object('id',NEW.id::text));
  UPDATE data_relationship_states SET confirmed_stage='unknown',inferred_hint=NULL,inferred_until=NULL,source_refs='[]',version=version+1
    WHERE source_refs @> jsonb_build_array(jsonb_build_object('id',NEW.id::text));
  UPDATE data_style_profiles SET statistics=NULL,examples='[]',source_refs='[]',version=version+1
    WHERE source_refs @> jsonb_build_array(jsonb_build_object('id',NEW.id::text));
  UPDATE data_memory_commands SET result=jsonb_build_object('id',result->>'id','status','stale')
    WHERE result->'sourceRefs' @> jsonb_build_array(jsonb_build_object('id',NEW.id::text))
       OR result->'evidenceRefs' @> jsonb_build_array(jsonb_build_object('id',NEW.id::text));
  DELETE FROM data_memory_embeddings WHERE memory_id IN
    (SELECT owner_id FROM data_evidence WHERE owner_kind='fact' AND source_kind='message' AND source_id=NEW.id);
  UPDATE data_context_snapshots SET context_package_v2=NULL,status='invalid'
    WHERE contact_id=NEW.contact_id AND context_package_v2 IS NOT NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER data_message_memory_v2 AFTER UPDATE ON data_messages FOR EACH ROW EXECUTE FUNCTION data_scrub_memory_v2();
ALTER FUNCTION data_scrub_memory_v2() SECURITY DEFINER;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.data_scrub_memory_v2() SET search_path TO %I,pg_temp',current_schema(),current_schema());
END $$;
CREATE FUNCTION data_scrub_fact_memory_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.version<>NEW.version OR OLD.deletion_status<>NEW.deletion_status THEN
    DELETE FROM data_memory_embeddings WHERE memory_id=NEW.id;
    IF NEW.deletion_status='deleted' THEN
      UPDATE data_memory_items SET status='deleted',object_value='',predicate='',updated_at=now() WHERE id=NEW.id;
      UPDATE data_memory_commands SET result=jsonb_build_object('id',NEW.id::text,'status','deleted','version',NEW.version) WHERE result->>'id'=NEW.id::text;
    END IF;
    UPDATE data_context_snapshots SET context_package_v2=NULL,status='invalid'
      WHERE context_package_v2 IS NOT NULL AND (contact_id::text=NEW.scope OR NEW.scope='global');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_fact_memory_v2 AFTER UPDATE ON data_facts FOR EACH ROW EXECUTE FUNCTION data_scrub_fact_memory_v2();
ALTER FUNCTION data_scrub_fact_memory_v2() SECURITY DEFINER;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.data_scrub_fact_memory_v2() SET search_path TO %I,pg_temp',current_schema(),current_schema());
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['data_memory_items','data_memory_embeddings','data_memory_tasks','data_conversation_summaries','data_relationship_states','data_memory_controls'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY memory_scope ON %I USING(owner_id=current_setting(''app.memory_owner_id'',true) AND contact_id::text=current_setting(''app.contact_id'',true)) WITH CHECK(owner_id=current_setting(''app.memory_owner_id'',true) AND contact_id::text=current_setting(''app.contact_id'',true))',table_name);
  END LOOP;
END $$;
ALTER TABLE data_style_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_style_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY style_scope ON data_style_profiles USING(owner_id=current_setting('app.memory_owner_id',true) AND (contact_id IS NULL OR contact_id::text=current_setting('app.contact_id',true)))
 WITH CHECK(owner_id=current_setting('app.memory_owner_id',true) AND (contact_id IS NULL OR contact_id::text=current_setting('app.contact_id',true)));
ALTER TABLE data_memory_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_memory_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_command_owner ON data_memory_commands USING(owner_id=current_setting('app.memory_owner_id',true)) WITH CHECK(owner_id=current_setting('app.memory_owner_id',true));
