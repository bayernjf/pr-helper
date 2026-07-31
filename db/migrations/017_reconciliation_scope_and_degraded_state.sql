-- 017: Scope reconciliation telemetry and webhook counts to a GitHub user.
-- Run after 014. Existing rows remain readable but are treated as legacy/global data.

ALTER TABLE reconciliation_runs
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES pr_helper_users(id) ON DELETE CASCADE;

ALTER TABLE reconciliation_runs
  DROP CONSTRAINT IF EXISTS reconciliation_runs_state_check;

ALTER TABLE reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_state_check
  CHECK (state IN ('running', 'success', 'degraded', 'failure'));

CREATE INDEX IF NOT EXISTS reconciliation_runs_user_recent_idx
  ON reconciliation_runs (user_id, finished_at DESC NULLS LAST, started_at DESC);

ALTER TABLE github_webhook_deliveries
  ADD COLUMN IF NOT EXISTS installation_id text;

CREATE INDEX IF NOT EXISTS github_webhook_deliveries_installation_recent_idx
  ON github_webhook_deliveries (installation_id, received_at DESC);
