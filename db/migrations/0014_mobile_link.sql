-- A separate owner-only store: imported phone evidence never enters platform inbox/outbox.
CREATE TABLE mobile_link_state (
  owner_id text PRIMARY KEY,
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
