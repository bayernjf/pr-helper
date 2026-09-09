-- =====================================================
-- Migration 006: Add push notification subscriptions and deliveries
-- File: 006_push_notifications.sql
-- Date: 2026-07-27 17:16
-- Depends on: 001_users_and_workflows.sql
-- Run: Supabase SQL Editor, execute once
-- =====================================================
-- Note: Stores Web Push subscriptions per user and deduplicated
--       notification deliveries keyed by (user_id, event_key) so the
--       same event cannot be delivered twice.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS pr_helper_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  subscription jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pr_helper_push_subscriptions_user_id_idx
  ON pr_helper_push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS pr_helper_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_key)
);
