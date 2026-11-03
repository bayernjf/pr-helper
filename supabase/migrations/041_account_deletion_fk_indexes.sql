-- =====================================================
-- Migration 041: Index RESTRICT foreign keys for account deletion
-- File: 041_account_deletion_fk_indexes.sql
-- Date: 2026-11-03 14:00
-- Depends on: 023_team_permissions.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: deleteAccount now removes a user's team shares and owned
--       teams inside one transaction before deleting the user row
--       (023's created_by/shared_by FKs are ON DELETE RESTRICT).
--       Those two FK columns had no index, so every account
--       deletion scanned pr_helper_teams / pr_helper_team_workflows
--       in full. Add covering indexes; no data change.
-- -----------------------------------------------------

CREATE INDEX IF NOT EXISTS pr_helper_teams_created_by_idx
  ON pr_helper_teams (created_by);

CREATE INDEX IF NOT EXISTS pr_helper_team_workflows_shared_by_idx
  ON pr_helper_team_workflows (shared_by);
