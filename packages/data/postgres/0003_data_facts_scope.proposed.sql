-- PROPOSAL ONLY: architecture control must allocate/approve global migration 0003.
-- Do not edit already applied db/migrations/0002_data.sql.
-- PostgreSQL 17.11 reproduced a global fact visible to a restricted role after
-- a transaction-local app.contact_id setting expired to the empty string.
ALTER POLICY data_facts_scope ON data_facts
  USING (
    NULLIF(current_setting('app.contact_id', true), '') IS NOT NULL
    AND (scope = 'global' OR scope = current_setting('app.contact_id', true))
  )
  WITH CHECK (
    NULLIF(current_setting('app.contact_id', true), '') IS NOT NULL
    AND (scope = 'global' OR scope = current_setting('app.contact_id', true))
  );
