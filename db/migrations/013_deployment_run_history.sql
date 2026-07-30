CREATE TABLE IF NOT EXISTS workflow_stage_deployment_runs (
  user_id uuid NOT NULL,
  workflow_id text NOT NULL,
  stage_index integer NOT NULL,
  source text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('vercel', 'cloudflare')),
  run_id bigint NOT NULL,
  environment text NOT NULL CHECK (environment IN ('preview', 'production')),
  run_name text NOT NULL,
  run_url text,
  deployment_url text,
  state text NOT NULL CHECK (state IN ('pending', 'success', 'failure')),
  conclusion text,
  health_state text CHECK (health_state IN ('pending', 'success', 'failure')),
  health_url text,
  health_detail text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workflow_id, stage_index, source, provider, run_id),
  FOREIGN KEY (user_id, workflow_id, stage_index, source)
    REFERENCES workflow_stage_states(user_id, workflow_id, stage_index, source)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_stage_deployment_runs_recent_idx
  ON workflow_stage_deployment_runs (user_id, workflow_id, stage_index, source, updated_at DESC);
