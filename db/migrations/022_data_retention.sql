-- 022: Bounded retention cleanup telemetry. Cleanup runs use existing reconciliation cron.

CREATE TABLE IF NOT EXISTS data_retention_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'success', 'degraded', 'failure')),
  deleted_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS data_retention_runs_recent_idx
  ON data_retention_runs (started_at DESC);
