-- P2-4: 02-owned account safety latch and bridge probe projection.
CREATE TABLE orch_account_health (
  account_id text PRIMARY KEY,
  healthy boolean NOT NULL DEFAULT false,
  fault_code text CHECK (fault_code IN ('BRIDGE_RESTARTED','PROCESS_EXITED','HOOK_LOGIN_ABNORMAL','HELPER_UNRESPONSIVE')),
  version bigint NOT NULL DEFAULT 1,
  observed_at timestamptz NOT NULL DEFAULT now()
);
