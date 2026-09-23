-- Approved global RLS repair. Keep already applied 0002_data.sql immutable.
-- PostgreSQL can leave a transaction-local custom GUC as the empty string;
-- IS NOT NULL alone then permits global facts without a contact scope.
ALTER POLICY data_facts_scope ON data_facts
  USING (
    NULLIF(current_setting('app.contact_id', true), '') IS NOT NULL
    AND (scope = 'global' OR scope = current_setting('app.contact_id', true))
  )
  WITH CHECK (
    NULLIF(current_setting('app.contact_id', true), '') IS NOT NULL
    AND (scope = 'global' OR scope = current_setting('app.contact_id', true))
  );
