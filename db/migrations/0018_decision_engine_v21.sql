-- Additive extension: existing decisions, candidates, memories and send records are untouched.
ALTER TABLE orch_reply_jobs ADD COLUMN shadow_decision_record jsonb;
ALTER TABLE ai_model_calls_v2 DROP CONSTRAINT ai_model_calls_v2_task_check;
ALTER TABLE ai_model_calls_v2 ADD CONSTRAINT ai_model_calls_v2_task_check CHECK(task IN ('decision','generation','analysis'));
-- Deep analysis can quote source memories. Reuse MemoryEngine's synchronous source scrubbing.
CREATE FUNCTION data_scrub_decision_v21() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.context_package_v2 IS NOT NULL AND NEW.context_package_v2 IS NULL THEN
    UPDATE orch_reply_jobs SET
      decision_record=CASE WHEN decision_record->>'schema_version'='2.1' THEN NULL ELSE decision_record END,
      route_record=CASE WHEN route_record ? 'engineV21' THEN NULL ELSE route_record END,
      shadow_decision_record=NULL
    WHERE context_snapshot_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER data_snapshot_decision_v21 AFTER UPDATE ON data_context_snapshots FOR EACH ROW EXECUTE FUNCTION data_scrub_decision_v21();
ALTER FUNCTION data_scrub_decision_v21() SECURITY DEFINER;
DO $$ BEGIN
  EXECUTE format('ALTER FUNCTION %I.data_scrub_decision_v21() SET search_path TO %I,pg_temp',current_schema(),current_schema());
END $$;
