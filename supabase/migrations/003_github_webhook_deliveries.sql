-- =====================================================
-- Migration 003: Add GitHub webhook delivery log table
-- File: 003_github_webhook_deliveries.sql
-- Date: 2026-07-27 04:31
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Records every GitHub webhook delivery received (delivery id,
--       event name, action, repository and received time) so ingest
--       can be audited and replayed.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  event_name text NOT NULL,
  action text,
  repository text,
  received_at timestamptz NOT NULL DEFAULT now()
);
