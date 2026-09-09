-- =====================================================
-- Migration 016: Add encrypted cloud sync for local-only data
-- File: 016_encrypted_cloud_sync.sql
-- Date: 2026-07-31 15:58
-- Depends on: 001_users_and_workflows.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Encrypted cloud sync for local-only data (generation rules,
--       PR drafts). The server stores only opaque encrypted blobs and
--       cannot decrypt user data.
-- -----------------------------------------------------

-- 016: Encrypted cloud sync for local-only data (generation rules, PR drafts).
-- The server stores only opaque encrypted blobs; it cannot decrypt user data.

CREATE TABLE IF NOT EXISTS pr_helper_encrypted_sync (
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'default',
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);
