CREATE TABLE IF NOT EXISTS workflow_versions (
  user_id uuid NOT NULL,
  workflow_id text NOT NULL,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workflow_id, version),
  FOREIGN KEY (user_id, workflow_id)
    REFERENCES pr_helper_workflows(user_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  workflow_id text NOT NULL,
  version integer NOT NULL,
  stage_index integer NOT NULL,
  source text NOT NULL,
  target text NOT NULL,
  stage_snapshot jsonb NOT NULL,
  pull_number integer,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'completed', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (user_id, workflow_id)
    REFERENCES pr_helper_workflows(user_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_runs_active_idx
  ON workflow_runs (user_id, workflow_id, state)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS workflow_runs_recent_idx
  ON workflow_runs (user_id, workflow_id, started_at DESC);
