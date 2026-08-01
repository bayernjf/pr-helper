-- 016: Encrypted cloud sync for local-only data (generation rules, PR drafts).
-- The server stores only opaque encrypted blobs; it cannot decrypt user data.

CREATE TABLE IF NOT EXISTS pr_helper_encrypted_sync (
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT 'default',
  ciphertext text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope)
);
