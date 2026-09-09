-- =====================================================
-- Migration 007: Track commits ahead of the merged base on a stage
-- File: 007_track_stage_ahead_by.sql
-- Date: 2026-07-28 19:29
-- Depends on: 004_workflow_stage_states.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Lets the server-side queue distinguish a previously merged PR
--       from a branch that has new commits and is ready for another
--       PR.
-- -----------------------------------------------------

-- Lets the server-side queue distinguish a previously merged PR from a branch
-- that has new commits and is ready for another PR.
ALTER TABLE workflow_stage_states
  ADD COLUMN IF NOT EXISTS ahead_by integer NOT NULL DEFAULT 0;
