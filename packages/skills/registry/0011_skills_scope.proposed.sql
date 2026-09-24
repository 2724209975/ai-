-- 05 proposal only. Architecture owns the eventual global migration number and role grants.
-- Apply after 0009. This file is not loaded by applyMigrations.
-- A deployment must first separate the authenticated owner writer from the restricted runtime
-- reader: runtime may SELECT current/versions through RLS, but must have no write permission
-- on them and no permission at all on skills_command_receipts. Neither role may BYPASSRLS.

ALTER TABLE skills_current DROP CONSTRAINT skills_current_visibility_scope_check;
ALTER TABLE skills_current ADD CONSTRAINT skills_current_visibility_scope_check
  CHECK (visibility_scope = 'global' OR visibility_scope ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
ALTER TABLE skills_versions ADD CONSTRAINT skills_versions_visibility_scope_check
  CHECK (definition->>'visibilityScope' = 'global' OR definition->>'visibilityScope' ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- The historical definition owns its own immutable scope. Never infer an old version's
-- visibility from skills_current: a later edit may change the current scope.
ALTER TABLE skills_current ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_current_runtime_read ON skills_current FOR SELECT
  USING (NULLIF(current_setting('app.contact_id', true), '') IS NOT NULL
    AND (visibility_scope = 'global' OR visibility_scope = current_setting('app.contact_id', true)));
ALTER TABLE skills_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY skills_versions_runtime_read ON skills_versions FOR SELECT
  USING (NULLIF(current_setting('app.contact_id', true), '') IS NOT NULL
    AND (definition->>'visibilityScope' = 'global'
      OR definition->>'visibilityScope' = current_setting('app.contact_id', true)));

-- Deliberately no FORCE here: the authenticated owner writer must be the table owner and
-- can create/edit versions without a contact scope. The runtime role must be a distinct,
-- non-owner, non-BYPASSRLS role. Its SELECT grants and explicit absence of write/receipt
-- grants belong to the deployment role bootstrap; test that bootstrap with direct SQL.
REVOKE ALL ON skills_current, skills_versions, skills_command_receipts FROM PUBLIC;
