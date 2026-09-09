-- =====================================================
-- Migration 029: Record GitHub quota spend per reconciliation sweep
-- File: 029_reconciliation_github_call_cost.sql
-- Date: 2026-08-15 07:14
-- Depends on: 028_reconciliation_leases_and_pending.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Stores GitHub call counts and millis next to stage counts so
--       quota burn (a flat 5,000 requests/hour per installation) is
--       answerable in SQL instead of sampled platform logs.
-- -----------------------------------------------------

-- 029: Record what a reconciliation sweep spent against the GitHub installation quota.
-- Run after 028.
-- The installation quota for an App on a personal account is a flat 5,000 requests an hour and does
-- not grow with the number of repositories. Exhausting it paused five queued auto-create actions for
-- 95 minutes, and attributing the burn was guesswork: every stage already counts its own calls, but
-- the count only ever reached the platform log, which is sampled and expires. Storing it next to the
-- stage counts makes the question answerable in SQL.

ALTER TABLE reconciliation_runs
  ADD COLUMN IF NOT EXISTS github_calls integer,
  ADD COLUMN IF NOT EXISTS github_ms integer;
