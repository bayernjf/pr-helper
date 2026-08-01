CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id bigserial PRIMARY KEY,
  trigger text NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron', 'webhook', 'inbox_refresh', 'manual')),
  state text NOT NULL CHECK (state IN ('running', 'success', 'failure')),
  stages_total integer NOT NULL DEFAULT 0,
  stages_reconciled integer NOT NULL DEFAULT 0,
  stages_failed integer NOT NULL DEFAULT 0,
  duration_ms integer,
  error_message text,
  repository text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_recent_idx
  ON reconciliation_runs (finished_at DESC NULLS LAST);
