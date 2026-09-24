-- 02-owned, mock-only AC04 approval evidence. No owner confirmation is implied.
CREATE TABLE orch_mock_auto_approvals (
  plan_id uuid PRIMARY KEY REFERENCES orch_plans(id),
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  generation bigint NOT NULL CHECK (generation > 0),
  dependency_epoch bigint NOT NULL CHECK (dependency_epoch >= 0),
  skill_epoch bigint NOT NULL CHECK (skill_epoch >= 0),
  reason text NOT NULL CHECK (reason = 'LOW_RISK_TEXT'),
  created_at timestamptz NOT NULL DEFAULT now()
);
