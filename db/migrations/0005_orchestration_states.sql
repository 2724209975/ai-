-- Align the persisted conversation state vocabulary with docs/contracts.md §5 (02-owned states).
-- 0004 shipped the confirm-only subset; this migration only widens the allowed values, so every
-- row accepted by 0004 remains valid. No data rewrite is required.
ALTER TABLE orch_conversations DROP CONSTRAINT orch_conversations_state_check;
ALTER TABLE orch_conversations ADD CONSTRAINT orch_conversations_state_check CHECK (state IN (
  'DISABLED','READY_CONFIRM','READY_AUTO','COLLECTING','GENERATING','AWAITING_CONFIRMATION',
  'SCHEDULED','DISPATCHING','PAUSED_GLOBAL','PAUSED_OWNER','PAUSED_POLICY','PAUSED_MISSING_FACT',
  'PAUSED_MEDIA','PAUSED_FAILURE','PAUSED_STOP_REQUEST','PAUSED_UNKNOWN_SEND'
));
