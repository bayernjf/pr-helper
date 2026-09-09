-- =====================================================
-- Migration 002: Normalize legacy JSON-string workflow payloads
-- File: 002_normalize_workflow_payloads.sql
-- Date: 2026-07-27 04:18
-- Depends on: 001_users_and_workflows.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Converts payloads written by the initial Postgres.js
--       integration from JSON strings into JSON objects. New writes
--       use sql.json(workflow) and no longer need this conversion.
-- -----------------------------------------------------

-- Convert payloads written by the initial Postgres.js integration from JSON strings
-- into JSON objects. New writes use sql.json(workflow) and do not need this conversion.
UPDATE pr_helper_workflows
SET payload = (payload #>> '{}')::jsonb
WHERE jsonb_typeof(payload) = 'string';
