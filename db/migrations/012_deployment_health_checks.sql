ALTER TABLE workflow_stage_deployments
  ADD COLUMN IF NOT EXISTS health_state text CHECK (health_state IN ('pending', 'success', 'failure')),
  ADD COLUMN IF NOT EXISTS health_url text,
  ADD COLUMN IF NOT EXISTS health_detail text;
