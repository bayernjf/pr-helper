-- =====================================================
-- Migration 043: Tighten pr_helper_workflows.version to NOT NULL
-- File: 043_version_not_null.sql
-- Date: 2026-10-30
-- Depends on: 042_payload_nullable.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Step D of the payload-column drop. 036 had to leave version
--       nullable because historical rows had no value to backfill; every
--       row written since then carries a version, so the column can be
--       tightened. The value lands in the same step that first hand-writes
--       the full insert column list — the one moment a missing version would
--       otherwise silently degrade to NULL. Reversible: DROP NOT NULL.
-- -----------------------------------------------------

ALTER TABLE pr_helper_workflows
  ALTER COLUMN version SET NOT NULL;
