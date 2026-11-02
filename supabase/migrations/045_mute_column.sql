-- =====================================================
-- Migration 045: Add pr_helper_workflows.muted
-- File: 045_mute_column.sql
-- Date: 2026-10-31
-- Depends on: 036_workflow_relational_expand.sql (same table; same shape as `archived`)
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Workflow mute, v1 (design: docs/superpowers/plans/2026-10-31-workflow-mute.md,
--       decisions approved 2026-10-31). A muted workflow keeps reconciling, projecting
--       and automating exactly as before; the only silenced channel is Web Push — the
--       phase('notify') sites in reconcileStageWork skip it. No partial index needed:
--       `muted` never appears in a WHERE/JOIN, it is only read off rows the sweep has
--       already fetched (trackedWorkflowColumns).
ALTER TABLE pr_helper_workflows
  ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false;
