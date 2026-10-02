-- P2-3: passive generation provenance; existing plans remain unknown, not backfilled.
ALTER TABLE orch_plans ADD COLUMN generator_version text;
ALTER TABLE orch_plans ADD COLUMN prompt_version text;
