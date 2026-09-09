-- =====================================================
-- Migration 026: Add server-side AI automation preferences
-- File: 026_ai_automation_preferences.sql
-- Date: 2026-08-12 10:48
-- Depends on: 024_ai_automation_credentials.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Server-side automation prerequisites (auto-generate PR message,
--       auto-confirm PR creation), separate from browser session AI
--       settings.
-- -----------------------------------------------------

-- 026: Server-side automation prerequisites, separate from browser session AI settings.
ALTER TABLE pr_helper_ai_automation_credentials
  ADD COLUMN IF NOT EXISTS auto_generate_pr_message BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_confirm_pr_creation BOOLEAN NOT NULL DEFAULT false;
