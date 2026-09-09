-- =====================================================
-- Migration 022: Add bounded retention cleanup telemetry
-- File: 022_data_retention.sql
-- Date: 2026-08-03 06:52
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Logs data-retention cleanup runs (state, per-scope deleted
--       counts, errors). Cleanup runs reuse the existing reconciliation
--       cron schedule.
-- -----------------------------------------------------

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
