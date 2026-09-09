-- =====================================================
-- Migration 004: Add per-stage workflow state table
-- File: 004_workflow_stage_states.sql
-- Date: 2026-07-27 12:14
-- Depends on: 001_users_and_workflows.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: workflow_stage_states tracks the live state of each pipeline
--       stage (source/target branches, pull request status) per user
--       and workflow, cascading from pr_helper_workflows.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS workflow_stage_states (
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  workflow_id text NOT NULL,
  stage_index integer NOT NULL,
  repository text NOT NULL,
  source text NOT NULL,
  target text NOT NULL,
  pull_number integer,
  pull_state text NOT NULL DEFAULT 'none',
  merged_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workflow_id, stage_index),
  FOREIGN KEY (user_id, workflow_id) REFERENCES pr_helper_workflows(user_id, id) ON DELETE CASCADE
);
