-- =====================================================
-- Migration 021: Version encrypted sync with key and recovery metadata
-- File: 021_encrypted_sync_hardening.sql
-- Date: 2026-08-03 06:49
-- Depends on: 016_encrypted_cloud_sync.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Adds revision/key/device metadata to encrypted sync and a
--       recovery history table. Ciphertexts stay opaque to the server;
--       metadata only supports conflict handling and retention.
-- -----------------------------------------------------

-- 021: Versioned encrypted sync with non-secret key/device metadata and recovery history.
-- Ciphertexts remain opaque to the server; metadata only supports conflict handling and retention.

ALTER TABLE pr_helper_encrypted_sync
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN IF NOT EXISTS key_id TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS device_id TEXT;

CREATE TABLE IF NOT EXISTS pr_helper_encrypted_sync_history (
  user_id UUID NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  device_id TEXT,
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, revision)
);

CREATE INDEX IF NOT EXISTS pr_helper_encrypted_sync_history_recent_idx
  ON pr_helper_encrypted_sync_history (user_id, scope, replaced_at DESC);
