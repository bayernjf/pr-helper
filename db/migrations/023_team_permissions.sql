-- 023: Team membership and workflow sharing. Existing workflows remain personal until explicitly shared.

CREATE TABLE IF NOT EXISTS pr_helper_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_by UUID NOT NULL REFERENCES pr_helper_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pr_helper_team_members (
  team_id UUID NOT NULL REFERENCES pr_helper_teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES pr_helper_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'operator', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS pr_helper_team_workflows (
  team_id UUID NOT NULL REFERENCES pr_helper_teams(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL,
  workflow_id TEXT NOT NULL,
  shared_by UUID NOT NULL REFERENCES pr_helper_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, owner_user_id, workflow_id),
  FOREIGN KEY (owner_user_id, workflow_id)
    REFERENCES pr_helper_workflows(user_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS pr_helper_team_members_user_idx
  ON pr_helper_team_members (user_id, team_id);

CREATE INDEX IF NOT EXISTS pr_helper_team_workflows_workflow_idx
  ON pr_helper_team_workflows (owner_user_id, workflow_id);
