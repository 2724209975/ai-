-- 03-owned append-only audit for platform recalls/edits (A19). References and status only:
-- no message body, no media bytes, no platform token. A D09 edit正文 is never stored or guessed.
CREATE TABLE data_platform_message_mutations (
  id uuid PRIMARY KEY,
  contact_id uuid NOT NULL REFERENCES data_contacts(id),
  conversation_id uuid NOT NULL,
  platform_account_id uuid NOT NULL,
  platform_message_id text NOT NULL,
  platform_event_id text NOT NULL,
  message_id uuid REFERENCES data_messages(id),
  mutation text NOT NULL CHECK (mutation IN ('recall','edit')),
  raw_event_ref text NOT NULL,
  received_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('applied','unmatched')),
  old_version bigint CHECK (old_version IS NULL OR old_version > 0),
  new_version bigint CHECK (new_version IS NULL OR new_version > 0),
  created_at timestamptz NOT NULL,
  -- Replay of the same platform event must be recognised, not applied twice.
  UNIQUE (platform_account_id, conversation_id, platform_event_id),
  -- A repeat mutation on an already tombstoned message still records the audit row without
  -- reviving content, so new_version may equal old_version; it may never go backwards.
  CHECK (status <> 'applied' OR (message_id IS NOT NULL AND old_version IS NOT NULL AND new_version IS NOT NULL AND new_version >= old_version)),
  CHECK (status <> 'unmatched' OR (message_id IS NULL AND old_version IS NULL AND new_version IS NULL))
);
CREATE INDEX data_platform_message_mutations_message_idx
  ON data_platform_message_mutations (contact_id, message_id);

-- Same shape as 0002_data.sql: policies cover every command so a restricted runtime role can write
-- inside its own contact scope, and FORCE keeps the table owner from silently bypassing scope.
ALTER TABLE data_platform_message_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_platform_message_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY data_platform_message_mutations_scope ON data_platform_message_mutations
  USING (contact_id::text = current_setting('app.contact_id', true))
  WITH CHECK (contact_id::text = current_setting('app.contact_id', true));
