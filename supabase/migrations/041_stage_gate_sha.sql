-- =====================================================
-- Migration 041: Track the sha a stage gate evaluated
-- File: 041_stage_gate_sha.sql
-- Date: 2026-10-30
-- Depends on: 036_workflow_relational_expand.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: A merged step's checks are evaluated against the target branch head, not the merge
--       commit (a check that went red on the merge commit stays red forever even after the
--       branch recovered, and parking the verdict on it permanently blocks auto-create).
--       gate_sha records which sha that verdict was pinned to. head_sha keeps its existing
--       meaning (the merged commit / PR head) for the retry and deployment-parent readers.
--       Reversible: a plain ADD COLUMN; historical rows stay NULL, which the server treats
--       as "no gate sha recorded" and re-evaluates on the next sweep.
-- -----------------------------------------------------

ALTER TABLE workflow_stage_states
  ADD COLUMN gate_sha text;
