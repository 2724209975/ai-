CREATE TABLE orch_platform_accounts (
  account_id text PRIMARY KEY,
  platform text CHECK (platform IN ('qq','wechat')),
  mapping_status text NOT NULL CHECK (mapping_status IN ('verified','conflict')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mapping_status='verified' AND platform IS NOT NULL) OR (mapping_status='conflict' AND platform IS NULL))
);
INSERT INTO orch_platform_accounts(account_id,platform,mapping_status)
SELECT account_id, CASE WHEN count(DISTINCT platform)=1 THEN min(platform) END,
  CASE WHEN count(DISTINCT platform)=1 THEN 'verified' ELSE 'conflict' END
FROM platform_inbox_raw GROUP BY account_id;
CREATE INDEX orch_conversations_account_collection_idx ON orch_conversations(account_id,collection_due_at) WHERE state='COLLECTING';
CREATE INDEX data_messages_contact_history_idx ON data_messages(contact_id,sent_at DESC,id DESC) WHERE deletion_status='active';
ALTER TABLE orch_control_commands ADD COLUMN result_details jsonb;
ALTER TABLE orch_send_tasks ADD COLUMN created_at timestamptz;
UPDATE orch_send_tasks s SET created_at=p.created_at FROM orch_plans p WHERE p.id=s.plan_id;
ALTER TABLE orch_send_tasks ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE orch_send_tasks ALTER COLUMN created_at SET NOT NULL;
