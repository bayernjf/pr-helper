-- Public deployments are produced by GitHub Actions after a PR merge.
-- Keep the provider-specific run and GitHub Environment URL beside the
-- workflow stage so the board can show Vercel and Cloudflare independently.
CREATE TABLE IF NOT EXISTS workflow_stage_deployments (
  user_id uuid NOT NULL,
  workflow_id text NOT NULL,
  stage_index integer NOT NULL,
  source text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('vercel', 'cloudflare')),
  environment text NOT NULL CHECK (environment IN ('preview', 'production')),
  run_id bigint,
  run_name text NOT NULL,
  run_url text,
  deployment_url text,
  state text NOT NULL CHECK (state IN ('pending', 'success', 'failure')),
  conclusion text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workflow_id, stage_index, source, provider),
  FOREIGN KEY (user_id, workflow_id, stage_index, source)
    REFERENCES workflow_stage_states(user_id, workflow_id, stage_index, source)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workflow_stage_deployments_updated_at_idx
  ON workflow_stage_deployments (updated_at DESC);
