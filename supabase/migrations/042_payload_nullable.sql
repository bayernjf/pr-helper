-- =====================================================
-- Migration 042: Allow pr_helper_workflows.payload to be null
-- File: 042_payload_nullable.sql
-- Date: 2026-10-30
-- Depends on: 036_workflow_relational_expand.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Step C of the payload-column drop. Step B removed the last read
--       site, so the server no longer needs payload to be present at insert
--       time. Step D (same series) stops writing it and tightens version to
--       NOT NULL. Reversible: ALTER COLUMN payload SET NOT NULL.
-- -----------------------------------------------------

ALTER TABLE pr_helper_workflows
  ALTER COLUMN payload DROP NOT NULL;
