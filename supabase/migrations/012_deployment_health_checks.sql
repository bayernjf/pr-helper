-- =====================================================
-- Migration 012: Add deployment health check columns
-- File: 012_deployment_health_checks.sql
-- Date: 2026-07-30 03:42
-- Depends on: 010_track_stage_deployments.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Tracks post-deployment health probing state, URL and detail on
--       each deployment so success is verified after the run ends.
-- -----------------------------------------------------

ALTER TABLE workflow_stage_deployments
  ADD COLUMN IF NOT EXISTS health_state text CHECK (health_state IN ('pending', 'success', 'failure')),
  ADD COLUMN IF NOT EXISTS health_url text,
  ADD COLUMN IF NOT EXISTS health_detail text;
