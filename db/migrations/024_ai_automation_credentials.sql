-- 024: Encrypted AI credentials for future unattended workflow execution.
-- The application stores ciphertext only; the encryption key remains in Vercel env.
CREATE TABLE IF NOT EXISTS pr_helper_ai_automation_credentials (
  user_id UUID PRIMARY KEY REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  key_version TEXT NOT NULL,
  key_hint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
