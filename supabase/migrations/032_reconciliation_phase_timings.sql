-- =====================================================
-- Migration 032: Record reconciliation phase timings
-- File: 032_reconciliation_phase_timings.sql
-- Date: 2026-08-19 23:39
-- Depends on: 031_reconciliation_claimed_workflows.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: One jsonb column keeps per-phase millisecond sums so 'where did
--       the time go' is answerable in SQL. Like github_ms, values are
--       sums across concurrently reconciled stages, not wall clock.
-- -----------------------------------------------------

-- 032: Record which phase of a reconciliation sweep consumed its wall clock.
-- Run after 031.
-- 029 stored what a sweep spent against the GitHub quota, which answered "how many calls" but not
-- "where did the time go". The gap now decides a design question: webhook sweeps that yield spend
-- 27 of their 29.7 seconds outside GitHub, so an ETag pass cannot be what fixes them, and the phase
-- breakdown that would name the real culprit only ever reached the platform log, which is sampled
-- and expires. One jsonb column keeps every phase without a migration each time the set changes.
-- Like github_ms, the values are sums across concurrently reconciled stages, not wall clock.

ALTER TABLE reconciliation_runs
  ADD COLUMN IF NOT EXISTS phase_ms jsonb;
