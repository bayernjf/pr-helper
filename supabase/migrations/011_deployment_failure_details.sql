-- =====================================================
-- Migration 011: Add deployment failure summary fields
-- File: 011_deployment_failure_details.sql
-- Date: 2026-07-30 03:20
-- Depends on: 010_track_stage_deployments.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Captures a human-readable failure summary and the failing job
--       URL so deployment failures can be diagnosed from the board.
-- -----------------------------------------------------

ALTER TABLE workflow_stage_deployments
  ADD COLUMN IF NOT EXISTS failure_summary text,
  ADD COLUMN IF NOT EXISTS failure_job_url text;
