-- =====================================================
-- Migration 046: Allow workflow_versions.snapshot to be null
-- File: 046_workflow_versions_snapshot_nullable.sql
-- Date: 2026-11-11
-- Depends on: 040 (code stopped writing snapshot; this aligns the schema)
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Since the 2026-10-30 deploy, saveWorkflowVersion inserts version
--       rows as (user_id, workflow_id, version) without a snapshot — 040
--       stopped writing snapshots and no reader remains. The column,
--       however, was still NOT NULL without a default, so every cloud
--       workflow save since that deploy failed with 23502 and the UI
--       silently fell back to browser-local persistence ("已保存在当前
--       浏览器"). Surfaced on 2026-11-10 by the first save of a
--       SQL-created flow. Historical rows keep their snapshots; new rows
--       store NULL. No reader is affected (040 verified zero readers).
ALTER TABLE workflow_versions
  ALTER COLUMN snapshot DROP NOT NULL;
