-- PR Helper user-scoped workflow storage. Run once against the DATABASE_URL database.
CREATE TABLE IF NOT EXISTS pr_helper_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_login text NOT NULL UNIQUE,
  github_user_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pr_helper_workflows (
  id text NOT NULL,
  user_id uuid NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
