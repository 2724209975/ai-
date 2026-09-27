-- Keep a durable reminder for distinct live contact messages received while paused.
ALTER TABLE orch_conversations
  ADD COLUMN paused_inbound_unreviewed_count bigint NOT NULL DEFAULT 0
    CHECK (paused_inbound_unreviewed_count >= 0);
