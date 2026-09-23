-- Durable aggregation for 02: an inbound batch is persisted with its deadline so a worker restart
-- cannot lose or duplicate generation. Default window is 0 (immediate), so existing rows stay valid.
ALTER TABLE orch_conversations ADD COLUMN collection_started_at timestamptz;
ALTER TABLE orch_conversations ADD COLUMN collection_due_at timestamptz;
ALTER TABLE orch_conversations ADD COLUMN collection_message_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE orch_conversations ADD CONSTRAINT orch_conversations_collection_window_check
  CHECK (collection_due_at IS NULL OR (collection_started_at IS NOT NULL AND collection_due_at >= collection_started_at));
CREATE INDEX orch_conversations_due_idx ON orch_conversations (collection_due_at)
  WHERE collection_due_at IS NOT NULL;
